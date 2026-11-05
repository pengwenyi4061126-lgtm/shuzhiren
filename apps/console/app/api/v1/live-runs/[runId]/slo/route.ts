import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { getRuntimeSamplingSlo } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/slo">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "analyst"]);
    const { runId } = await context.params;
    if (!await getRun(actor, runId)) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ data: await getRuntimeSamplingSlo(actor, runId) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_slo_rejected" }, { status: error.status });
    throw error;
  }
}
