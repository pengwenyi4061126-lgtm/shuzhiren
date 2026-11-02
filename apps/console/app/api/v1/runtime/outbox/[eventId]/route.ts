import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getOutboxEvent } from "@/lib/control-plane/outbox";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/runtime/outbox/[eventId]">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "analyst"]);
  const { eventId } = await context.params;
  const event = await getOutboxEvent(actor, eventId);
  if (!event) return Response.json({ error: "outbox_event_not_found" }, { status: 404 });
  return Response.json({ data: event });
}
