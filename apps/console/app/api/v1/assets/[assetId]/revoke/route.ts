import { revokeMediaAsset } from "@/lib/assets";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/assets/[assetId]/revoke">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const body = await readBoundedJson(request);
    const reason = body && typeof body === "object" && typeof (body as Record<string, unknown>).reason === "string" ? (body as Record<string, string>).reason.trim() : "";
    if (!reason || reason.length > 1000) return Response.json({ error: "invalid_revocation_reason" }, { status: 400 });
    const { assetId } = await context.params;
    // revokeMediaAsset writes media_asset.revoked in the revocation's transaction.
    const outcome = await revokeMediaAsset(actor, assetId, reason);
    return Response.json({ data: outcome.asset, meta: { quarantinedLiveRunCount: outcome.impact.liveRunIds.length, humanHandoffQueuedCount: outcome.impact.humanHandoffQueuedRunIds.length } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "media_asset_revocation_rejected" }, { status: error.status });
    throw error;
  }
}
