import { createHash } from "node:crypto";
import { recordAuditEvent } from "@/lib/audit";
import { findApprovedProductVersion, findProductIdForVersion } from "@/lib/catalog";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { policyRulesForRun } from "@/lib/policy-profiles";
import { isControlledPolicyQuestion } from "@/lib/policy-engine";
import { readBoundedJson } from "@/lib/bounded-json";
import { createGroundedResponseDraft } from "@/lib/response-draft";
import { runLexiconForContext } from "@/lib/prohibited-terms";
import { knowledgeHitsForRun } from "@/lib/knowledge-base";
import { listInteractions } from "@/lib/interactions";

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
  const productId = await findProductIdForVersion(actor, run.productVersionId);
  const question = body.question.trim();
  const requestedInteractionIds = body.interactionIds ?? [];
  const [policyRules, lexicon, hits, interactions] = await Promise.all([
    policyRulesForRun(actor, run.id),
    runLexiconForContext(actor, run.id, run.revisionId),
    knowledgeHitsForRun(actor, run.id, question, productId),
    requestedInteractionIds.length ? listInteractions(actor, run.id) : Promise.resolve([])
  ]);
  const interactionIds = requestedInteractionIds.filter((id) => interactions.some((interaction) => interaction.id === id));
  if (interactionIds.length !== requestedInteractionIds.length) return Response.json({ error: "interaction_evidence_not_found" }, { status: 400 });
  const draft = createGroundedResponseDraft(question, version, policyRules, lexicon, hits[0], interactionIds);
  await recordAuditEvent(actor, { type: draft.status === "ready" ? "response_draft.created" : "response_draft.handoff_required", resource: "live_run", resourceId: run.id, detail: { productVersionId: version.id, revision: version.revision, knowledgeApprovalId: hits[0]?.approvalId, interactionIds, decision: draft.decision.action, questionSha256: createHash("sha256").update(question).digest("hex") } });
  return Response.json({ data: draft }, { status: draft.status === "ready" ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "response_draft_rejected" }, { status: error.status });
    throw error;
  }
}

function isDraftInput(value: unknown): value is { question: string; interactionIds?: string[] } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.question === "string" && isControlledPolicyQuestion(input.question)
    && (input.interactionIds === undefined || (Array.isArray(input.interactionIds) && input.interactionIds.length <= 20 && input.interactionIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)));
}
