import { readBoundedJson } from "@/lib/bounded-json";
import { createCreationProject, isCreationProjectInput, listCreationProjects } from "@/lib/creation-projects";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    return Response.json({ data: await listCreationProjects(context) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "creation_projects_rejected" }, { status: error.status });
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isCreationProjectInput(body)) return Response.json({ error: "invalid_creation_project" }, { status: 400 });
    return Response.json({ data: await createCreationProject(context, body) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "creation_project_rejected" }, { status: error.status });
    throw error;
  }
}
