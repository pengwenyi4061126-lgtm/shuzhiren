import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listScriptPlays } from "@/lib/script-plays";

export const dynamic = "force-dynamic";

// The newest 200 script rotation ledger rows of a run (version index, version count, script hash), never the script text.
export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/script-plays">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { runId } = await context.params;
    return Response.json({ data: await listScriptPlays(actor, runId) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "script_plays_rejected" }, { status: error.status });
    throw error;
  }
}
