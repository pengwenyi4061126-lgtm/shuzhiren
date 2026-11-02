import { demoRequestContext } from "@/lib/control-plane/auth-context";
import { AssetWorkspace } from "@/components/asset-workspace";
import { listAssets } from "@/lib/assets";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const assets = await listAssets(demoRequestContext);
  return <AssetWorkspace initialAssets={assets} canApprove={demoRequestContext.role === "admin" || demoRequestContext.role === "reviewer"} />;
}
