import { recordAuditEvent } from "@/lib/audit";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { registerRecording, type RegisterRecordingInput } from "@/lib/recordings";
import { requireRuntimeRecordingService } from "@/lib/runtime-service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!isRecordingBody(body)) return Response.json({ error: "invalid_recording_evidence" }, { status: 400 });
    requireRuntimeRecordingService(request, body.tenantId);
    const context: RequestContext = { tenantId: body.tenantId, actorId: "runtime-recording-service", actorName: "运行时录制归档服务", role: "operator" };
    const registration = await registerRecording(context, body);
    if (!registration.duplicate) await recordAuditEvent(context, { type: "recording_evidence.registered", resource: "recording_evidence", resourceId: registration.recording.id, detail: { runId: registration.recording.runId, objectKey: registration.recording.objectKey, bytes: registration.recording.bytes, durationSeconds: registration.recording.durationSeconds } });
    return Response.json({ data: registration.recording }, { status: registration.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "recording_registration_rejected" }, { status: error.status });
    throw error;
  }
}

type RecordingBody = RegisterRecordingInput & { tenantId: string };

function isRecordingBody(value: unknown): value is RecordingBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const timestamp = (candidate: unknown) => candidate === undefined || (typeof candidate === "string" && !Number.isNaN(Date.parse(candidate)));
  const objectKey = typeof body.objectKey === "string" ? body.objectKey : "";
  return typeof body.tenantId === "string" && body.tenantId.length > 0
    && typeof body.runId === "string" && body.runId.length > 0
    && objectKey.length > 0 && objectKey.length <= 512 && !objectKey.startsWith("/") && !objectKey.includes("\\") && !objectKey.includes("..") && !/^[a-z][a-z0-9+.-]*:/i.test(objectKey)
    && typeof body.checksumSha256 === "string" && /^[0-9a-f]{64}$/i.test(body.checksumSha256)
    && typeof body.bytes === "number" && Number.isSafeInteger(body.bytes) && body.bytes >= 0
    && typeof body.durationSeconds === "number" && Number.isSafeInteger(body.durationSeconds) && body.durationSeconds >= 0
    && typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0 && body.idempotencyKey.length <= 200
    && timestamp(body.startedAt) && timestamp(body.endedAt)
    && (body.retentionUntil === undefined || (typeof body.retentionUntil === "string" && !Number.isNaN(Date.parse(body.retentionUntil))));
}
