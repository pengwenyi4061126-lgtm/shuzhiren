import { createHash } from "node:crypto";
import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { evaluatePolicy, isControlledPolicyQuestion } from "@/lib/policy-engine";
import { readBoundedJson } from "@/lib/bounded-json";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "operator", "reviewer"]);
  let body: unknown;
  try { body = await readBoundedJson(request); }
  catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
  if (!isPolicyInput(body)) return Response.json({ error: "invalid_input" }, { status: 400 });
  const decision = evaluatePolicy(body.question, body.evidenceIds);
  await recordAuditEvent(context, { type: "policy.evaluated", resource: "policy_evaluation", resourceId: `policy-evaluation:${crypto.randomUUID()}`, detail: { questionSha256: createHash("sha256").update(body.question).digest("hex"), action: decision.action, riskLevel: decision.riskLevel, reasons: decision.reasons.join(";"), requiredEvidence: decision.requiredEvidence.join(";"), evidenceIds: body.evidenceIds.join(";") } });
  return Response.json({ data: decision });
}

function isPolicyInput(value: unknown): value is { question: string; evidenceIds: string[] } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.question === "string" && isControlledPolicyQuestion(input.question) && Array.isArray(input.evidenceIds) && input.evidenceIds.every((item) => typeof item === "string");
}
