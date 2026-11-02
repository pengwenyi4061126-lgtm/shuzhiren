import { ChannelWorkspace } from "@/components/channel-workspace";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { listChannelConnections } from "@/lib/channels";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const connections = await listChannelConnections(await pageRequestContext());
  return <ChannelWorkspace initialConnections={connections} />;
}
