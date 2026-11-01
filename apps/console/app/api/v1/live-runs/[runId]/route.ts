import { requestContextFrom } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]">) {
  const requestContext = await requestContextFrom(request);
  const { runId } = await context.params;
  const run = await getRun(requestContext, runId);
  if (!run) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ data: run });
}
