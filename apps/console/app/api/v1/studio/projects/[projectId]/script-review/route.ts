import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { revokeCreationProjectScriptReview, reviewCreationProjectScript } from "@/lib/creation-projects";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/studio/projects/[projectId]/script-review">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { projectId } = await context.params;
    const project = await reviewCreationProjectScript(actor, projectId);
    return project ? Response.json({ data: project }) : Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "creation_project_script_review_rejected" }, { status: error.status });
    throw error;
  }
}

export async function DELETE(request: Request, context: RouteContext<"/api/v1/studio/projects/[projectId]/script-review">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { projectId } = await context.params;
    const project = await revokeCreationProjectScriptReview(actor, projectId);
    return project ? Response.json({ data: project }) : Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "creation_project_script_review_rejected" }, { status: error.status });
    throw error;
  }
}
