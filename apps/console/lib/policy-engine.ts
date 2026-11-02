export type PolicyDecision = {
  action: "answer" | "handoff" | "refuse";
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  requiredEvidence: string[];
};

export type PolicyRule = { id: string; terms: string[]; reason: string; action: PolicyDecision["action"]; riskLevel: PolicyDecision["riskLevel"]; requiredEvidence: string[] };

export const maxPolicyQuestionLength = 1000;

const rules = [
  { pattern: /忽略.{0,24}(指令|规则)|系统提示|提示词|开发者消息|越狱|jailbreak|角色扮演|不受限制/i, reason: "提示注入或策略绕过尝试", action: "refuse" as const, riskLevel: "high" as const, evidence: [] },
  { pattern: /密钥|密码|token|api[ _-]?key|RTMP|推流码|数据库|连接串/i, reason: "索取系统凭据或内部信息", action: "refuse" as const, riskLevel: "high" as const, evidence: [] },
  { pattern: /改价|降价|设置.{0,12}价格|修改.{0,12}(库存|价格)/i, reason: "价格或库存修改请求", action: "handoff" as const, riskLevel: "high" as const, evidence: ["price_policy"] },
  { pattern: /治愈|治疗|药效|疾病|医疗|处方/i, reason: "医疗或功效承诺", action: "handoff" as const, riskLevel: "high" as const, evidence: ["regulated_claim_approval"] },
  { pattern: /最低价|全网最低|保价|永久有效/i, reason: "价格或营销承诺", action: "handoff" as const, riskLevel: "high" as const, evidence: ["price_policy"] },
  { pattern: /退款|投诉|假货|维权|举报/i, reason: "售后或投诉处理", action: "handoff" as const, riskLevel: "high" as const, evidence: ["after_sales_policy"] },
  { pattern: /孕妇|婴儿|敏感肌|过敏/i, reason: "特殊人群适用性", action: "handoff" as const, riskLevel: "high" as const, evidence: ["safety_approval"] },
  { pattern: /赠品|库存|规格|发货|到手价/i, reason: "需要读取实时商品事实", action: "answer" as const, riskLevel: "medium" as const, evidence: ["product_version"] }
];

export function evaluatePolicy(question: string, evidenceIds: string[], additionalRules: PolicyRule[] = []): PolicyDecision {
  const normalizedQuestion = normalizePolicyText(question);
  if (normalizedQuestion.length > maxPolicyQuestionLength) return { action: "handoff", riskLevel: "high", reasons: ["互动内容超过受控长度限制"], requiredEvidence: [] };
  const matched = [
    ...rules.filter((rule) => rule.pattern.test(normalizedQuestion)).map((rule) => ({ reason: rule.reason, action: rule.action, riskLevel: rule.riskLevel, evidence: rule.evidence })),
    ...additionalRules.filter((rule) => rule.terms.some((term) => normalizedQuestion.includes(normalizePolicyText(term)))).map((rule) => ({ reason: rule.reason, action: rule.action, riskLevel: rule.riskLevel, evidence: rule.requiredEvidence }))
  ];
  if (matched.length === 0) return { action: "answer", riskLevel: "low", reasons: [], requiredEvidence: ["product_version"] };

  const requiredEvidence = [...new Set(matched.flatMap((rule) => rule.evidence))];
  const missingEvidence = requiredEvidence.filter((evidence) => !evidenceIds.includes(evidence));
  const highest = matched.find((rule) => rule.riskLevel === "high") ?? matched[0];
  if (missingEvidence.length > 0) return { action: "handoff", riskLevel: "high", reasons: [...matched.map((rule) => rule.reason), "缺少必要证据"], requiredEvidence };
  return { action: highest.action, riskLevel: highest.riskLevel, reasons: matched.map((rule) => rule.reason), requiredEvidence };
}

export function isControlledPolicyQuestion(question: string) {
  const trimmed = question.trim();
  return trimmed.length > 0 && trimmed.length <= maxPolicyQuestionLength;
}

function normalizePolicyText(text: string) {
  return text.normalize("NFKC").replace(/[\s\u200B-\u200D\uFEFF]+/g, "").toLocaleLowerCase("zh-CN");
}
