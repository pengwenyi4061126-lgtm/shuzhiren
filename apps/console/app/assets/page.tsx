import { AssetWorkspace } from "@/components/asset-workspace";
import { AccessDenied } from "@/components/access-denied";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listAssets } from "@/lib/assets";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer", "analyst"], { tenantWide: true });
  if (!actor) return <AccessDenied />;
  const assets = await listAssets(actor);
  return <AssetWorkspace initialAssets={assets} canManage={actor.role === "admin" || actor.role === "operator"} canApprove={actor.role === "admin" || actor.role === "reviewer"} />;
}
