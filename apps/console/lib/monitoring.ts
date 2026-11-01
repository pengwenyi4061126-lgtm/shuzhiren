import type { RequestContext } from "@/lib/control-plane/auth-context";

export type RuntimeTelemetry = {
  runId: string;
  tenantId: string;
  sampledAt: string;
  outputConnected: boolean;
  inferenceFps: number;
  outputFps: number;
  avSyncMs: number;
  bitrateMbps: number;
  gpuUtilization: number;
  gpuMemoryMiB: number;
  fallbackReady: boolean;
};

export type RuntimeTelemetryInput = Omit<RuntimeTelemetry, "tenantId" | "sampledAt"> & { sampledAt?: string };

export type RuntimeAlert = {
  id: string;
  tenantId: string;
  runId: string;
  severity: "warning" | "critical";
  code: string;
  message: string;
  status: "open" | "resolved";
  openedAt: string;
  resolvedAt?: string;
};

type MonitoringStore = { telemetry: Map<string, RuntimeTelemetry>; alerts: Map<string, RuntimeAlert> };
type AlertCondition = Pick<RuntimeAlert, "severity" | "code" | "message">;

declare global {
  var shuzhirenMonitoringStore: MonitoringStore | undefined;
}

function monitoringStore(): MonitoringStore {
  globalThis.shuzhirenMonitoringStore ??= {
    telemetry: new Map([["run_20261101_001", {
      runId: "run_20261101_001", tenantId: "tenant_demo", sampledAt: "2026-11-01T14:40:00.000Z",
      outputConnected: true, inferenceFps: 31.8, outputFps: 25, avSyncMs: 31, bitrateMbps: 4.2,
      gpuUtilization: 72, gpuMemoryMiB: 14820, fallbackReady: true
    }]]),
    alerts: new Map()
  };
  return globalThis.shuzhirenMonitoringStore;
}

export function getTelemetry(context: RequestContext, runId: string) {
  const telemetry = monitoringStore().telemetry.get(runId);
  return telemetry?.tenantId === context.tenantId ? telemetry : null;
}

export function listAlerts(context: RequestContext, runId?: string) {
  return [...monitoringStore().alerts.values()]
    .filter((alert) => alert.tenantId === context.tenantId && (!runId || alert.runId === runId))
    .sort((left, right) => right.openedAt.localeCompare(left.openedAt));
}

export function ingestTelemetry(context: RequestContext, input: RuntimeTelemetryInput) {
  const sampledAt = input.sampledAt && !Number.isNaN(Date.parse(input.sampledAt)) ? input.sampledAt : new Date().toISOString();
  const telemetry: RuntimeTelemetry = { ...input, tenantId: context.tenantId, sampledAt };
  const state = monitoringStore();
  state.telemetry.set(telemetry.runId, telemetry);
  const alerts = reconcileAlerts(state, telemetry);
  return { telemetry, alerts };
}

function reconcileAlerts(state: MonitoringStore, telemetry: RuntimeTelemetry) {
  const active = new Map(alertConditions(telemetry).map((condition) => [condition.code, condition]));
  const matching = [...state.alerts.values()].filter((alert) => alert.tenantId === telemetry.tenantId && alert.runId === telemetry.runId);
  const changed: RuntimeAlert[] = [];

  for (const alert of matching) {
    if (alert.status === "open" && !active.has(alert.code)) {
      const resolved = { ...alert, status: "resolved" as const, resolvedAt: telemetry.sampledAt };
      state.alerts.set(resolved.id, resolved);
      changed.push(resolved);
    }
  }

  for (const condition of active.values()) {
    const existing = matching.find((alert) => alert.code === condition.code && alert.status === "open");
    if (existing) continue;
    const alert: RuntimeAlert = {
      id: `alert_${crypto.randomUUID()}`,
      tenantId: telemetry.tenantId,
      runId: telemetry.runId,
      status: "open",
      openedAt: telemetry.sampledAt,
      ...condition
    };
    state.alerts.set(alert.id, alert);
    changed.push(alert);
  }
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

export function evaluateRuntimeReadiness(context: RequestContext, runId: string) {
  const telemetry = getTelemetry(context, runId);
  if (!telemetry) return { passed: false, detail: "没有运行时遥测数据" };
  if (!telemetry.outputConnected) return { passed: false, detail: "推流连接未建立" };
  if (telemetry.outputFps < 24) return { passed: false, detail: `输出帧率过低：${telemetry.outputFps} FPS` };
  if (telemetry.avSyncMs > 120) return { passed: false, detail: `音画同步超阈值：${telemetry.avSyncMs} ms` };
  if (telemetry.bitrateMbps < 2) return { passed: false, detail: `输出码率过低：${telemetry.bitrateMbps} Mbps` };
  if (!telemetry.fallbackReady) return { passed: false, detail: "备用节目未就绪" };
  return { passed: true, detail: `输出 ${telemetry.outputFps} FPS · 音画同步 ${telemetry.avSyncMs} ms · ${telemetry.bitrateMbps} Mbps` };
}
