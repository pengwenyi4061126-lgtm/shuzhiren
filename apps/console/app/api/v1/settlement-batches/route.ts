import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listSettlementBatches } from "@/lib/settlements";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    return Response.json({ data: await listSettlementBatches(actor) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "settlement_batch_rejected" }, { status: error.status });
    throw error;
  }
}
