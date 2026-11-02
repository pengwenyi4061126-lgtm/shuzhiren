import { ReleaseWorkspace } from "@/components/release-workspace";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { listModelReleases } from "@/lib/releases";

export const dynamic = "force-dynamic";

export default async function ReleasesPage() {
  const actor = await pageRequestContext();
  const releases = await listModelReleases(actor);
  return <ReleaseWorkspace initialReleases={releases} canApprove={actor.role === "admin" || actor.role === "reviewer"} />;
}
