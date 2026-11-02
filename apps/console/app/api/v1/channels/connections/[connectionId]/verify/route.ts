import { recordAuditEvent } from "@/lib/audit";
import { recordChannelVerification, type ChannelStatus, type ChannelVerificationInput } from "@/lib/channels";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

const statuses = new Set<ChannelStatus>(["connected", "degraded", "disabled"]);

export async function POST(request: Request, context: RouteContext<"/api/v1/channels/connections/[connectionId]/verify">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator"]);
  const body: unknown = await request.json().catch(() => null);
  if (!isVerificationInput(body)) return Response.json({ error: "invalid_channel_verification" }, { status: 400 });
  const { connectionId } = await context.params;
  try {
    const connection = await recordChannelVerification(actor, connectionId, body);
    await recordAuditEvent(actor, { type: "channel_connection.verified", resource: "channel_connection", resourceId: connection.id, detail: { status: connection.status, protocol: connection.outputProtocol, evidenceRef: body.evidenceRef } });
    return Response.json({ data: connection });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status });
    throw error;
  }
}

function isVerificationInput(value: unknown): value is ChannelVerificationInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return statuses.has(input.status as ChannelStatus) && typeof input.evidenceRef === "string" && input.evidenceRef.trim().length > 0 && input.evidenceRef.trim().length <= 500;
}
