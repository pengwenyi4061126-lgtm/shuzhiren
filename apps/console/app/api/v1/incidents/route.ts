import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { readBoundedJson } from "@/lib/bounded-json";
import { createIncidentFromAlert, listIncidents } from "@/lib/incidents";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "analyst"]);
    return Response.json({ data: await listIncidents(actor, new URL(request.url).searchParams.get("runId") ?? undefined) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "incident_rejected" }, { status: error.status });
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const body = (await readBoundedJson(request) ?? {}) as { alertId?: unknown };
    if (typeof body.alertId !== "string" || !body.alertId) return Response.json({ error: "alertId is required" }, { status: 400 });
    const result = await createIncidentFromAlert(actor, body.alertId);
    return Response.json({ data: result }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "incident_rejected" }, { status: error.status });
    throw error;
  }
}
