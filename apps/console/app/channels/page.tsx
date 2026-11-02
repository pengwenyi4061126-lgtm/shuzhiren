import { AccessDenied } from "@/components/access-denied";
import { ChannelWorkspace } from "@/components/channel-workspace";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listChannelConnections } from "@/lib/channels";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "analyst"]);
  if (!actor) return <AccessDenied />;
  const connections = await listChannelConnections(actor);
  return <ChannelWorkspace initialConnections={connections} />;
}
