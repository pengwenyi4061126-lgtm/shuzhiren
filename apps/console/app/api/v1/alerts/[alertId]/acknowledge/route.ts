import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { acknowledgeAlert } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ alertId: string }> }) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { alertId } = await params;
    // acknowledgeAlert writes runtime_alert.acknowledged in the acknowledgement's transaction.
    const result = await acknowledgeAlert(actor, alertId);
    return Response.json({ data: result });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_alert_acknowledgement_rejected" }, { status: error.status });
    throw error;
  }
}
