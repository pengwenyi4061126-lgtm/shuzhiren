import { AccessDenied } from "@/components/access-denied";
import { ProhibitedTermsWorkspace } from "@/components/prohibited-terms-workspace";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listProhibitedTerms } from "@/lib/prohibited-terms";

export const dynamic = "force-dynamic";

export default async function ProhibitedTermsPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer", "analyst"], { tenantWide: true });
  if (!actor) return <AccessDenied />;
  const data = await listProhibitedTerms(actor);
  return <ProhibitedTermsWorkspace initialData={data} canManage={actor.role === "admin"} canApprove={actor.role === "admin" || actor.role === "reviewer"} />;
}
