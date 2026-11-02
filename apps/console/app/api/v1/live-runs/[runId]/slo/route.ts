import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { getRuntimeSamplingSlo } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/slo">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "analyst"]);
  const { runId } = await context.params;
  if (!await getRun(actor, runId)) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ data: await getRuntimeSamplingSlo(actor, runId) });
}
