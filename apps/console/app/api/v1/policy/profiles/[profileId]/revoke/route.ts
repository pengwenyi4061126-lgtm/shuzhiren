import { recordAuditEvent } from "@/lib/audit";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { revokePolicyProfile } from "@/lib/policy-profiles";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/policy/profiles/[profileId]/revoke">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const body = await readBoundedJson(request);
    const reason = body && typeof body === "object" && typeof (body as Record<string, unknown>).reason === "string" ? (body as Record<string, string>).reason.trim() : "";
    if (!reason || reason.length > 1000) return Response.json({ error: "invalid_revocation_reason" }, { status: 400 });
    const { profileId } = await context.params;
    const profile = await revokePolicyProfile(actor, profileId, reason);
    await recordAuditEvent(actor, { type: "policy_profile.revoked", resource: "policy_profile", resourceId: profile.id, detail: { name: profile.name, version: profile.version, reason } });
    return Response.json({ data: profile });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "policy_profile_revocation_rejected" }, { status: error.status });
    throw error;
  }
}
