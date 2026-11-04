import { ShowScheduleWorkspace } from "@/components/show-schedule-workspace";
import { listProducts } from "@/lib/catalog";
import { listChannelConnections } from "@/lib/channels";
import { hasTenantWideAccess } from "@/lib/control-plane/auth-context";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { listRuns } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export default async function ShowsPage() {
  const actor = await pageRequestContext();
  const tenantWide = hasTenantWideAccess(actor);
  const [runs, channels] = await Promise.all([listRuns(actor), listChannelConnections(actor)]);
  const products = tenantWide ? await listProducts(actor) : [];
  return <ShowScheduleWorkspace initialRuns={runs} products={products} channels={channels} canManage={actor.role === "admin" || actor.role === "operator"} canApprove={actor.role === "admin" || actor.role === "reviewer"} canCreate={tenantWide && (actor.role === "admin" || actor.role === "operator")} />;
}
