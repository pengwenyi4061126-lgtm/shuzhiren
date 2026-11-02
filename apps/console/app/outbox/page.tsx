import { AccessDenied } from "@/components/access-denied";
import { OutboxWorkspace } from "@/components/outbox-workspace";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listOutboxEvents } from "@/lib/control-plane/outbox";

export const dynamic = "force-dynamic";

export default async function OutboxPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "analyst"]);
  if (!actor) return <AccessDenied />;
  const events = await listOutboxEvents(actor);
  return <OutboxWorkspace initialEvents={events} />;
}
