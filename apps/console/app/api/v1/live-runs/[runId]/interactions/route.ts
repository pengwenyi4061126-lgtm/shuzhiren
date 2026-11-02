import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { createInteraction, listInteractions } from "@/lib/interactions";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/interactions">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
  const { runId } = await context.params;
  return Response.json({ data: await listInteractions(actor, runId, new URL(request.url).searchParams.get("status") === "handled" ? "handled" : "queued") });
}

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/interactions">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const body: unknown = await request.json().catch(() => null);
    if (!isInteractionInput(body)) return Response.json({ error: "invalid_interaction" }, { status: 400 });
    const { runId } = await context.params;
    const run = await getRun(actor, runId);
    if (!run) return Response.json({ error: "not_found" }, { status: 404 });
    if (run.state !== "LIVE" && run.state !== "DEGRADED") return Response.json({ error: "live_run_not_accepting_interactions" }, { status: 409 });
    const interaction = await createInteraction(actor, { runId, question: body.question.trim(), source: body.source, evidenceIds: body.evidenceIds });
    await recordAuditEvent(actor, { type: "interaction.received", resource: "live_interaction", resourceId: interaction.id, detail: { runId, risk: interaction.risk, decision: interaction.decision } });
    if (interaction.decision === "handoff") await recordAuditEvent(actor, { type: "interaction.handoff_required", resource: "live_interaction", resourceId: interaction.id, detail: { runId, reasons: interaction.reasons.join(";") } });
    return Response.json({ data: interaction }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "interaction_rejected" }, { status: error.status });
    throw error;
  }
}

function isInteractionInput(value: unknown): value is { question: string; source?: string; evidenceIds: string[] } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.question === "string" && input.question.trim().length > 0 && input.question.trim().length <= 1000
    && (input.source === undefined || typeof input.source === "string")
    && Array.isArray(input.evidenceIds) && input.evidenceIds.every((item) => typeof item === "string");
}
