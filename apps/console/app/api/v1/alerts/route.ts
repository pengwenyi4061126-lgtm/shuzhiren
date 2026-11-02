import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listAlerts } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "analyst"]);
  return Response.json({ data: await listAlerts(actor, new URL(request.url).searchParams.get("runId") ?? undefined) });
}
