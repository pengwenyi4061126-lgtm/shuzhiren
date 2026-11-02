import { listChannelConnections } from "@/lib/channels";
import { requestContextFrom } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requestContextFrom(request);
  return Response.json({ data: (await listChannelConnections(context)).map((connection) => connection.capability) });
}
