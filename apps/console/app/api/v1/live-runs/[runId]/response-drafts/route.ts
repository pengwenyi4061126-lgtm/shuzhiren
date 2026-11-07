import { createHash } from "node:crypto";
import { recordAuditEvent } from "@/lib/audit";
import { findApprovedProductVersion } from "@/lib/catalog";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { policyRulesForRun } from "@/lib/policy-profiles";
import { isControlledPolicyQuestion } from "@/lib/policy-engine";
import { readBoundedJson } from "@/lib/bounded-json";
import { createGroundedResponseDraft } from "@/lib/response-draft";
import { runLexiconForContext } from "@/lib/prohibited-terms";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/response-drafts">) {
  try {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator"]);
  const body = await readBoundedJson(request);
  if (!isDraftInput(body)) return Response.json({ error: "invalid_question" }, { status: 400 });
  const { runId } = await context.params;
  const run = await getRun(actor, runId);
  if (!run) return Response.json({ error: "not_found" }, { status: 404 });
  if (!run.productVersionId) return Response.json({ error: "approved_product_version_required" }, { status: 409 });
  const version = await findApprovedProductVersion(actor, run.productVersionId);
  if (!version) return Response.json({ error: "approved_product_version_required" }, { status: 409 });
  const [policyRules, lexicon] = await Promise.all([policyRulesForRun(actor, run.id), runLexiconForContext(actor, run.id, run.revisionId)]);
  const draft = createGroundedResponseDraft(body.question.trim(), version, policyRules, lexicon);
  await recordAuditEvent(actor, { type: draft.status === "ready" ? "response_draft.created" : "response_draft.handoff_required", resource: "live_run", resourceId: run.id, detail: { productVersionId: version.id, revision: version.revision, decision: draft.decision.action, questionSha256: createHash("sha256").update(body.question.trim()).digest("hex") } });
  return Response.json({ data: draft }, { status: draft.status === "ready" ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "response_draft_rejected" }, { status: error.status });
    throw error;
  }
}

function isDraftInput(value: unknown): value is { question: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as Record<string, unknown>).question === "string" && isControlledPolicyQuestion((value as Record<string, string>).question);
}
