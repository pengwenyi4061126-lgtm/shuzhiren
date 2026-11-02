import { ShowScheduleWorkspace } from "@/components/show-schedule-workspace";
import { listProducts } from "@/lib/catalog";
import { listChannelConnections } from "@/lib/channels";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { listRuns } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export default async function ShowsPage() {
  const actor = await pageRequestContext();
  const [runs, products, channels] = await Promise.all([listRuns(actor), listProducts(actor), listChannelConnections(actor)]);
  return <ShowScheduleWorkspace initialRuns={runs} products={products} channels={channels} canApprove={actor.role === "admin" || actor.role === "reviewer"} />;
}
