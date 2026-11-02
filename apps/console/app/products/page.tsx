import { ProductWorkspace } from "@/components/product-workspace";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { listProducts } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const actor = await pageRequestContext();
  const products = await listProducts(actor);
  return <ProductWorkspace initialProducts={products} canApprove={actor.role === "admin" || actor.role === "reviewer"} />;
}
