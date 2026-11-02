import { createChannelConnection, isChannelProvider, listChannelConnections, type CreateChannelConnectionInput } from "@/lib/channels";
import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "operator", "analyst"]);
  return Response.json({ data: await listChannelConnections(context) });
}

export async function POST(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "operator"]);
  const body: unknown = await request.json().catch(() => null);
  if (!isConnectionInput(body)) return Response.json({ error: "invalid_channel_connection" }, { status: 400 });
  try {
    const connection = await createChannelConnection(context, body);
    await recordAuditEvent(context, { type: "channel_connection.created", resource: "channel_connection", resourceId: connection.id, detail: { provider: connection.provider, protocol: connection.outputProtocol } });
    return Response.json({ data: connection }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status });
    throw error;
  }
}

function isConnectionInput(value: unknown): value is CreateChannelConnectionInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return ["name", "secretRef"].every((key) => typeof input[key] === "string" && input[key].trim().length > 0)
    && isChannelProvider(input.provider)
    && (input.outputProtocol === "rtmp" || input.outputProtocol === "srt")
    && Object.keys(input).every((key) => ["name", "provider", "secretRef", "outputProtocol"].includes(key));
}
