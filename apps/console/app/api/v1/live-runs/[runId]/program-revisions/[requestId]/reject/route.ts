import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { rejectProgramRevisionRequest } from "@/lib/show-program-revisions";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program-revisions/[requestId]/reject">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const body = await readBoundedJson(request);
    const reason = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
    if (typeof reason !== "string" || reason.trim().length < 1 || reason.trim().length > 1000) return Response.json({ error: "invalid_rejection_reason" }, { status: 400 });
    const { runId, requestId } = await context.params;
    return Response.json({ data: await rejectProgramRevisionRequest(actor, runId, requestId, reason) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "program_revision_rejected" }, { status: error.status });
    throw error;
  }
}
