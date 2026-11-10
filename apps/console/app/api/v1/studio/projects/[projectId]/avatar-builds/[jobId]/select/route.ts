import { selectAvatarBuildForProject } from "@/lib/avatar-build-jobs";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/studio/projects/[projectId]/avatar-builds/[jobId]/select">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { projectId, jobId } = await context.params;
    return Response.json({ data: await selectAvatarBuildForProject(actor, projectId, jobId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "avatar_selection_rejected" }, { status: error.status });
    throw error;
  }
}
