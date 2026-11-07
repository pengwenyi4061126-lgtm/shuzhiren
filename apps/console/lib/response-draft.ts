import type { ProductVersion } from "@/lib/catalog";
import { evaluatePolicy, type PolicyDecision, type PolicyRule } from "@/lib/policy-engine";
import { guardBroadcastText } from "@/lib/shared/broadcast-guard.mjs";
import type { Finding, LexiconTerm } from "@/lib/shared/prohibited-terms.mjs";

export type ResponseDraft = {
  status: "ready" | "handoff";
  text?: string;
  decision: PolicyDecision;
  evidence: { type: "product_version"; id: string; revision: number }[];
  blockedByLexicon?: boolean;
  findings?: Finding[];
};

export function createGroundedResponseDraft(question: string, version: ProductVersion, policyRules: PolicyRule[] = [], lexicon: readonly LexiconTerm[] = []): ResponseDraft {
  const decision = evaluatePolicy(question, ["product_version"], policyRules);
  const evidence = [{ type: "product_version" as const, id: version.id, revision: version.revision }];
  if (decision.action !== "answer") return { status: "handoff", decision, evidence };

  const facts = version.facts;
  const faq = (matcher: RegExp) => facts.faq.find((item) => matcher.test(item));
  let text: string;
  if (/赠品/.test(question)) text = faq(/赠/) ?? "当前已批准商品资料未包含赠品说明，请由场控确认后回复。";
  else if (/库存/.test(question)) text = `当前商品事实版本显示库存为 ${facts.stock} 件，实际库存以平台结算页为准。`;
  else if (/价格|到手价/.test(question)) text = `当前已批准商品价格为 ¥${(facts.priceCent / 100).toFixed(2)}；活动优惠和最终到手价请以平台结算页为准。`;
  else if (/发货/.test(question)) text = faq(/发货/) ?? "当前已批准商品资料未包含发货时效说明，请由场控确认后回复。";
  else if (/规格|成分|特点|卖点/.test(question)) text = facts.highlights.length ? `这款商品的已批准卖点包括：${facts.highlights.join("、")}。` : "当前已批准商品资料未包含可播报卖点。";
  else text = facts.faq[0] ?? (facts.highlights.length ? `商品已批准卖点包括：${facts.highlights.join("、")}。` : "当前商品资料不足，需要场控补充后回复。");
  const guarded = guardBroadcastText(text, { policyRules, lexicon, maxLength: 800 });
  if (!guarded.allowed) return { status: "handoff", decision: guarded.decision, evidence, ...(guarded.findings.some((finding) => finding.severity === "block") ? { blockedByLexicon: true, findings: guarded.findings } : {}) };
  return { status: "ready", text, decision, evidence, ...(guarded.findings.length ? { findings: guarded.findings } : {}) };
}
