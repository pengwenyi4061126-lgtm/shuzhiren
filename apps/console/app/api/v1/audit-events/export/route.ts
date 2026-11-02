import { exportAuditEvidence } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "reviewer"]);
  const payload = await exportAuditEvidence(context);
  const timestamp = payload.generatedAt.replaceAll(/[:.]/g, "-");
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="shuzhiren-audit-evidence-${timestamp}.json"`,
      "cache-control": "no-store"
    }
  });
}
