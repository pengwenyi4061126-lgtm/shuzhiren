import { AccessDenied } from "@/components/access-denied";
import { OutboxWorkspace } from "@/components/outbox-workspace";
import { hasTenantWideAccess } from "@/lib/control-plane/auth-context";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listOutboxEvents } from "@/lib/control-plane/outbox";
export const dynamic = "force-dynamic";
export default async function OutboxPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "analyst"]);
  if (!actor) return <AccessDenied />;
  const events = await listOutboxEvents(actor);
  // Resolving an uncertain Gateway command is limited to tenant-wide admins, as in /api/v1/runtime/uncertain-commands.
  return <OutboxWorkspace initialEvents={events} canResolveUncertain={actor.role === "admin" && hasTenantWideAccess(actor)} />;
}
