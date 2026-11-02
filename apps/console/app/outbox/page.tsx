import { OutboxWorkspace } from "@/components/outbox-workspace";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { listOutboxEvents } from "@/lib/control-plane/outbox";

export const dynamic = "force-dynamic";

export default async function OutboxPage() {
  const events = await listOutboxEvents(await pageRequestContext());
  return <OutboxWorkspace initialEvents={events} />;
}
