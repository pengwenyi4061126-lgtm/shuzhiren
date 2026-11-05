import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { evaluateRunPreflight, getRun } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/preflight">) {
  try {
    const requestContext = await requestContextFrom(request);
    requireRole(requestContext, ["admin", "operator", "reviewer", "analyst"]);
    const { runId } = await context.params;
    const run = await getRun(requestContext, runId);
    if (!run) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ data: await evaluateRunPreflight(requestContext, run) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "preflight_rejected" }, { status: error.status });
    throw error;
  }
}
