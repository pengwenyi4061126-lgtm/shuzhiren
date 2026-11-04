import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { getRuntimePreview } from "@/lib/runtime-gateway";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/preview">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator"]);
  const { runId } = await context.params;
  const run = await getRun(actor, runId);
  if (!run) return Response.json({ error: "not_found" }, { status: 404 });
  if (!run.runtimeSessionId) return Response.json({ data: { available: false, reason: "session_inactive" } }, { headers: { "cache-control": "no-store" } });
  try {
    const preview = await getRuntimePreview(run.runtimeSessionId);
    await recordAuditEvent(actor, { type: "runtime_preview.requested", resource: "live_run", resourceId: run.id, detail: { runId: run.id, runtimeSessionId: run.runtimeSessionId, available: preview.available, ...(preview.available ? { mode: preview.mode, expiresAt: preview.expiresAt } : { reason: preview.reason }) } });
    return Response.json({ data: preview }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "runtime_preview_unavailable" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
