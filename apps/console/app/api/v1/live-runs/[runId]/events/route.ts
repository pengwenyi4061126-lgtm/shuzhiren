import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listRunEvents } from "@/lib/run-events";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/events">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
  const { runId } = await context.params;
  const events = await listRunEvents(actor, runId);
  if (!events) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ data: events });
}
