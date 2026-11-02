import { AccessDenied } from "@/components/access-denied";
import { PolicyProfileWorkspace } from "@/components/policy-profile-workspace";
import { PolicyWorkspace } from "@/components/policy-workspace";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listPolicyProfiles } from "@/lib/policy-profiles";

export const dynamic = "force-dynamic";

export default async function PolicyPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer"]);
  if (!actor) return <AccessDenied />;
  const profiles = await listPolicyProfiles(actor);
  return <><PolicyWorkspace /><PolicyProfileWorkspace initialProfiles={profiles} canManage={actor.role === "admin" || actor.role === "operator"} canApprove={actor.role === "admin" || actor.role === "reviewer"} /></>;
}
