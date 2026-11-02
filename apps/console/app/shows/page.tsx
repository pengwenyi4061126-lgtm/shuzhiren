import { ShowScheduleWorkspace } from "@/components/show-schedule-workspace";
import { listProducts } from "@/lib/catalog";
import { listChannelConnections } from "@/lib/channels";
import { demoRequestContext } from "@/lib/control-plane/auth-context";
import { listRuns } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export default async function ShowsPage() {
  const [runs, products, channels] = await Promise.all([listRuns(demoRequestContext), listProducts(demoRequestContext), listChannelConnections(demoRequestContext)]);
  return <ShowScheduleWorkspace initialRuns={runs} products={products} channels={channels} />;
}
