import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createProductVersion, findProduct, type ProductFacts } from "@/lib/catalog";
import { recordAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: RouteContext<"/api/v1/products/[productId]/versions">) { const actor = await requestContextFrom(request); const { productId } = await context.params; const product = await findProduct(actor, productId); return product ? Response.json({ data: product.versions }) : Response.json({ error: "not_found" }, { status: 404 }); }
export async function POST(request: Request, context: RouteContext<"/api/v1/products/[productId]/versions">) {
  const actor = await requestContextFrom(request); requireRole(actor, ["admin", "operator"]); const body: unknown = await request.json().catch(() => null); if (!isFacts(body)) return Response.json({ error: "invalid_facts" }, { status: 400 }); const { productId } = await context.params;
  try { const version = await createProductVersion(actor, productId, body); recordAuditEvent(actor, { type: "product_version.created", resource: "product_version", resourceId: version.id, detail: { productId, revision: version.revision } }); return Response.json({ data: version }, { status: 201 }); } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status }); throw error; }
}
function isFacts(value: unknown): value is ProductFacts { if (!value || typeof value !== "object") return false; const facts = value as Record<string, unknown>; return Number.isInteger(facts.priceCent) && (facts.priceCent as number) >= 0 && Number.isInteger(facts.stock) && (facts.stock as number) >= 0 && Array.isArray(facts.highlights) && Array.isArray(facts.faq) && facts.highlights.every((item) => typeof item === "string") && facts.faq.every((item) => typeof item === "string"); }
