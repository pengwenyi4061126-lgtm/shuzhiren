import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type RuntimeTelemetry = { runId: string; tenantId: string; sampledAt: string; outputConnected: boolean; inferenceFps: number; outputFps: number; avSyncMs: number; bitrateMbps: number; gpuUtilization: number; gpuMemoryMiB: number; fallbackReady: boolean };
export type RuntimeTelemetryInput = Omit<RuntimeTelemetry, "tenantId" | "sampledAt"> & { sampledAt?: string };
export type RuntimeAlert = { id: string; tenantId: string; runId: string; severity: "warning" | "critical"; code: string; message: string; status: "open" | "resolved"; openedAt: string; resolvedAt?: string };
const maxTelemetryAgeMs = 60_000;

type MonitoringStore = { telemetry: Map<string, RuntimeTelemetry>; alerts: Map<string, RuntimeAlert> };
type AlertCondition = Pick<RuntimeAlert, "severity" | "code" | "message">;
type PersistentTelemetryRow = { tenant_id: string; live_run_id: string; sampled_at: Date | string; output_connected: boolean; inference_fps: number | string; output_fps: number | string; av_sync_ms: number; bitrate_mbps: number | string; gpu_utilization: number; gpu_memory_mib: number; fallback_ready: boolean };
type PersistentAlertRow = { id: string; tenant_id: string; live_run_id: string; severity: RuntimeAlert["severity"]; code: string; message: string; status: RuntimeAlert["status"]; opened_at: Date | string; resolved_at: Date | string | null };

declare global { var shuzhirenMonitoringStore: MonitoringStore | undefined; }

function monitoringStore(): MonitoringStore {
  globalThis.shuzhirenMonitoringStore ??= { telemetry: new Map([["run_20261101_001", { runId: "run_20261101_001", tenantId: "tenant_demo", sampledAt: "2026-11-01T14:40:00.000Z", outputConnected: true, inferenceFps: 31.8, outputFps: 25, avSyncMs: 31, bitrateMbps: 4.2, gpuUtilization: 72, gpuMemoryMiB: 14820, fallbackReady: true }]]), alerts: new Map() };
  return globalThis.shuzhirenMonitoringStore;
}

export async function getTelemetry(context: RequestContext, runId: string) {
  if (!databasePool()) {
    const telemetry = monitoringStore().telemetry.get(runId);
    return telemetry?.tenantId === context.tenantId ? telemetry : null;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentTelemetryRow>(`select tenant_id, live_run_id, sampled_at, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, fallback_ready from runtime_health_samples where live_run_id = $1 order by sampled_at desc limit 1`, [runId]);
    return result.rows[0] ? persistentTelemetry(result.rows[0]) : null;
  });
}

export async function listAlerts(context: RequestContext, runId?: string) {
  if (!databasePool()) return [...monitoringStore().alerts.values()].filter((alert) => alert.tenantId === context.tenantId && (!runId || alert.runId === runId)).sort((left, right) => right.openedAt.localeCompare(left.openedAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAlertRow>(`select id, tenant_id, live_run_id, severity, code, message, status, opened_at, resolved_at from runtime_alerts where ($1::uuid is null or live_run_id = $1) order by opened_at desc limit 500`, [runId ?? null]);
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
    await client.query(`insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, fallback_ready, sampled_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [context.tenantId, telemetry.runId, telemetry.outputConnected, telemetry.inferenceFps, telemetry.outputFps, telemetry.avSyncMs, telemetry.bitrateMbps, telemetry.gpuUtilization, telemetry.gpuMemoryMiB, telemetry.fallbackReady, telemetry.sampledAt]);
    const existing = await client.query<PersistentAlertRow>(`select id, tenant_id, live_run_id, severity, code, message, status, opened_at, resolved_at from runtime_alerts where live_run_id = $1 for update`, [telemetry.runId]);
    const active = new Map(alertConditions(telemetry).map((condition) => [condition.code, condition]));
    const changed: RuntimeAlert[] = [];
    for (const alert of existing.rows) {
      if (alert.status === "open" && !active.has(alert.code)) {
        const resolved = await client.query<PersistentAlertRow>(`update runtime_alerts set status = 'resolved', resolved_at = $2 where id = $1 returning id, tenant_id, live_run_id, severity, code, message, status, opened_at, resolved_at`, [alert.id, telemetry.sampledAt]);
        changed.push(persistentAlert(resolved.rows[0]));
      }
    }
    for (const condition of active.values()) {
      if (existing.rows.some((alert) => alert.code === condition.code && alert.status === "open")) continue;
      const opened = await client.query<PersistentAlertRow>(`insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status, opened_at) values ($1, $2, $3, $4, $5, 'open', $6) returning id, tenant_id, live_run_id, severity, code, message, status, opened_at, resolved_at`, [context.tenantId, telemetry.runId, condition.severity, condition.code, condition.message, telemetry.sampledAt]);
      changed.push(persistentAlert(opened.rows[0]));
    }
    return { telemetry, alerts: changed };
  });
}

function reconcileDemoAlerts(state: MonitoringStore, telemetry: RuntimeTelemetry) {
  const active = new Map(alertConditions(telemetry).map((condition) => [condition.code, condition]));
  const matching = [...state.alerts.values()].filter((alert) => alert.tenantId === telemetry.tenantId && alert.runId === telemetry.runId);
  const changed: RuntimeAlert[] = [];
  for (const alert of matching) if (alert.status === "open" && !active.has(alert.code)) { const resolved = { ...alert, status: "resolved" as const, resolvedAt: telemetry.sampledAt }; state.alerts.set(resolved.id, resolved); changed.push(resolved); }
  for (const condition of active.values()) if (!matching.some((alert) => alert.code === condition.code && alert.status === "open")) { const alert: RuntimeAlert = { id: `alert_${crypto.randomUUID()}`, tenantId: telemetry.tenantId, runId: telemetry.runId, status: "open", openedAt: telemetry.sampledAt, ...condition }; state.alerts.set(alert.id, alert); changed.push(alert); }
  return changed;
}

function alertConditions(telemetry: RuntimeTelemetry): AlertCondition[] {
  const conditions: AlertCondition[] = [];
  if (!telemetry.outputConnected) conditions.push({ severity: "critical", code: "output_disconnected", message: "推流连接已断开" });
  if (telemetry.outputFps < 24) conditions.push({ severity: "critical", code: "output_fps_low", message: `输出帧率过低：${telemetry.outputFps} FPS` });
  if (telemetry.avSyncMs > 120) conditions.push({ severity: "warning", code: "av_sync_high", message: `音画同步超阈值：${telemetry.avSyncMs} ms` });
  if (telemetry.bitrateMbps < 2) conditions.push({ severity: "warning", code: "bitrate_low", message: `输出码率过低：${telemetry.bitrateMbps} Mbps` });
  if (!telemetry.fallbackReady) conditions.push({ severity: "critical", code: "fallback_not_ready", message: "备用节目未就绪" });
  return conditions;
}

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
  if (!telemetry.fallbackReady) return { passed: false, detail: "备用节目未就绪" };
  return { passed: true, detail: `输出 ${telemetry.outputFps} FPS · 音画同步 ${telemetry.avSyncMs} ms · ${telemetry.bitrateMbps} Mbps` };
}

function persistentTelemetry(row: PersistentTelemetryRow): RuntimeTelemetry { return { runId: row.live_run_id, tenantId: row.tenant_id, sampledAt: new Date(row.sampled_at).toISOString(), outputConnected: row.output_connected, inferenceFps: Number(row.inference_fps), outputFps: Number(row.output_fps), avSyncMs: Number(row.av_sync_ms), bitrateMbps: Number(row.bitrate_mbps), gpuUtilization: Number(row.gpu_utilization), gpuMemoryMiB: Number(row.gpu_memory_mib), fallbackReady: row.fallback_ready }; }
function persistentAlert(row: PersistentAlertRow): RuntimeAlert { return { id: row.id, tenantId: row.tenant_id, runId: row.live_run_id, severity: row.severity, code: row.code, message: row.message, status: row.status, openedAt: new Date(row.opened_at).toISOString(), resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined }; }
