import { recordAuditEvent } from "@/lib/audit";
import type { ProductFacts } from "@/lib/catalog";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { ingestProductFacts } from "@/lib/product-ingest";
import { requirePimIngestService } from "@/lib/runtime-service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!isBody(body)) return Response.json({ error: "invalid_product_fact_ingest" }, { status: 400 });
    requirePimIngestService(request, body.tenantId);
    const context: RequestContext = { tenantId: body.tenantId, actorId: "pim-ingest-service", actorName: "PIM 商品事实接入服务", role: "operator" };
    const result = await ingestProductFacts(context, { externalEventId: body.eventId, externalSku: body.externalSku, name: body.name, facts: body.facts });
    if (!result.duplicate) await recordAuditEvent(context, { type: "product_facts.ingested", resource: "product_version", resourceId: result.version.id, detail: { productId: result.product.id, externalSku: result.product.externalSku, revision: result.version.revision, sourceRef: result.version.facts.sourceRef } });
    return Response.json({ data: result }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "product_fact_ingest_rejected" }, { status: error.status });
    throw error;
  }
}

type Body = { tenantId: string; eventId: string; externalSku: string; name: string; facts: ProductFacts };
function isBody(value: unknown): value is Body {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (!["tenantId", "eventId", "externalSku", "name"].every((key) => typeof body[key] === "string" && body[key].trim().length > 0 && body[key].length <= 200)) return false;
  if (!body.facts || typeof body.facts !== "object") return false;
  const facts = body.facts as Record<string, unknown>;
  const date = (key: "sourceSyncedAt" | "validFrom" | "validUntil") => facts[key] === undefined || (typeof facts[key] === "string" && !Number.isNaN(Date.parse(facts[key])));
  return Number.isSafeInteger(facts.priceCent) && (facts.priceCent as number) >= 0 && Number.isSafeInteger(facts.stock) && (facts.stock as number) >= 0
    && Array.isArray(facts.highlights) && Array.isArray(facts.faq) && facts.highlights.every((item) => typeof item === "string" && item.length <= 500) && facts.faq.every((item) => typeof item === "string" && item.length <= 500)
    && typeof facts.sourceRef === "string" && facts.sourceRef.trim().length > 0 && facts.sourceRef.length <= 500 && typeof facts.sourceSyncedAt === "string" && typeof facts.validFrom === "string"
    && date("sourceSyncedAt") && date("validFrom") && date("validUntil") && (facts.validUntil === undefined || Date.parse(facts.validUntil as string) > Date.parse(facts.validFrom));
}
