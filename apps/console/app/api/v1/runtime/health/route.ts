import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { runtimeGatewayHealth } from "@/lib/runtime-gateway";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    try {
      return Response.json({ data: await runtimeGatewayHealth() });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "runtime_unavailable" }, { status: 503 });
    }
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_health_rejected" }, { status: error.status });
    throw error;
  }
}
