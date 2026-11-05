import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { readBoundedJson } from "@/lib/bounded-json";
import { createProduct, listProducts } from "@/lib/catalog";
import { recordAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const context = await requestContextFrom(request); requireRole(context, ["admin", "operator", "reviewer", "analyst"]); return Response.json({ data: await listProducts(context) }); }
  catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "product_rejected" }, { status: error.status }); throw error; }
}
export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request); requireRole(context, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isProductInput(body)) return Response.json({ error: "invalid_product" }, { status: 400 });
    const product = await createProduct(context, body); await recordAuditEvent(context, { type: "product.created", resource: "product", resourceId: product.id, detail: { externalSku: product.externalSku } }); return Response.json({ data: product }, { status: 201 });
  } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status }); throw error; }
}
function isProductInput(value: unknown): value is { externalSku: string; name: string } { if (!value || typeof value !== "object") return false; const input = value as Record<string, unknown>; return typeof input.externalSku === "string" && input.externalSku.length > 0 && typeof input.name === "string" && input.name.length > 0; }
