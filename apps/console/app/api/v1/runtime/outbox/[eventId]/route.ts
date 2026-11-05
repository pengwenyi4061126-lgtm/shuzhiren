import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getOutboxEvent } from "@/lib/control-plane/outbox";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/runtime/outbox/[eventId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "analyst"]);
    const { eventId } = await context.params;
    const event = await getOutboxEvent(actor, eventId);
    if (!event) return Response.json({ error: "outbox_event_not_found" }, { status: 404 });
    return Response.json({ data: event });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "outbox_rejected" }, { status: error.status });
    throw error;
  }
}
