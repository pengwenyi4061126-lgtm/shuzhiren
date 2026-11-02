import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listAlerts } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "analyst"]);
  const runId = new URL(request.url).searchParams.get("runId") ?? undefined;
  if (runId && !isUuid(runId)) return Response.json({ error: "invalid_run_id" }, { status: 400 });
  return Response.json({ data: await listAlerts(actor, runId) });
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
