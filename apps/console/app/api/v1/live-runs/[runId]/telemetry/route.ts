import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getTelemetry } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/telemetry">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "analyst"]);
    const { runId } = await context.params;
    const telemetry = await getTelemetry(actor, runId);
    return telemetry ? Response.json({ data: telemetry }) : Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_telemetry_rejected" }, { status: error.status });
    throw error;
  }
}
