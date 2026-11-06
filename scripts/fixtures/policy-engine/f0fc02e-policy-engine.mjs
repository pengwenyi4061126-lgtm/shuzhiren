// Reference copy of apps/console/lib/policy-engine.ts as committed in f0fc02e (the console implementation before the
// console and the runtime worker shared one policy engine). Used only by scripts/check-policy-redteam.mjs to check that
// apps/console/lib/shared/policy-engine.mjs decides exactly as that implementation did (Property 4). Product code must not
// import this file. Generated, do not edit. Regenerate with:
//   git show f0fc02e:apps/console/lib/policy-engine.ts | node --input-type=module -e "import ts from 'typescript'; let s=''; for await (const c of process.stdin) s+=c; process.stdout.write(ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText)"
// (the file body below is that output, preceded by this header.)
export const maxPolicyQuestionLength = 1000;
const rules = [
    { pattern: /忽略.{0,24}(指令|规则)|系统提示|提示词|开发者消息|越狱|jailbreak|角色扮演|不受限制|ignore.{0,32}(previous|all|system).{0,32}(instruction|rule)|systemprompt|developermessage|doanythingnow/i, reason: "提示注入或策略绕过尝试", action: "refuse", riskLevel: "high", evidence: [] },
    { pattern: /密钥|密码|token|api[ _-]?key|RTMP|推流码|数据库|连接串|secret|credential|connectionstring|databaseurl|streamkey/i, reason: "索取系统凭据或内部信息", action: "refuse", riskLevel: "high", evidence: [] },
    { pattern: /改价|降价|设置.{0,12}价格|修改.{0,12}(库存|价格)|change.{0,24}(price|inventory)|set.{0,24}price/i, reason: "价格或库存修改请求", action: "handoff", riskLevel: "high", evidence: ["price_policy"] },
    { pattern: /治愈|治疗|药效|疾病|医疗|处方|cure|treat(ment)?|prescription|medicalclaim/i, reason: "医疗或功效承诺", action: "handoff", riskLevel: "high", evidence: ["regulated_claim_approval"] },
    { pattern: /最低价|全网最低|保价|永久有效/i, reason: "价格或营销承诺", action: "handoff", riskLevel: "high", evidence: ["price_policy"] },
    { pattern: /退款|投诉|假货|维权|举报/i, reason: "售后或投诉处理", action: "handoff", riskLevel: "high", evidence: ["after_sales_policy"] },
    { pattern: /孕妇|婴儿|敏感肌|过敏|pregnan(t|cy)|infant|baby|sensitive.?skin|allerg/i, reason: "特殊人群适用性", action: "handoff", riskLevel: "high", evidence: ["safety_approval"] },
    { pattern: /赠品|库存|规格|发货|到手价/i, reason: "需要读取实时商品事实", action: "answer", riskLevel: "medium", evidence: ["product_version"] }
];
export function evaluatePolicy(question, evidenceIds, additionalRules = []) {
    const normalizedQuestion = normalizePolicyText(question);
    if (normalizedQuestion.length > maxPolicyQuestionLength)
        return { action: "handoff", riskLevel: "high", reasons: ["互动内容超过受控长度限制"], requiredEvidence: [] };
    const matched = [
        ...rules.filter((rule) => rule.pattern.test(normalizedQuestion)).map((rule) => ({ reason: rule.reason, action: rule.action, riskLevel: rule.riskLevel, evidence: rule.evidence })),
        ...additionalRules.filter((rule) => rule.terms.some((term) => normalizedQuestion.includes(normalizePolicyText(term)))).map((rule) => ({ reason: rule.reason, action: rule.action, riskLevel: rule.riskLevel, evidence: rule.requiredEvidence }))
    ];
    if (matched.length === 0)
        return { action: "answer", riskLevel: "low", reasons: [], requiredEvidence: ["product_version"] };
    const requiredEvidence = [...new Set(matched.flatMap((rule) => rule.evidence))];
    const missingEvidence = requiredEvidence.filter((evidence) => !evidenceIds.includes(evidence));
    const highest = matched.find((rule) => rule.riskLevel === "high") ?? matched[0];
    if (missingEvidence.length > 0)
        return { action: "handoff", riskLevel: "high", reasons: [...matched.map((rule) => rule.reason), "缺少必要证据"], requiredEvidence };
    return { action: highest.action, riskLevel: highest.riskLevel, reasons: matched.map((rule) => rule.reason), requiredEvidence };
}
export function isControlledPolicyQuestion(question) {
    const trimmed = question.trim();
    return trimmed.length > 0 && trimmed.length <= maxPolicyQuestionLength;
}
function normalizePolicyText(text) {
    return text.normalize("NFKC").replace(/[\s\u200B-\u200D\uFEFF]+/g, "").toLocaleLowerCase("zh-CN");
}
