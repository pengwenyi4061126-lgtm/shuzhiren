import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { evaluateRunPreflight, getRun } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/preflight">) {
  const requestContext = await requestContextFrom(request);
  requireRole(requestContext, ["admin", "operator", "reviewer", "analyst"]);
  const { runId } = await context.params;
  const run = await getRun(requestContext, runId);
  if (!run) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ data: await evaluateRunPreflight(requestContext, run) });
}
