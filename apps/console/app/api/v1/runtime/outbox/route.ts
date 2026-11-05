import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listOutboxEvents } from "@/lib/control-plane/outbox";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "analyst"]);
    return Response.json({ data: await listOutboxEvents(context) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "outbox_rejected" }, { status: error.status });
    throw error;
  }
}
