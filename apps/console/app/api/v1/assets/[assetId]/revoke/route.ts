import { recordAuditEvent } from "@/lib/audit";
import { revokeMediaAsset } from "@/lib/assets";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/assets/[assetId]/revoke">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const body: unknown = await request.json().catch(() => null);
    const reason = body && typeof body === "object" && typeof (body as Record<string, unknown>).reason === "string" ? (body as Record<string, string>).reason.trim() : "";
    if (!reason || reason.length > 1000) return Response.json({ error: "invalid_revocation_reason" }, { status: 400 });
    const { assetId } = await context.params;
    const asset = await revokeMediaAsset(actor, assetId, reason);
    await recordAuditEvent(actor, { type: "media_asset.revoked", resource: "media_asset", resourceId: asset.id, detail: { kind: asset.kind, reason } });
    return Response.json({ data: asset });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "media_asset_revocation_rejected" }, { status: error.status });
    throw error;
  }
}
