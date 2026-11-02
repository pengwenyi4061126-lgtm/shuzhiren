import { recordAuditEvent } from "@/lib/audit";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { bindRuntimeSession, canBindRuntimeSession, getRun } from "@/lib/control-plane/store";
import { observeRuntimeSession } from "@/lib/runtime-gateway";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/runtime-session">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator"]);
  let body: unknown;
  try { body = await readBoundedJson(request); }
  catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
  if (!isBinding(body)) return Response.json({ error: "invalid_runtime_session" }, { status: 400 });
  const { runId } = await context.params;
  const existing = await getRun(actor, runId);
  if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canBindRuntimeSession(existing.state)) return Response.json({ error: "runtime_session_locked_after_arming" }, { status: 409 });
  try {
    const observation = await observeRuntimeSession(body.runtimeSessionId);
    if (!observation.session.active) return Response.json({ error: "runtime_session_not_active" }, { status: 409 });
  } catch {
    return Response.json({ error: "runtime_session_verification_failed" }, { status: 502 });
  }
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
