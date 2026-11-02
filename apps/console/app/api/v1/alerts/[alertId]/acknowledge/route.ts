import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { acknowledgeAlert } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ alertId: string }> }) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator"]);
  const { alertId } = await params;
  try {
    const result = await acknowledgeAlert(actor, alertId);
    if (!result.duplicate) await recordAuditEvent(actor, { type: "runtime_alert.acknowledged", resource: "runtime_alert", resourceId: result.alert.id, detail: { runId: result.alert.runId, code: result.alert.code, severity: result.alert.severity } });
    return Response.json({ data: result });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_alert_acknowledgement_rejected" }, { status: error.status });
    throw error;
  }
}
