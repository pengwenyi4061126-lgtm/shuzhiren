import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createProgramRevisionRequest, listProgramRevisionRequests } from "@/lib/show-program-revisions";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program-revisions">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { runId } = await context.params;
    return Response.json({ data: await listProgramRevisionRequests(actor, runId) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "program_revision_rejected" }, { status: error.status });
    throw error;
  }
}

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program-revisions">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { runId } = await context.params;
    return Response.json({ data: await createProgramRevisionRequest(actor, runId) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "program_revision_rejected" }, { status: error.status });
    throw error;
  }
}
