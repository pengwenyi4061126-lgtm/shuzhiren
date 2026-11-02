import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type RuntimeTelemetry = { runId: string; tenantId: string; sampledAt: string; outputConnected: boolean; inferenceFps: number; outputFps: number; avSyncMs: number; bitrateMbps: number; gpuUtilization: number; gpuMemoryMiB: number; audioActive: boolean; fallbackReady: boolean };
export type RuntimeTelemetryInput = Omit<RuntimeTelemetry, "tenantId" | "sampledAt"> & { sampledAt?: string };
export type RuntimeAlert = { id: string; tenantId: string; runId: string; severity: "warning" | "critical"; code: string; message: string; status: "open" | "resolved"; openedAt: string; resolvedAt?: string; acknowledgedAt?: string; acknowledgedBy?: string };
export type RuntimeSamplingSlo = { runId: string; windowMinutes: number; objective: number; sampleCount: number; healthySamples: number; healthRate: number | null; status: "met" | "breached" | "insufficient"; detail: string };
const maxTelemetryAgeMs = 60_000;
const samplingSloWindowMinutes = 15;
const samplingSloObjective = 0.95;
const samplingSloMinimumSamples = 3;
const telemetryAlertCodes = new Set(["output_disconnected", "output_fps_low", "av_sync_high", "bitrate_low", "audio_silence", "fallback_not_ready"]);

type MonitoringStore = { telemetry: Map<string, RuntimeTelemetry>; alerts: Map<string, RuntimeAlert> };
type AlertCondition = Pick<RuntimeAlert, "severity" | "code" | "message">;
type PersistentTelemetryRow = { tenant_id: string; live_run_id: string; sampled_at: Date | string; output_connected: boolean; inference_fps: number | string; output_fps: number | string; av_sync_ms: number; bitrate_mbps: number | string; gpu_utilization: number; gpu_memory_mib: number; audio_active: boolean; fallback_ready: boolean };
type PersistentAlertRow = { id: string; tenant_id: string; live_run_id: string; severity: RuntimeAlert["severity"]; code: string; message: string; status: RuntimeAlert["status"]; opened_at: Date | string; resolved_at: Date | string | null; acknowledged_at: Date | string | null; acknowledged_by_name: string | null };

declare global { var shuzhirenMonitoringStore: MonitoringStore | undefined; }

function monitoringStore(): MonitoringStore {
  globalThis.shuzhirenMonitoringStore ??= { telemetry: new Map([["run_20261101_001", { runId: "run_20261101_001", tenantId: "tenant_demo", sampledAt: "2026-11-01T14:40:00.000Z", outputConnected: true, inferenceFps: 31.8, outputFps: 25, avSyncMs: 31, bitrateMbps: 4.2, gpuUtilization: 72, gpuMemoryMiB: 14820, audioActive: true, fallbackReady: true }]]), alerts: new Map() };
  return globalThis.shuzhirenMonitoringStore;
}

export async function getTelemetry(context: RequestContext, runId: string) {
  if (!databasePool()) {
    const telemetry = monitoringStore().telemetry.get(runId);
    return telemetry?.tenantId === context.tenantId ? telemetry : null;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentTelemetryRow>(`select tenant_id, live_run_id, sampled_at, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, audio_active, fallback_ready from runtime_health_samples where live_run_id = $1 order by sampled_at desc limit 1`, [runId]);
    return result.rows[0] ? persistentTelemetry(result.rows[0]) : null;
  });
}

export async function getRuntimeSamplingSlo(context: RequestContext, runId: string): Promise<RuntimeSamplingSlo> {
  if (!databasePool()) {
    const telemetry = await getTelemetry(context, runId);
    return summarizeRuntimeSamplingSlo(runId, telemetry ? [telemetry] : []);
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentTelemetryRow>(`select tenant_id, live_run_id, sampled_at, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, audio_active, fallback_ready from runtime_health_samples where live_run_id = $1 and sampled_at >= now() - ($2::text || ' minutes')::interval order by sampled_at asc limit 2000`, [runId, samplingSloWindowMinutes]);
    return summarizeRuntimeSamplingSlo(runId, result.rows.map(persistentTelemetry));
  });
}

export async function listAlerts(context: RequestContext, runId?: string) {
  if (!databasePool()) return [...monitoringStore().alerts.values()].filter((alert) => alert.tenantId === context.tenantId && (!runId || alert.runId === runId)).sort((left, right) => right.openedAt.localeCompare(left.openedAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAlertRow>(`select a.id, a.tenant_id, a.live_run_id, a.severity, a.code, a.message, a.status, a.opened_at, a.resolved_at, a.acknowledged_at, u.display_name as acknowledged_by_name from runtime_alerts a left join users u on u.id = a.acknowledged_by where ($1::uuid is null or a.live_run_id = $1) order by a.opened_at desc limit 500`, [runId ?? null]);
    return result.rows.map(persistentAlert);
  });
}

export async function ingestTelemetry(context: RequestContext, input: RuntimeTelemetryInput) {
  const sampledAt = input.sampledAt && !Number.isNaN(Date.parse(input.sampledAt)) ? input.sampledAt : new Date().toISOString();
  const telemetry: RuntimeTelemetry = { ...input, tenantId: context.tenantId, sampledAt };
  if (!databasePool()) {
    const state = monitoringStore();
    state.telemetry.set(telemetry.runId, telemetry);
    return { telemetry, alerts: reconcileDemoAlerts(state, telemetry) };
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    await client.query(`insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, audio_active, fallback_ready, sampled_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [context.tenantId, telemetry.runId, telemetry.outputConnected, telemetry.inferenceFps, telemetry.outputFps, telemetry.avSyncMs, telemetry.bitrateMbps, telemetry.gpuUtilization, telemetry.gpuMemoryMiB, telemetry.audioActive, telemetry.fallbackReady, telemetry.sampledAt]);
    const existing = await client.query<PersistentAlertRow>(`select id, tenant_id, live_run_id, severity, code, message, status, opened_at, resolved_at, acknowledged_at, null::text as acknowledged_by_name from runtime_alerts where live_run_id = $1 for update`, [telemetry.runId]);
    const active = new Map(alertConditions(telemetry).map((condition) => [condition.code, condition]));
    const changed: RuntimeAlert[] = [];
    for (const alert of existing.rows) {
      if (alert.status === "open" && isTelemetryAlertCode(alert.code) && !active.has(alert.code)) {
        const resolved = await client.query<PersistentAlertRow>(`update runtime_alerts set status = 'resolved', resolved_at = $2 where id = $1 returning id, tenant_id, live_run_id, severity, code, message, status, opened_at, resolved_at, acknowledged_at, null::text as acknowledged_by_name`, [alert.id, telemetry.sampledAt]);
        changed.push(persistentAlert(resolved.rows[0]));
      }
    }
    for (const condition of active.values()) {
      if (existing.rows.some((alert) => alert.code === condition.code && alert.status === "open")) continue;
      const opened = await client.query<PersistentAlertRow>(`insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status, opened_at) values ($1, $2, $3, $4, $5, 'open', $6) on conflict (tenant_id, live_run_id, code) where (status = 'open') do nothing returning id, tenant_id, live_run_id, severity, code, message, status, opened_at, resolved_at, acknowledged_at, null::text as acknowledged_by_name`, [context.tenantId, telemetry.runId, condition.severity, condition.code, condition.message, telemetry.sampledAt]);
      if (opened.rows[0]) changed.push(persistentAlert(opened.rows[0]));
    }
    return { telemetry, alerts: changed };
  });
}

export async function acknowledgeAlert(context: RequestContext, alertId: string) {
  if (!databasePool()) {
    const alert = monitoringStore().alerts.get(alertId);
    if (!alert || alert.tenantId !== context.tenantId) throw new Response("Runtime alert not found", { status: 404 });
    if (alert.status !== "open") throw new Response("Resolved alerts cannot be acknowledged", { status: 409 });
    if (alert.acknowledgedAt) return { alert, duplicate: true as const };
    const acknowledged = { ...alert, acknowledgedAt: new Date().toISOString(), acknowledgedBy: context.actorName };
    monitoringStore().alerts.set(alertId, acknowledged);
    return { alert: acknowledged, duplicate: false as const };
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const existing = await client.query<PersistentAlertRow>(`select a.id, a.tenant_id, a.live_run_id, a.severity, a.code, a.message, a.status, a.opened_at, a.resolved_at, a.acknowledged_at, u.display_name as acknowledged_by_name from runtime_alerts a left join users u on u.id = a.acknowledged_by where a.id = $1 for update of a`, [alertId]);
    if (!existing.rows[0]) throw new Response("Runtime alert not found", { status: 404 });
    const current = persistentAlert(existing.rows[0]);
    if (current.status !== "open") throw new Response("Resolved alerts cannot be acknowledged", { status: 409 });
    if (current.acknowledgedAt) return { alert: current, duplicate: true as const };
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const updated = await client.query<PersistentAlertRow>(`update runtime_alerts set acknowledged_at = now(), acknowledged_by = $2 where id = $1 returning id, tenant_id, live_run_id, severity, code, message, status, opened_at, resolved_at, acknowledged_at, $3::text as acknowledged_by_name`, [alertId, actor.rows[0].id, context.actorName]);
    return { alert: persistentAlert(updated.rows[0]), duplicate: false as const };
  });
}

function reconcileDemoAlerts(state: MonitoringStore, telemetry: RuntimeTelemetry) {
  const active = new Map(alertConditions(telemetry).map((condition) => [condition.code, condition]));
  const matching = [...state.alerts.values()].filter((alert) => alert.tenantId === telemetry.tenantId && alert.runId === telemetry.runId);
  const changed: RuntimeAlert[] = [];
  for (const alert of matching) if (alert.status === "open" && isTelemetryAlertCode(alert.code) && !active.has(alert.code)) { const resolved = { ...alert, status: "resolved" as const, resolvedAt: telemetry.sampledAt }; state.alerts.set(resolved.id, resolved); changed.push(resolved); }
  for (const condition of active.values()) if (!matching.some((alert) => alert.code === condition.code && alert.status === "open")) { const alert: RuntimeAlert = { id: `alert_${crypto.randomUUID()}`, tenantId: telemetry.tenantId, runId: telemetry.runId, status: "open", openedAt: telemetry.sampledAt, ...condition }; state.alerts.set(alert.id, alert); changed.push(alert); }
  return changed;
}

function alertConditions(telemetry: RuntimeTelemetry): AlertCondition[] {
  const conditions: AlertCondition[] = [];
  if (!telemetry.outputConnected) conditions.push({ severity: "critical", code: "output_disconnected", message: "推流连接已断开" });
  if (telemetry.outputFps < 24) conditions.push({ severity: "critical", code: "output_fps_low", message: `输出帧率过低：${telemetry.outputFps} FPS` });
  if (telemetry.avSyncMs > 120) conditions.push({ severity: "warning", code: "av_sync_high", message: `音画同步超阈值：${telemetry.avSyncMs} ms` });
  if (telemetry.bitrateMbps < 2) conditions.push({ severity: "warning", code: "bitrate_low", message: `输出码率过低：${telemetry.bitrateMbps} Mbps` });
  if (!telemetry.audioActive) conditions.push({ severity: "critical", code: "audio_silence", message: "输出音频静音或无法确认活动音频" });
  if (!telemetry.fallbackReady) conditions.push({ severity: "critical", code: "fallback_not_ready", message: "备用节目未就绪" });
  return conditions;
}

function isTelemetryAlertCode(code: string) { return telemetryAlertCodes.has(code); }

function summarizeRuntimeSamplingSlo(runId: string, samples: RuntimeTelemetry[]): RuntimeSamplingSlo {
  const healthySamples = samples.filter(isHealthyTelemetry).length;
  if (samples.length < samplingSloMinimumSamples) return { runId, windowMinutes: samplingSloWindowMinutes, objective: samplingSloObjective, sampleCount: samples.length, healthySamples, healthRate: null, status: "insufficient", detail: `最近 ${samplingSloWindowMinutes} 分钟仅有 ${samples.length} 个样本，至少需要 ${samplingSloMinimumSamples} 个样本才可评估` };
  const healthRate = healthySamples / samples.length;
  if (healthRate >= samplingSloObjective) return { runId, windowMinutes: samplingSloWindowMinutes, objective: samplingSloObjective, sampleCount: samples.length, healthySamples, healthRate, status: "met", detail: `健康样本 ${healthySamples}/${samples.length}，达到 ${(samplingSloObjective * 100).toFixed(0)}% 采样质量目标` };
  return { runId, windowMinutes: samplingSloWindowMinutes, objective: samplingSloObjective, sampleCount: samples.length, healthySamples, healthRate, status: "breached", detail: `健康样本 ${healthySamples}/${samples.length}，低于 ${(samplingSloObjective * 100).toFixed(0)}% 采样质量目标` };
}

function isHealthyTelemetry(telemetry: RuntimeTelemetry) { return alertConditions(telemetry).length === 0; }

export function requiresRuntimeIntervention(telemetry: RuntimeTelemetry) {
  return alertConditions(telemetry).some((condition) => condition.severity === "critical");
}

export async function evaluateRuntimeReadiness(context: RequestContext, runId: string) {
  const telemetry = await getTelemetry(context, runId);
  if (!telemetry) return { passed: false, detail: "没有运行时遥测数据" };
  const telemetryAgeMs = Date.now() - new Date(telemetry.sampledAt).getTime();
  if (!Number.isFinite(telemetryAgeMs) || telemetryAgeMs > maxTelemetryAgeMs) return { passed: false, detail: `运行时遥测已过期：${telemetry.sampledAt}` };
  if (telemetryAgeMs < -5_000) return { passed: false, detail: "运行时遥测时间异常" };
  if (!telemetry.outputConnected) return { passed: false, detail: "推流连接未建立" };
  if (telemetry.outputFps < 24) return { passed: false, detail: `输出帧率过低：${telemetry.outputFps} FPS` };
  if (telemetry.avSyncMs > 120) return { passed: false, detail: `音画同步超阈值：${telemetry.avSyncMs} ms` };
  if (telemetry.bitrateMbps < 2) return { passed: false, detail: `输出码率过低：${telemetry.bitrateMbps} Mbps` };
  if (!telemetry.audioActive) return { passed: false, detail: "输出音频静音或无法确认活动音频" };
  if (!telemetry.fallbackReady) return { passed: false, detail: "备用节目未就绪" };
  return { passed: true, detail: `输出 ${telemetry.outputFps} FPS · 音画同步 ${telemetry.avSyncMs} ms · ${telemetry.bitrateMbps} Mbps · 音频活动` };
}

function persistentTelemetry(row: PersistentTelemetryRow): RuntimeTelemetry { return { runId: row.live_run_id, tenantId: row.tenant_id, sampledAt: new Date(row.sampled_at).toISOString(), outputConnected: row.output_connected, inferenceFps: Number(row.inference_fps), outputFps: Number(row.output_fps), avSyncMs: Number(row.av_sync_ms), bitrateMbps: Number(row.bitrate_mbps), gpuUtilization: Number(row.gpu_utilization), gpuMemoryMiB: Number(row.gpu_memory_mib), audioActive: row.audio_active, fallbackReady: row.fallback_ready }; }
function persistentAlert(row: PersistentAlertRow): RuntimeAlert { return { id: row.id, tenantId: row.tenant_id, runId: row.live_run_id, severity: row.severity, code: row.code, message: row.message, status: row.status, openedAt: new Date(row.opened_at).toISOString(), resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined, acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : undefined, acknowledgedBy: row.acknowledged_by_name ?? undefined }; }
