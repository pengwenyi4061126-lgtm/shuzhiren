import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getRunReleaseManifest } from "@/lib/release-manifest";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/release-manifest">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
  const { runId } = await context.params;
  const manifest = await getRunReleaseManifest(actor, runId);
  return manifest ? Response.json({ data: manifest }) : Response.json({ error: "not_found" }, { status: 404 });
}
