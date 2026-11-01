import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { issueCommand } from "@/lib/control-plane/store";
import type { LiveCommandAction, LiveRunState } from "@/lib/domain";
import { recordAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";

const actions = new Set<LiveCommandAction>(["START", "PAUSE", "HANDOFF", "END", "RECOVER"]);
const states = new Set<LiveRunState>(["DRAFT", "REVIEW", "APPROVED", "PREFLIGHT", "ARMED", "LIVE", "DEGRADED", "ENDED", "ARCHIVED"]);

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/commands">) {
  const requestContext = await requestContextFrom(request);
  requireRole(requestContext, ["admin", "operator"]);
  const body: unknown = await request.json().catch(() => null);
  if (!isCommandBody(body)) return Response.json({ error: "invalid_command" }, { status: 400 });
  const { runId } = await context.params;

  try {
    const result = await issueCommand(requestContext, runId, body);
    if (!result.duplicate) recordAuditEvent(requestContext, { type: "live_command.accepted", resource: "live_run", resourceId: runId, detail: { action: body.action, commandId: result.command.id } });
    return Response.json({ data: result }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "command_rejected" }, { status: error.status });
    throw error;
  }
}

function isCommandBody(value: unknown): value is { action: LiveCommandAction; idempotencyKey: string; expectedState: LiveRunState } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.idempotencyKey === "string" && candidate.idempotencyKey.length >= 8 && actions.has(candidate.action as LiveCommandAction) && states.has(candidate.expectedState as LiveRunState);
}
