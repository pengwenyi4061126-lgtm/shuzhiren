import { ProductWorkspace } from "@/components/product-workspace";
import { AccessDenied } from "@/components/access-denied";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listProducts } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer", "analyst"], { tenantWide: true });
  if (!actor) return <AccessDenied />;
  const products = await listProducts(actor);
  return <ProductWorkspace initialProducts={products} canManage={actor.role === "admin" || actor.role === "operator"} canApprove={actor.role === "admin" || actor.role === "reviewer"} />;
}
