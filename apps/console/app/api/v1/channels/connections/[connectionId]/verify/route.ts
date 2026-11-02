import { recordAuditEvent } from "@/lib/audit";
import { recordChannelVerification, type ChannelStatus } from "@/lib/channels";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

const statuses = new Set<ChannelStatus>(["connected", "degraded", "disabled"]);

export async function POST(request: Request, context: RouteContext<"/api/v1/channels/connections/[connectionId]/verify">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator"]);
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !statuses.has((body as { status?: ChannelStatus }).status as ChannelStatus)) return Response.json({ error: "invalid_channel_status" }, { status: 400 });
  const { connectionId } = await context.params;
  try {
    const connection = await recordChannelVerification(actor, connectionId, (body as { status: ChannelStatus }).status);
    recordAuditEvent(actor, { type: "channel_connection.verified", resource: "channel_connection", resourceId: connection.id, detail: { status: connection.status, protocol: connection.outputProtocol } });
    return Response.json({ data: connection });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status });
    throw error;
  }
}
