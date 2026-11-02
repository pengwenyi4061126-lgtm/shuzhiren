import { recordAuditEvent } from "@/lib/audit";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { ingestTelemetry, type RuntimeTelemetryInput } from "@/lib/monitoring";
import { requireRuntimeService } from "@/lib/runtime-service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireRuntimeService(request);
    const body: unknown = await request.json().catch(() => null);
    if (!isTelemetryBody(body)) return Response.json({ error: "invalid_telemetry" }, { status: 400 });

    const serviceContext: RequestContext = { tenantId: body.tenantId, actorId: "runtime-service", actorName: "运行时服务", role: "operator" };
    if (!await getRun(serviceContext, body.runId)) return Response.json({ error: "live_run_not_found" }, { status: 404 });

    const input: RuntimeTelemetryInput = {
      runId: body.runId,
      sampledAt: body.sampledAt,
      outputConnected: body.outputConnected,
      inferenceFps: body.inferenceFps,
      outputFps: body.outputFps,
      avSyncMs: body.avSyncMs,
      bitrateMbps: body.bitrateMbps,
      gpuUtilization: body.gpuUtilization,
      gpuMemoryMiB: body.gpuMemoryMiB,
      fallbackReady: body.fallbackReady
    };
    const result = await ingestTelemetry(serviceContext, input);
    for (const alert of result.alerts) {
      await recordAuditEvent(serviceContext, {
        type: alert.status === "open" ? "runtime_alert.opened" : "runtime_alert.resolved",
        resource: "runtime_alert",
        resourceId: alert.id,
        detail: { runId: alert.runId, code: alert.code, severity: alert.severity }
      });
    }
    return Response.json({ data: result }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_telemetry_rejected" }, { status: error.status });
    throw error;
  }
}

type RuntimeTelemetryBody = RuntimeTelemetryInput & { tenantId: string };

function isTelemetryBody(value: unknown): value is RuntimeTelemetryBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const booleans = ["outputConnected", "fallbackReady"];
  const numbers = ["inferenceFps", "outputFps", "avSyncMs", "bitrateMbps", "gpuUtilization", "gpuMemoryMiB"];
  return typeof body.tenantId === "string" && body.tenantId.length > 0
    && typeof body.runId === "string" && body.runId.length > 0
    && (body.sampledAt === undefined || typeof body.sampledAt === "string")
    && booleans.every((key) => typeof body[key] === "boolean")
    && numbers.every((key) => typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] >= 0);
}
