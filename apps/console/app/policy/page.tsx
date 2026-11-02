import { AccessDenied } from "@/components/access-denied";
import { PolicyWorkspace } from "@/components/policy-workspace";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";

export const dynamic = "force-dynamic";

export default async function PolicyPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer"]);
  if (!actor) return <AccessDenied />;
  return <PolicyWorkspace />;
}
