import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listSettlementBatches } from "@/lib/settlements";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
  return Response.json({ data: await listSettlementBatches(actor) });
}
