import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { approvePolicyProfile } from "@/lib/policy-profiles";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/policy/profiles/[profileId]/approve">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const { profileId } = await context.params;
    // approvePolicyProfile writes policy_profile.approved in the approval's transaction.
    const profile = await approvePolicyProfile(actor, profileId);
    return Response.json({ data: profile });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "policy_profile_approval_rejected" }, { status: error.status });
    throw error;
  }
}
