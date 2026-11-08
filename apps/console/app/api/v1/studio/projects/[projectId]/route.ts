import { readBoundedJson } from "@/lib/bounded-json";
import { isCreationProjectInput, updateCreationProject } from "@/lib/creation-projects";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: RouteContext<"/api/v1/studio/projects/[projectId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isCreationProjectInput(body)) return Response.json({ error: "invalid_creation_project" }, { status: 400 });
    const { projectId } = await context.params;
    const project = await updateCreationProject(actor, projectId, body);
    return project ? Response.json({ data: project }) : Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "creation_project_rejected" }, { status: error.status });
    throw error;
  }
}
