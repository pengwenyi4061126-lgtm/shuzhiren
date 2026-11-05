import { recordAuditEvent } from "@/lib/audit";
import { approveMediaAsset } from "@/lib/assets";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/assets/[assetId]/approve">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const { assetId } = await context.params;
    const asset = await approveMediaAsset(actor, assetId);
    await recordAuditEvent(actor, { type: "media_asset.approved", resource: "media_asset", resourceId: asset.id, detail: { kind: asset.kind, objectVersion: asset.contentVerification?.objectVersion ?? "unverified", checksum: asset.checksum, verificationEvidenceRef: asset.contentVerification?.evidenceRef ?? "unverified" } });
    return Response.json({ data: asset });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status });
    throw error;
  }
}
