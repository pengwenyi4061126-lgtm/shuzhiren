import { readBoundedJson } from "@/lib/bounded-json";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { degradeRunFromRuntime, getRun } from "@/lib/control-plane/store";
import { ingestTelemetry, requiresRuntimeIntervention, type RuntimeTelemetryInput } from "@/lib/monitoring";
import { requireRuntimeService } from "@/lib/runtime-service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request);
    if (!isTelemetryBody(body)) return Response.json({ error: "invalid_telemetry" }, { status: 400 });
    requireRuntimeService(request, body.tenantId);

    const serviceContext: RequestContext = { tenantId: body.tenantId, actorId: "runtime-service", actorName: "运行时服务", role: "operator" };
    const run = await getRun(serviceContext, body.runId);
    if (!run) return Response.json({ error: "live_run_not_found" }, { status: 404 });
    // Recording evidence may arrive after archival, but fresh health samples must
    // not reopen output alerts for a terminal historical run.
    if (run.state === "ARCHIVED") return Response.json({ error: "archived_live_run_rejects_telemetry" }, { status: 409 });

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
      audioActive: body.audioActive,
      fallbackReady: body.fallbackReady
    };
    // ingestTelemetry audits each opened or resolved alert in the sample's transaction, and the
    // runtime_guard.degraded audit event is written in the degradation's transaction.
    const result = await ingestTelemetry(serviceContext, input);
    const escalation = requiresRuntimeIntervention(result.telemetry)
      ? await degradeRunFromRuntime(serviceContext, result.telemetry.runId, {
        fallbackReady: result.telemetry.fallbackReady,
        reasons: result.alerts.filter((alert) => alert.severity === "critical" || alert.status === "open").map((alert) => alert.code),
        audit: (degradation) => ({
          type: "runtime_guard.degraded",
          resource: "live_run",
          resourceId: result.telemetry.runId,
          detail: { mediaType: degradation.mediaType, fallbackReady: result.telemetry.fallbackReady, reasons: degradation.mediaEvent?.command.payload.reasons ?? "runtime_critical" }
        })
      })
      : { changed: false as const };
    return Response.json({ data: { ...result, escalation } }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_telemetry_rejected" }, { status: error.status });
    throw error;
  }
}

type RuntimeTelemetryBody = RuntimeTelemetryInput & { tenantId: string };

function isTelemetryBody(value: unknown): value is RuntimeTelemetryBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const booleans = ["outputConnected", "audioActive", "fallbackReady"];
  const numbers = ["inferenceFps", "outputFps", "avSyncMs", "bitrateMbps", "gpuUtilization", "gpuMemoryMiB"];
  return typeof body.tenantId === "string" && body.tenantId.length > 0
    && typeof body.runId === "string" && isUuid(body.runId)
    && (body.sampledAt === undefined || (typeof body.sampledAt === "string" && !Number.isNaN(Date.parse(body.sampledAt))))
    && booleans.every((key) => typeof body[key] === "boolean")
    && numbers.every((key) => typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] >= 0);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
