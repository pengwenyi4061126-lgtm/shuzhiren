"use client";

import { BadgeCheck, ClipboardCheck, Plus, ShieldCheck, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { PolicyProfile } from "@/lib/policy-profiles";

type Draft = {
  name: string;
  version: string;
  terms: string;
  reason: string;
  action: "answer" | "handoff" | "refuse";
  riskLevel: "low" | "medium" | "high";
  evidenceRef: string;
  validationSummary: string;
};

const emptyDraft: Draft = { name: "", version: "", terms: "", reason: "", action: "handoff", riskLevel: "high", evidenceRef: "", validationSummary: "" };

export function PolicyProfileWorkspace({ initialProfiles, canManage, canApprove }: { initialProfiles: PolicyProfile[]; canManage: boolean; canApprove: boolean }) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function request<T>(url: string, init: RequestInit) {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null;
    if (!response.ok || !payload?.data) throw new Error(payload?.error || "策略包操作失败");
    return payload.data;
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError(null);
    try {
      const terms = draft.terms.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
      const rules = terms.length ? [{ id: `custom_${Date.now()}`, terms, reason: draft.reason.trim(), action: draft.action, riskLevel: draft.riskLevel, requiredEvidence: [] }] : [];
      const profile = await request<PolicyProfile>("/api/v1/policy/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: draft.name, version: draft.version, rules, evidenceRef: draft.evidenceRef, validationSummary: draft.validationSummary })
      });
      setProfiles((items) => [profile, ...items]);
      setDraft(emptyDraft);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "策略包登记失败");
    } finally {
      setBusy(null);
    }
  }

  async function approve(id: string) {
    setBusy(id);
    setError(null);
    try {
      const profile = await request<PolicyProfile>(`/api/v1/policy/profiles/${encodeURIComponent(id)}/approve`, { method: "POST" });
      setProfiles((items) => items.map((item) => item.id === id ? profile : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "策略包审批失败");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    const reason = window.prompt("填写撤销原因；已绑定此策略包的场次将不能通过预检或继续自动问答。");
    if (!reason?.trim()) return;
    setBusy(id);
    setError(null);
    try {
      const profile = await request<PolicyProfile>(`/api/v1/policy/profiles/${encodeURIComponent(id)}/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }) });
      setProfiles((items) => items.map((item) => item.id === id ? profile : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "策略包撤销失败");
    } finally {
      setBusy(null);
    }
  }

  return <section className="policy-profiles">
    <header>
      <div><p>版本治理</p><h2>策略包</h2><span>只有已批准策略包会冻结到新的生产场次；规则按关键词匹配并在互动、草稿和播报中生效。</span></div>
      {canManage ? <button type="button" onClick={() => { setError(null); setOpen(true); }}><Plus size={16} />登记策略包</button> : null}
    </header>
    {error ? <p className="catalog-error" role="alert">{error}</p> : null}
    {open ? <form className="policy-profile-form" onSubmit={create}>
      <div className="policy-profile-form-head"><strong>登记候选策略包</strong><button className="icon-button" type="button" aria-label="关闭" onClick={() => setOpen(false)}><X size={16} /></button></div>
      <label>名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={160} /></label>
      <label>版本<input value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })} required maxLength={100} /></label>
      <label className="policy-wide">触发词（逗号分隔，可选）<input value={draft.terms} onChange={(event) => setDraft({ ...draft, terms: event.target.value })} placeholder="例如：虚假宣传，绝对安全" /></label>
      <label className="policy-wide">命中说明<input value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} required={Boolean(draft.terms.trim())} maxLength={300} placeholder={draft.terms.trim() ? "说明命中后的处置原因" : "无触发词时为基线策略包"} /></label>
      <label>处置<select value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value as Draft["action"] })}><option value="handoff">转人工</option><option value="refuse">拒答</option><option value="answer">允许回答</option></select></label>
      <label>风险<select value={draft.riskLevel} onChange={(event) => setDraft({ ...draft, riskLevel: event.target.value as Draft["riskLevel"] })}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
      <label className="policy-wide">验收证据引用<input value={draft.evidenceRef} onChange={(event) => setDraft({ ...draft, evidenceRef: event.target.value })} required maxLength={500} /></label>
      <label className="policy-wide">验收摘要<textarea value={draft.validationSummary} onChange={(event) => setDraft({ ...draft, validationSummary: event.target.value })} required maxLength={2000} /></label>
      <button disabled={busy === "create"} type="submit">{busy === "create" ? "登记中" : "提交待批准策略包"}</button>
    </form> : null}
    <div className="policy-profile-list">
      {profiles.map((profile) => <article key={profile.id}>
        <div><ShieldCheck size={18} /><div><strong>{profile.name} <small>v{profile.version}</small></strong><span>{profile.rules.length ? `${profile.rules.length} 条自定义规则` : "基线策略包"} · {profile.evidenceRef}</span></div></div>
        <div className="policy-profile-actions"><span className={`policy-profile-status ${profile.approval}`}>{profile.approval === "approved" ? <BadgeCheck size={14} /> : <ClipboardCheck size={14} />}{profile.approval === "approved" ? "已批准" : profile.approval === "pending" ? "待批准" : "已撤销"}</span>{canApprove && profile.approval === "pending" ? <button type="button" disabled={busy === profile.id} onClick={() => approve(profile.id)}>{busy === profile.id ? "处理中" : "批准"}</button> : null}{canApprove && profile.approval === "approved" ? <button className="policy-revoke" type="button" disabled={busy === profile.id} onClick={() => revoke(profile.id)}>{busy === profile.id ? "处理中" : "撤销"}</button> : null}</div>
      </article>)}
      {!profiles.length ? <div className="policy-profile-empty">尚无策略包；生产场次无法冻结互动策略。</div> : null}
    </div>
  </section>;
}
