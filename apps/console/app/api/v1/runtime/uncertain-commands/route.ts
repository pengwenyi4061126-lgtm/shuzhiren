import { requestContextFrom, requireRole, requireTenantWideAccess } from "@/lib/control-plane/auth-context";
import { listUncertainCommands } from "@/lib/control-plane/uncertain-commands";
import { uncertainCommandGatewayFailure } from "@/lib/control-plane/uncertain-command-responses";
export const dynamic = "force-dynamic";
// Proxies GET /v1/ops/uncertain-commands of the Runtime Gateway with RUNTIME_SHARED_TOKEN, limited to this tenant's commands.
export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin"]);
    requireTenantWideAccess(context);
    try {
      return Response.json({ data: await listUncertainCommands(context) }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof Response) throw error;
      return uncertainCommandGatewayFailure(error, "/api/v1/runtime/uncertain-commands");
    }
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "uncertain_commands_rejected" }, { status: error.status });
    throw error;
  }
}
