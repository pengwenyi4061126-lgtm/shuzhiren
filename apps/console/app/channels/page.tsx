import { demoRequestContext } from "@/lib/control-plane/auth-context";
import { ChannelWorkspace } from "@/components/channel-workspace";
import { listChannelConnections } from "@/lib/channels";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const connections = await listChannelConnections(demoRequestContext);
  return <ChannelWorkspace initialConnections={connections} />;
}
