import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getOverlayConfig, replaceOverlayConfig } from "@/lib/overlay-scene";
import { listProgramRevisionRequests } from "@/lib/show-program-revisions";

export const dynamic = "force-dynamic";

async function candidateRevisionId(actor: Awaited<ReturnType<typeof requestContextFrom>>, runId: string, requestId: string) {
  const request = (await listProgramRevisionRequests(actor, runId)).find((item) => item.id === requestId);
  if (!request) throw new Response("Program revision request not found", { status: 404, statusText: "program_revision_not_found" });
  return request.candidateRevisionId;
}

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program-revisions/[requestId]/overlay">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { runId, requestId } = await context.params;
    const revisionId = await candidateRevisionId(actor, runId, requestId);
    return Response.json({ data: await getOverlayConfig(actor, runId, revisionId) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "overlay_config_rejected" }, { status: error.status });
    throw error;
  }
}

export async function PUT(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program-revisions/[requestId]/overlay">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const body = await readBoundedJson(request);
    const { runId, requestId } = await context.params;
    const revisionId = await candidateRevisionId(actor, runId, requestId);
    return Response.json({ data: await replaceOverlayConfig(actor, runId, body, revisionId) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "overlay_config_rejected" }, { status: error.status });
    throw error;
  }
}
