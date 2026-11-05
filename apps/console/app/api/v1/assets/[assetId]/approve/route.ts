import { approveMediaAsset } from "@/lib/assets";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/assets/[assetId]/approve">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const { assetId } = await context.params;
    // approveMediaAsset writes media_asset.approved in the approval's transaction.
    const asset = await approveMediaAsset(actor, assetId);
    return Response.json({ data: asset });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "media_asset_rejected" }, { status: error.status });
    throw error;
  }
}
