import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { readBoundedJson } from "@/lib/bounded-json";
import { issueCommand, type CommandInput } from "@/lib/control-plane/store";
import type { LiveCommandAction, LiveRunState } from "@/lib/domain";
import { recordAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";

const actions = new Set<LiveCommandAction>(["START", "PAUSE", "HANDOFF", "END", "RECOVER", "INSERT_PROGRAM", "ROLLBACK_PROGRAM"]);
const states = new Set<LiveRunState>(["DRAFT", "REVIEW", "APPROVED", "PREFLIGHT", "ARMED", "LIVE", "DEGRADED", "ENDED", "ARCHIVED"]);

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/commands">) {
  try {
    const requestContext = await requestContextFrom(request);
    requireRole(requestContext, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isCommandBody(body)) return Response.json({ error: "invalid_command" }, { status: 400 });
    const { runId } = await context.params;

    const result = await issueCommand(requestContext, runId, body);
    if (!result.duplicate) {
      await recordAuditEvent(requestContext, { type: "live_command.accepted", resource: "live_run", resourceId: runId, detail: { action: body.action, commandId: result.command.id, programSegmentId: body.programSegmentId ?? null } });
      await recordAuditEvent(requestContext, { type: "media_command.enqueued", resource: "outbox_event", resourceId: result.mediaEvent.id, detail: { mediaCommandId: result.mediaEvent.command.id, commandType: result.mediaEvent.command.type, controlAction: body.action, programSegmentId: body.programSegmentId ?? null } });
    }
    return Response.json({ data: result }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "command_rejected" }, { status: error.status });
    throw error;
  }
}

function isCommandBody(value: unknown): value is CommandInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.idempotencyKey !== "string" || candidate.idempotencyKey.length < 8 || !actions.has(candidate.action as LiveCommandAction) || !states.has(candidate.expectedState as LiveRunState)) return false;
  if (candidate.action === "INSERT_PROGRAM") return typeof candidate.programSegmentId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.programSegmentId);
  return candidate.programSegmentId === undefined;
}
