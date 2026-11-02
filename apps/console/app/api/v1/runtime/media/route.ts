import { recordAuditEvent } from "@/lib/audit";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { enqueueMediaCommand } from "@/lib/control-plane/outbox";

export const dynamic = "force-dynamic";

const mediaTypes = new Set(["start_program", "switch_to_fallback", "switch_to_human", "stop_program"]);

export async function POST(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "operator"]);
  let body: unknown;
  try { body = await readBoundedJson(request); }
  catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
  if (!isMediaInput(body)) return Response.json({ error: "invalid_media_command" }, { status: 400 });
  const run = await getRun(context, body.runId);
  if (!run) return Response.json({ error: "not_found" }, { status: 404 });
  const event = await enqueueMediaCommand(context, { runId: run.id, traceId: run.traceId, type: body.type, payload: {}, sessionId: body.sessionId });
  await recordAuditEvent(context, { type: "media_command.enqueued", resource: "outbox_event", resourceId: event.id, detail: { mediaCommandId: event.command.id, commandType: body.type } });
  return Response.json({ data: event }, { status: 202 });
}

function isMediaInput(value: unknown): value is { runId: string; sessionId: string; type: "start_program" | "switch_to_fallback" | "switch_to_human" | "stop_program" } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.runId === "string" && input.runId.length > 0 && typeof input.sessionId === "string" && input.sessionId.length > 0 && typeof input.type === "string" && mediaTypes.has(input.type);
}
