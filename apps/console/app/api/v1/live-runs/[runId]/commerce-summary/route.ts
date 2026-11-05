import { getCommerceSummary } from "@/lib/commerce";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { runId } = await params;
    if (!await getRun(actor, runId)) return Response.json({ error: "live_run_not_found" }, { status: 404 });
    return Response.json({ data: await getCommerceSummary(actor, runId) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "commerce_summary_rejected" }, { status: error.status });
    throw error;
  }
}
