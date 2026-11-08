import { readBoundedJson } from "@/lib/bounded-json";
import { attachLiveOutput } from "@/lib/creation-projects";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/studio/projects/[projectId]/live-outputs">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).runId !== "string" || !(body as Record<string, string>).runId) return Response.json({ error: "invalid_live_output" }, { status: 400 });
    const { projectId } = await context.params;
    const project = await attachLiveOutput(actor, projectId, (body as Record<string, string>).runId);
    return project ? Response.json({ data: project }) : Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "live_output_rejected" }, { status: error.status });
    throw error;
  }
}
