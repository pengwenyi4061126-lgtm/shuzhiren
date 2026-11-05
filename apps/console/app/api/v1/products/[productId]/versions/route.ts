import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { readBoundedJson } from "@/lib/bounded-json";
import { createProductVersion, findProduct, type ProductFacts } from "@/lib/catalog";
import { recordAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: RouteContext<"/api/v1/products/[productId]/versions">) {
  try { const actor = await requestContextFrom(request); requireRole(actor, ["admin", "operator", "reviewer", "analyst"]); const { productId } = await context.params; const product = await findProduct(actor, productId); return product ? Response.json({ data: product.versions }) : Response.json({ error: "not_found" }, { status: 404 }); }
  catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "product_version_rejected" }, { status: error.status }); throw error; }
}
export async function POST(request: Request, context: RouteContext<"/api/v1/products/[productId]/versions">) {
  try {
    const actor = await requestContextFrom(request); requireRole(actor, ["admin", "operator"]); let body: unknown; try { body = await readBoundedJson(request); } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; } if (!isFacts(body)) return Response.json({ error: "invalid_facts" }, { status: 400 }); const { productId } = await context.params;
    const version = await createProductVersion(actor, productId, body); await recordAuditEvent(actor, { type: "product_version.created", resource: "product_version", resourceId: version.id, detail: { productId, revision: version.revision } }); return Response.json({ data: version }, { status: 201 });
  } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status }); throw error; }
}
function isFacts(value: unknown): value is ProductFacts {
  if (!value || typeof value !== "object") return false;
  const facts = value as Record<string, unknown>;
  const timestamp = (key: "sourceSyncedAt" | "validFrom" | "validUntil") => facts[key] === undefined || (typeof facts[key] === "string" && !Number.isNaN(Date.parse(facts[key])));
  const sourceRef = typeof facts.sourceRef === "string" && facts.sourceRef.trim().length > 0 && facts.sourceRef.length <= 500;
  const periodValid = typeof facts.validFrom === "string" && (facts.validUntil === undefined || Date.parse(facts.validUntil as string) > Date.parse(facts.validFrom));
  const unitCost = facts.unitCostCent === undefined || (Number.isInteger(facts.unitCostCent) && (facts.unitCostCent as number) >= 0);
  return Number.isInteger(facts.priceCent) && (facts.priceCent as number) >= 0 && unitCost && Number.isInteger(facts.stock) && (facts.stock as number) >= 0 && Array.isArray(facts.highlights) && Array.isArray(facts.faq) && facts.highlights.every((item) => typeof item === "string" && item.length <= 500) && facts.faq.every((item) => typeof item === "string" && item.length <= 500) && sourceRef && timestamp("sourceSyncedAt") && timestamp("validFrom") && timestamp("validUntil") && typeof facts.sourceSyncedAt === "string" && periodValid;
}
