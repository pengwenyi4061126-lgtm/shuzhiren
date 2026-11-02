import { listAuditEvents } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "reviewer", "analyst"]);
  return Response.json({ data: await listAuditEvents(context) });
}
