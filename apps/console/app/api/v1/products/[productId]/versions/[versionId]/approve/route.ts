import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { approveProductVersion } from "@/lib/catalog";
import { recordAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: RouteContext<"/api/v1/products/[productId]/versions/[versionId]/approve">) {
  const actor = await requestContextFrom(request); requireRole(actor, ["admin", "reviewer"]); const { productId, versionId } = await context.params;
  try { const version = await approveProductVersion(actor, productId, versionId); await recordAuditEvent(actor, { type: "product_version.approved", resource: "product_version", resourceId: version.id, detail: { productId, revision: version.revision } }); return Response.json({ data: version }); } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status }); throw error; }
}
