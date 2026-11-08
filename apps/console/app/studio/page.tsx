import { AccessDenied } from "@/components/access-denied";
import { StudioWorkspace } from "@/components/studio-workspace";
import { listAssets } from "@/lib/assets";
import { listProducts } from "@/lib/catalog";
import { listChannelConnections } from "@/lib/channels";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listCreationProjects } from "@/lib/creation-projects";

export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer", "analyst"], { tenantWide: true });
  if (!actor) return <AccessDenied />;
  const [products, channels, assets, projects] = await Promise.all([listProducts(actor), listChannelConnections(actor), listAssets(actor), listCreationProjects(actor)]);
  const assetOptions = assets.map(({ id, kind, name, approval, expiresAt, rightsScope, checksum, contentVerification }) => ({ id, kind, name, approval, expiresAt, rightsScope, checksum, contentType: contentVerification?.contentType ?? "" }));
  return <StudioWorkspace products={products} channels={channels} assets={assetOptions} initialProjects={projects} canCreate={actor.role === "admin" || actor.role === "operator"} />;
}
