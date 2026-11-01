import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createProduct, listProducts } from "@/lib/catalog";
import { recordAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";
export async function GET(request: Request) { const context = await requestContextFrom(request); return Response.json({ data: await listProducts(context) }); }
export async function POST(request: Request) {
  const context = await requestContextFrom(request); requireRole(context, ["admin", "operator"]);
  const body: unknown = await request.json().catch(() => null);
  if (!isProductInput(body)) return Response.json({ error: "invalid_product" }, { status: 400 });
  try { const product = await createProduct(context, body); recordAuditEvent(context, { type: "product.created", resource: "product", resourceId: product.id, detail: { externalSku: product.externalSku } }); return Response.json({ data: product }, { status: 201 }); } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status }); throw error; }
}
function isProductInput(value: unknown): value is { externalSku: string; name: string } { if (!value || typeof value !== "object") return false; const input = value as Record<string, unknown>; return typeof input.externalSku === "string" && input.externalSku.length > 0 && typeof input.name === "string" && input.name.length > 0; }
