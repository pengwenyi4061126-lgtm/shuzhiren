import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { approvePolicyProfile } from "@/lib/policy-profiles";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/policy/profiles/[profileId]/approve">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const { profileId } = await context.params;
    const profile = await approvePolicyProfile(actor, profileId);
    await recordAuditEvent(actor, { type: "policy_profile.approved", resource: "policy_profile", resourceId: profile.id, detail: { name: profile.name, version: profile.version, ruleCount: profile.rules.length } });
    return Response.json({ data: profile });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "policy_profile_approval_rejected" }, { status: error.status });
    throw error;
  }
}
