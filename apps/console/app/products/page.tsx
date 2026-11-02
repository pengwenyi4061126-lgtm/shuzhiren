import { demoRequestContext } from "@/lib/control-plane/auth-context";
import { ProductWorkspace } from "@/components/product-workspace";
import { listProducts } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const products = await listProducts(demoRequestContext);
  return <ProductWorkspace initialProducts={products} canApprove={demoRequestContext.role === "admin" || demoRequestContext.role === "reviewer"} />;
}
