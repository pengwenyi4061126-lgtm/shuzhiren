import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { submitProgramRevisionRequest } from "@/lib/show-program-revisions";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program-revisions/[requestId]/submit">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { runId, requestId } = await context.params;
    return Response.json({ data: await submitProgramRevisionRequest(actor, runId, requestId) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "program_revision_rejected" }, { status: error.status });
    throw error;
  }
}
