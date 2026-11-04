import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getSettlementBatch } from "@/lib/settlements";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/settlement-batches/[batchId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { batchId } = await context.params;
    const batch = await getSettlementBatch(actor, batchId);
    return batch ? Response.json({ data: batch }) : Response.json({ error: "settlement_batch_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "settlement_batch_rejected" }, { status: error.status });
    throw error;
  }
}
