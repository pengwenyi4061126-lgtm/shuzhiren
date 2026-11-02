import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { advanceRunLifecycle, type RunLifecycleAction } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";
const actions = new Set<RunLifecycleAction>(["submit_review", "approve", "begin_preflight", "arm"]);

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/lifecycle">) {
  const actor = await requestContextFrom(request);
  const body: unknown = await request.json().catch(() => null);
  const action = body && typeof body === "object" ? (body as { action?: string }).action : undefined;
  if (!action || !actions.has(action as RunLifecycleAction)) return Response.json({ error: "invalid_lifecycle_action" }, { status: 400 });
  requireRole(actor, action === "approve" ? ["admin", "reviewer"] : ["admin", "operator"]);
  const { runId } = await context.params;
  try {
    const run = await advanceRunLifecycle(actor, runId, action as RunLifecycleAction);
    await recordAuditEvent(actor, { type: `live_run.${action}`, resource: "live_run", resourceId: run.id, detail: { state: run.state } });
    return Response.json({ data: run });
  } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "lifecycle_conflict" }, { status: error.status }); throw error; }
}
