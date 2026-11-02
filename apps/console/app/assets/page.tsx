import { AssetWorkspace } from "@/components/asset-workspace";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { listAssets } from "@/lib/assets";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const actor = await pageRequestContext();
  const assets = await listAssets(actor);
  return <AssetWorkspace initialAssets={assets} canApprove={actor.role === "admin" || actor.role === "reviewer"} />;
}
