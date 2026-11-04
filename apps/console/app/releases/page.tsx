import { ReleaseWorkspace } from "@/components/release-workspace";
import { AccessDenied } from "@/components/access-denied";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listModelReleases } from "@/lib/releases";

export const dynamic = "force-dynamic";

export default async function ReleasesPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer", "analyst"], { tenantWide: true });
  if (!actor) return <AccessDenied />;
  const releases = await listModelReleases(actor);
  return <ReleaseWorkspace initialReleases={releases} canManage={actor.role === "admin" || actor.role === "operator"} canApprove={actor.role === "admin" || actor.role === "reviewer"} />;
}
