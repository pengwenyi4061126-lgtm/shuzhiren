import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { bindRuntimeSession } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/runtime-session">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator"]);
  const body: unknown = await request.json().catch(() => null);
  if (!isBinding(body)) return Response.json({ error: "invalid_runtime_session" }, { status: 400 });
  const { runId } = await context.params;
  try {
    const run = await bindRuntimeSession(actor, runId, body.runtimeSessionId);
    await recordAuditEvent(actor, { type: "runtime_session.bound", resource: "live_run", resourceId: run.id, detail: { runtimeSessionId: run.runtimeSessionId ?? "" } });
    return Response.json({ data: run });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_session_rejected" }, { status: error.status });
    throw error;
  }
}

function isBinding(value: unknown): value is { runtimeSessionId: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as Record<string, unknown>).runtimeSessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test((value as Record<string, string>).runtimeSessionId);
}
