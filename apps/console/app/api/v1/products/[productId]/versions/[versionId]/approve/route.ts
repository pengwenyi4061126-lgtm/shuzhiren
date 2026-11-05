import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { approveProductVersion } from "@/lib/catalog";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: RouteContext<"/api/v1/products/[productId]/versions/[versionId]/approve">) {
  try {
    const actor = await requestContextFrom(request); requireRole(actor, ["admin", "reviewer"]); const { productId, versionId } = await context.params;
    // approveProductVersion writes product_version.approved in the approval's transaction.
    const version = await approveProductVersion(actor, productId, versionId); return Response.json({ data: version });
  } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "product_version_rejected" }, { status: error.status }); throw error; }
}
