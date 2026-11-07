import type { ProductVersion } from "@/lib/catalog";
import { evaluatePolicy, type PolicyDecision, type PolicyRule } from "@/lib/policy-engine";
import { guardBroadcastText } from "@/lib/shared/broadcast-guard.mjs";
import type { Finding, LexiconTerm } from "@/lib/shared/prohibited-terms.mjs";
import type { KnowledgeEvidence, KnowledgeHit } from "@/lib/knowledge-base";

export type ResponseDraft = {
  status: "ready" | "handoff";
  text?: string;
  decision: PolicyDecision;
  evidence: ({ type: "interaction_evidence"; ids: string[] } | KnowledgeEvidence | { type: "product_version"; id: string; revision: number })[];
  blockedByLexicon?: boolean;
  findings?: Finding[];
};

export function createGroundedResponseDraft(question: string, version: ProductVersion, policyRules: PolicyRule[] = [], lexicon: readonly LexiconTerm[] = [], knowledgeHit?: KnowledgeHit, interactionIds: string[] = []): ResponseDraft {
  const decision = evaluatePolicy(question, ["product_version", ...(knowledgeHit ? ["knowledge_entry"] : [])], policyRules);
  const evidence: ResponseDraft["evidence"] = [
    ...(interactionIds.length ? [{ type: "interaction_evidence" as const, ids: interactionIds }] : []),
    ...(knowledgeHit ? [{ type: "knowledge_entry" as const, approvalId: knowledgeHit.approvalId, entryId: knowledgeHit.entryId, revision: knowledgeHit.revision, answerSha256: knowledgeHit.answerSha256, scorePermille: knowledgeHit.scorePermille }] : []),
    { type: "product_version", id: version.id, revision: version.revision }
  ];
  const guardedQuestion = guardBroadcastText(question, { policyRules, lexicon, maxLength: 500 });
  if (decision.action !== "answer" || !guardedQuestion.allowed) return { status: "handoff", decision: guardedQuestion.allowed ? decision : guardedQuestion.decision, evidence, ...(guardedQuestion.findings.some((finding) => finding.severity === "block") ? { blockedByLexicon: true, findings: guardedQuestion.findings } : {}) };

  const facts = version.facts;
  const faq = (matcher: RegExp) => facts.faq.find((item) => matcher.test(item));
  let text: string;
  if (knowledgeHit) text = knowledgeHit.answer;
  else if (/赠品/.test(question)) text = faq(/赠/) ?? "当前已批准商品资料未包含赠品说明，请由场控确认后回复。";
  else if (/库存/.test(question)) text = `当前商品事实版本显示库存为 ${facts.stock} 件，实际库存以平台结算页为准。`;
  else if (/价格|到手价/.test(question)) text = `当前已批准商品价格为 ¥${(facts.priceCent / 100).toFixed(2)}；活动优惠和最终到手价请以平台结算页为准。`;
  else if (/发货/.test(question)) text = faq(/发货/) ?? "当前已批准商品资料未包含发货时效说明，请由场控确认后回复。";
  else if (/规格|成分|特点|卖点/.test(question)) text = facts.highlights.length ? `这款商品的已批准卖点包括：${facts.highlights.join("、")}。` : "当前已批准商品资料未包含可播报卖点。";
  else text = facts.faq[0] ?? (facts.highlights.length ? `商品已批准卖点包括：${facts.highlights.join("、")}。` : "当前商品资料不足，需要场控补充后回复。");
  const guarded = guardBroadcastText(text, { policyRules, lexicon, maxLength: 800 });
  if (!guarded.allowed) return { status: "handoff", decision: guarded.decision, evidence, ...(guarded.findings.some((finding) => finding.severity === "block") ? { blockedByLexicon: true, findings: guarded.findings } : {}) };
  return { status: "ready", text, decision, evidence, ...(guarded.findings.length ? { findings: guarded.findings } : {}) };
}
