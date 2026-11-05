import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { deliverOutboxEvent, OutboxDeliveryStateUnconfirmedError } from "@/lib/control-plane/outbox";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/runtime/outbox/[eventId]/deliver">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { eventId } = await context.params;
    try {
      // deliverOutboxEvent writes runtime_command.delivered in the transaction that records the delivery.
      const result = await deliverOutboxEvent(actor, eventId);
      return Response.json({ data: result }, { status: result.duplicate ? 200 : 202 });
    } catch (error) {
      if (error instanceof Response) return Response.json({ error: error.statusText || "outbox_rejected" }, { status: error.status });
      // The Gateway accepted the command but its delivery was not recorded: the event stays delivering until
      // its lease ends, and must not be delivered again by hand.
      if (error instanceof OutboxDeliveryStateUnconfirmedError) return Response.json({ error: error.code, code: error.code, eventId: error.eventId }, { status: 503 });
      return Response.json({ error: error instanceof Error ? error.message : "runtime_unavailable", code: "runtime_dispatch_failed" }, { status: 503 });
    }
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "outbox_rejected" }, { status: error.status });
    throw error;
  }
}
