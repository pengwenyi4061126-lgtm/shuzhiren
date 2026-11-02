"use client";

import Link from "next/link";
import { ArrowLeft, BadgeCheck, CircleAlert, ShieldCheck, ShieldQuestion, UserRoundCheck } from "lucide-react";
import { FormEvent, useState } from "react";

type PolicyDecision = {
  action: "answer" | "handoff" | "refuse";
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  requiredEvidence: string[];
};

const evidenceOptions = [
  { id: "product_version", label: "已批准商品事实版本" },
  { id: "regulated_claim_approval", label: "功效/合规声明审批" },
  { id: "price_policy", label: "价格与营销承诺政策" },
  { id: "after_sales_policy", label: "售后与投诉处理政策" },
  { id: "safety_approval", label: "特殊人群安全审批" }
];

const actionMeta = {
  answer: { label: "允许回答", icon: BadgeCheck },
  handoff: { label: "转人工确认", icon: UserRoundCheck },
  refuse: { label: "拒绝回答", icon: CircleAlert }
};

export function PolicyWorkspace() {
  const [question, setQuestion] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>(["product_version"]);
  const [decision, setDecision] = useState<PolicyDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleEvidence(id: string) {
    setEvidenceIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function evaluate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/policy/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question.trim(), evidenceIds })
      });
      const payload = await response.json().catch(() => null) as { data?: PolicyDecision; error?: string } | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error || "策略评估未完成");
      setDecision(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "策略评估未完成");
    } finally {
      setBusy(false);
    }
  }

  const result = decision ? actionMeta[decision.action] : null;
  const ResultIcon = result?.icon ?? ShieldQuestion;
  return <main className="policy-page">
    <header className="policy-header"><div><Link className="back-link" href="/"><ArrowLeft size={16} />返回指挥台</Link><p>知识与策略</p><h1>直播问答判定</h1><span>提问、证据和规则必须在生成播报前一同核验。</span></div></header>
    <div className="policy-grid">
      <section className="policy-panel"><div className="policy-panel-head"><div><ShieldCheck size={18} /><h2>问题与证据</h2></div></div><form onSubmit={evaluate}><label className="policy-question">观众问题<textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：这款敏感肌可以用吗？" required maxLength={500} /></label><fieldset className="policy-evidence"><legend>当前可引用的证据</legend>{evidenceOptions.map((option) => <label key={option.id}><input type="checkbox" checked={evidenceIds.includes(option.id)} onChange={() => toggleEvidence(option.id)} />{option.label}</label>)}</fieldset>{error ? <p className="catalog-error" role="alert">{error}</p> : null}<button className="policy-submit" disabled={busy || !question.trim()} type="submit">{busy ? "核验中" : "执行策略核验"}</button></form></section>
      <section className="policy-panel policy-result" aria-live="polite"><div className="policy-panel-head"><div><ResultIcon size={18} /><h2>判定结果</h2></div>{result ? <span className={`policy-action ${decision?.action}`}>{result.label}</span> : null}</div>{decision && result ? <div className="policy-result-body"><div className={`policy-risk ${decision.riskLevel}`}>风险等级：{decision.riskLevel === "high" ? "高" : decision.riskLevel === "medium" ? "中" : "低"}</div><div><h3>命中规则</h3>{decision.reasons.length ? <ul>{decision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p>未命中高风险规则。</p>}</div><div><h3>必须具备的证据</h3><ul>{decision.requiredEvidence.map((id) => <li key={id}>{evidenceOptions.find((option) => option.id === id)?.label ?? id}{evidenceIds.includes(id) ? <BadgeCheck size={15} aria-label="证据已具备" /> : <CircleAlert size={15} aria-label="证据缺失" />}</li>)}</ul></div></div> : <div className="policy-empty"><ShieldQuestion size={24} />提交一个问题后显示可播报、转人工或拒答结论。</div>}</section>
    </div>
  </main>;
}
