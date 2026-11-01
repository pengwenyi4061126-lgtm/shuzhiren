export type PolicyDecision = {
  action: "answer" | "handoff" | "refuse";
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  requiredEvidence: string[];
};

const rules = [
  { pattern: /治愈|治疗|药效|疾病|医疗|处方/i, reason: "医疗或功效承诺", action: "handoff" as const, riskLevel: "high" as const, evidence: ["regulated_claim_approval"] },
  { pattern: /最低价|全网最低|保价|永久有效/i, reason: "价格或营销承诺", action: "handoff" as const, riskLevel: "high" as const, evidence: ["price_policy"] },
  { pattern: /退款|投诉|假货|维权|举报/i, reason: "售后或投诉处理", action: "handoff" as const, riskLevel: "high" as const, evidence: ["after_sales_policy"] },
  { pattern: /孕妇|婴儿|敏感肌|过敏/i, reason: "特殊人群适用性", action: "handoff" as const, riskLevel: "high" as const, evidence: ["safety_approval"] },
  { pattern: /赠品|库存|规格|发货|到手价/i, reason: "需要读取实时商品事实", action: "answer" as const, riskLevel: "medium" as const, evidence: ["product_version"] }
];

export function evaluatePolicy(question: string, evidenceIds: string[]): PolicyDecision {
  const matched = rules.filter((rule) => rule.pattern.test(question));
  if (matched.length === 0) return { action: "answer", riskLevel: "low", reasons: [], requiredEvidence: ["product_version"] };

  const requiredEvidence = [...new Set(matched.flatMap((rule) => rule.evidence))];
  const missingEvidence = requiredEvidence.filter((evidence) => !evidenceIds.includes(evidence));
  const highest = matched.find((rule) => rule.riskLevel === "high") ?? matched[0];
  if (missingEvidence.length > 0) return { action: "handoff", riskLevel: "high", reasons: [...matched.map((rule) => rule.reason), "缺少必要证据"], requiredEvidence };
  return { action: highest.action, riskLevel: highest.riskLevel, reasons: matched.map((rule) => rule.reason), requiredEvidence };
}
