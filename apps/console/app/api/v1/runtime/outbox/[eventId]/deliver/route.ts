import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { deliverOutboxEvent } from "@/lib/control-plane/outbox";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/runtime/outbox/[eventId]/deliver">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator"]);
  const { eventId } = await context.params;
  try {
    const result = await deliverOutboxEvent(actor, eventId);
    if (!result.duplicate) await recordAuditEvent(actor, { type: "media_command.delivered", resource: "outbox_event", resourceId: result.event.id, detail: { mediaCommandId: result.event.command.id, delivery: result.result.delivery } });
    return Response.json({ data: result }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "outbox_rejected" }, { status: error.status });
    return Response.json({ error: error instanceof Error ? error.message : "runtime_unavailable" }, { status: 503 });
  }
}
