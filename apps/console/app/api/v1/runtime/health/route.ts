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
      // The cause goes to the service log only; clients get a fixed code so
      // gateway responses, URLs and configuration errors never reach them.
      console.error(JSON.stringify({ event: "runtime_health_unavailable", route: "/api/v1/runtime/health", error: redactSecret(error instanceof Error ? error.message : String(error), process.env.RUNTIME_SHARED_TOKEN) }));
      return Response.json({ error: "runtime_unavailable" }, { status: 503 });
    }
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_health_rejected" }, { status: error.status });
    throw error;
  }
}

function redactSecret(message: string, secret: string | undefined) {
  return secret ? message.split(secret).join("[redacted]") : message;
}
