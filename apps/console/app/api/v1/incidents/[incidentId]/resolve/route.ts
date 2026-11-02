import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { resolveIncident } from "@/lib/incidents";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/incidents/[incidentId]/resolve">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { incidentId } = await context.params;
    const body = await request.json() as { resolution?: unknown };
    if (typeof body.resolution !== "string") return Response.json({ error: "resolution is required" }, { status: 400 });
    return Response.json({ data: await resolveIncident(actor, incidentId, body.resolution) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "incident_rejected" }, { status: error.status });
    throw error;
  }
}
