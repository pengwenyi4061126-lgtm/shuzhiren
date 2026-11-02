import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { revokeModelRelease } from "@/lib/releases";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/releases/[releaseId]/revoke">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const body: unknown = await request.json().catch(() => null);
    const reason = body && typeof body === "object" && typeof (body as Record<string, unknown>).reason === "string" ? (body as Record<string, string>).reason.trim() : "";
    if (!reason || reason.length > 1000) return Response.json({ error: "invalid_revocation_reason" }, { status: 400 });
    const { releaseId } = await context.params;
    const release = await revokeModelRelease(actor, releaseId, reason);
    await recordAuditEvent(actor, { type: "model_release.revoked", resource: "model_release", resourceId: release.id, detail: { component: release.component, version: release.version, reason } });
    return Response.json({ data: release });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "model_release_revocation_rejected" }, { status: error.status });
    throw error;
  }
}
