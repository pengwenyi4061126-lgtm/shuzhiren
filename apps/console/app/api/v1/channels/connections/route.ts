import { createChannelConnection, isChannelProvider, listChannelConnections, type CreateChannelConnectionInput } from "@/lib/channels";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "analyst"]);
    return Response.json({ data: await listChannelConnections(context) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "channel_connection_rejected" }, { status: error.status });
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isConnectionInput(body)) return Response.json({ error: "invalid_channel_connection" }, { status: 400 });
    const connection = await createChannelConnection(context, body);
    return Response.json({ data: connection }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "channel_connection_rejected" }, { status: error.status });
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
