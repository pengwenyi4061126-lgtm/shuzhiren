import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { degradeRunFromRuntime, getRun } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

const mediaTypes = new Set(["switch_to_fallback", "switch_to_human"]);

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isMediaInput(body)) return Response.json({ error: "invalid_media_command" }, { status: 400 });
    const run = await getRun(context, body.runId);
    if (!run) return Response.json({ error: "not_found" }, { status: 404 });
    if (!run.runtimeSessionId) return Response.json({ error: "runtime_session_not_bound" }, { status: 409 });
    if (run.state !== "LIVE") return Response.json({ error: "manual_media_action_requires_live_run" }, { status: 409 });
    // The media_command.enqueued audit event is written in the degradation's transaction.
    const result = await degradeRunFromRuntime(context, run.id, {
      fallbackReady: body.type === "switch_to_fallback",
      reasons: ["manual_operator_media_action"],
      audit: (degradation) => degradation.mediaEvent ? { type: "media_command.enqueued", resource: "outbox_event", resourceId: degradation.mediaEvent.id, detail: { mediaCommandId: degradation.mediaEvent.command.id, commandType: degradation.mediaType, reason: "manual_operator_media_action" } } : null
    });
    if (!result.changed || !result.mediaEvent) return Response.json({ error: "manual_media_action_rejected" }, { status: 409 });
    return Response.json({ data: result }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_media_rejected" }, { status: error.status });
    throw error;
  }
}

function isMediaInput(value: unknown): value is { runId: string; type: "switch_to_fallback" | "switch_to_human" } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if ("sessionId" in input) return false;
  return typeof input.runId === "string" && input.runId.length > 0 && typeof input.type === "string" && mediaTypes.has(input.type);
}
