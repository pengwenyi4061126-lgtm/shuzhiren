import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listRunEvents } from "@/lib/run-events";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/events">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { runId } = await context.params;
    const events = await listRunEvents(actor, runId);
    if (!events) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ data: events });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "run_events_rejected" }, { status: error.status });
    throw error;
  }
}
