import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getTelemetry } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/telemetry">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "analyst"]);
  const { runId } = await context.params;
  const telemetry = getTelemetry(actor, runId);
  return telemetry ? Response.json({ data: telemetry }) : Response.json({ error: "not_found" }, { status: 404 });
}
