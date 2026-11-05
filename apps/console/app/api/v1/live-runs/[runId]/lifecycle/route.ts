import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { advanceRunLifecycle, type RunLifecycleAction } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";
const actions = new Set<RunLifecycleAction>(["submit_review", "approve", "begin_preflight", "arm", "disarm", "archive"]);

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/lifecycle">) {
  try {
    const actor = await requestContextFrom(request);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    const action = body && typeof body === "object" ? (body as { action?: string }).action : undefined;
    if (!action || !actions.has(action as RunLifecycleAction)) return Response.json({ error: "invalid_lifecycle_action" }, { status: 400 });
    requireRole(actor, action === "approve" ? ["admin", "reviewer"] : ["admin", "operator"]);
    const { runId } = await context.params;
    const run = await advanceRunLifecycle(actor, runId, action as RunLifecycleAction);
    return Response.json({ data: run });
  } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "lifecycle_conflict" }, { status: error.status }); throw error; }
}
