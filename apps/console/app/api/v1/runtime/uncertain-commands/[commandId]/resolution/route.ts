import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole, requireTenantWideAccess } from "@/lib/control-plane/auth-context";
import { parseResolutionInput, ResolutionAuditFailedError, resolveUncertainCommand } from "@/lib/control-plane/uncertain-commands";
import { uncertainCommandGatewayFailure } from "@/lib/control-plane/uncertain-command-responses";
export const dynamic = "force-dynamic";
// Proxies POST /v1/ops/uncertain-commands/{id}/resolution of the Runtime Gateway with RUNTIME_SHARED_TOKEN. Only
// resolution and note are forwarded; the audit event runtime_command.resolved is written after the Gateway accepted.
export async function POST(request: Request, context: RouteContext<"/api/v1/runtime/uncertain-commands/[commandId]/resolution">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin"]);
    requireTenantWideAccess(actor);
    const { commandId } = await context.params;
    const input = parseResolutionInput(await readBoundedJson(request));
    if (!input) return Response.json({ error: "invalid_resolution", detail: "resolution 须为 completed 或 failed_definite，note 为 1–500 字符" }, { status: 400 });
    try {
      return Response.json({ data: await resolveUncertainCommand(actor, commandId, input) });
    } catch (error) {
      if (error instanceof Response) throw error;
      // The Gateway resolved the command; only its audit event is missing (logged by resolveUncertainCommand).
      if (error instanceof ResolutionAuditFailedError) return Response.json({ error: error.code, code: error.code, data: error.result }, { status: 500 });
      return uncertainCommandGatewayFailure(error, "/api/v1/runtime/uncertain-commands/[commandId]/resolution");
    }
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "uncertain_command_resolution_rejected" }, { status: error.status });
    throw error;
  }
}
