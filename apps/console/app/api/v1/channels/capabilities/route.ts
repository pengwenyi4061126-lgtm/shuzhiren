import { listChannelConnections } from "@/lib/channels";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "analyst"]);
    return Response.json({ data: (await listChannelConnections(context)).map((connection) => connection.capability) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "channel_capability_rejected" }, { status: error.status });
    throw error;
  }
}
