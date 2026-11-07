"use client";

import { useMemo, useState, type FormEvent } from "react";
import { BookOpen, Plus, ShieldAlert } from "lucide-react";
import { clientFetch } from "@/lib/client-request";
import type { listProhibitedTerms } from "@/lib/prohibited-terms";

type ListedData = Awaited<ReturnType<typeof listProhibitedTerms>>;
type TenantTerm = { id: string; kind: "custom" | "builtin_override"; builtinTermId?: string | null; builtin_term_id?: string | null; term?: string | null; category?: string | null; approvedRevision?: number | null; approved_revision?: number | null; severity?: string | null; disabled?: boolean; active?: boolean; revisions: Array<{ revision: number; status: string; loosening: boolean; reason?: string | null }> };
type Data = Omit<ListedData, "tenantTerms"> & { tenantTerms: TenantTerm[] };
type ApiPayload = { data?: Data | TenantTerm; error?: string };
const categoryLabel = { extreme: "绝对化", medical: "医疗", false_claim: "不实宣称", offsite_trade: "站外交易", custom: "租户自定义" } as const;

export function ProhibitedTermsWorkspace({ initialData, canManage, canApprove }: { initialData: Data; canManage: boolean; canApprove: boolean }) {
  const [data, setData] = useState(initialData);
  const [term, setTerm] = useState("");
  const [suggestions, setSuggestions] = useState("");
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const overrides = useMemo(() => new Map(data.tenantTerms.filter((row) => row.kind === "builtin_override" && (row.builtinTermId ?? row.builtin_term_id)).map((row) => [row.builtinTermId ?? row.builtin_term_id!, row])), [data.tenantTerms]);

  async function reload() {
    const response = await clientFetch("/api/v1/prohibited-terms");
    const payload = await response.json().catch(() => null) as ApiPayload | null;
    if (!response.ok || !payload?.data || !("effectiveLexicon" in payload.data)) throw new Error(payload?.error ?? "词库读取失败");
    setData(payload.data);
  }

  async function request(key: string, url: string, method: string, body?: unknown, success = "变更已提交"): Promise<boolean> {
    setBusy(key); setError(null); setNotice(null);
    try {
      const response = await clientFetch(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      const payload = await response.json().catch(() => null) as ApiPayload | null;
      if (!response.ok) throw new Error(payload?.error ?? "词库操作失败");
      await reload();
      setNotice(success);
      setReasonById((current) => ({ ...current, [key]: "" }));
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "词库操作失败"); return false; }
    finally { setBusy(null); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await request("create", "/api/v1/prohibited-terms", "POST", { term: term.trim(), suggestions: suggestions.split("\n").map((value) => value.trim()).filter(Boolean) }, "自定义词已提交，批准后生效")) {
      setTerm(""); setSuggestions("");
    }
  }

  function reasonInput(id: string) {
    return <input aria-label="放宽变更原因" value={reasonById[id] ?? ""} maxLength={500} placeholder="放宽变更原因（10–500 字）" onChange={(event) => setReasonById((current) => ({ ...current, [id]: event.target.value }))} />;
  }

  function termActions(row: TenantTerm) {
    const pending = row.revisions.find((revision) => revision.status === "pending");
    const reason = reasonById[row.id] ?? "";
    const needsReason = canManage && row.kind === "custom" && row.active;
    return <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {canApprove && pending ? <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void request(row.id, `/api/v1/prohibited-terms/${encodeURIComponent(row.id)}/approve`, "POST", undefined, "修订已批准并生效")}>{busy === row.id ? "处理中" : "批准修订"}</button> : null}
      {needsReason ? reasonInput(row.id) : null}
      {canManage && row.kind === "custom" && row.active ? <button type="button" className="button" disabled={Boolean(busy) || reason.trim().length < 10} onClick={() => void request(row.id, `/api/v1/prohibited-terms/${encodeURIComponent(row.id)}`, "DELETE", { reason }, "下线申请已提交，复核后生效")}>申请下线</button> : null}
      {canManage && row.kind === "custom" && row.severity === "block" && row.active ? <button type="button" className="button" disabled={Boolean(busy) || reason.trim().length < 10} onClick={() => void request(row.id, `/api/v1/prohibited-terms/${encodeURIComponent(row.id)}`, "PUT", { severity: "warn", reason }, "级别变更已提交，复核后生效")}>申请改为提示</button> : null}
      {canManage && row.kind === "custom" && !row.active ? <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void request(row.id, `/api/v1/prohibited-terms/${encodeURIComponent(row.id)}`, "PUT", { active: true }, "启用申请已提交，批准后生效")}>申请启用</button> : null}
    </div>;
  }

  return <main className="catalog-page">
    <header className="catalog-header"><div><p>治理配置</p><h1>违禁词库</h1><span>示例词表，未经法务审定</span></div>{canManage ? <span>{data.effectiveLexicon.length} 个当前生效词条</span> : null}</header>
    {error ? <p className="catalog-error" role="alert">{error}</p> : null}
    {notice ? <p className="catalog-notice" role="status">{notice}</p> : null}
    {canManage ? <section className="catalog-form" aria-label="新增自定义词"><form onSubmit={create}>
      <label>自定义词<input value={term} onChange={(event) => setTerm(event.target.value)} maxLength={30} required /></label>
      <label>替换建议（每行一条）<textarea value={suggestions} onChange={(event) => setSuggestions(event.target.value)} rows={2} /></label>
      <button type="submit" disabled={Boolean(busy) || !term.trim()}><Plus size={15} />{busy === "create" ? "提交中" : "提交申请"}</button>
    </form></section> : null}
    <section style={{ marginTop: 22 }}>
      <div className="catalog-row catalog-labels" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,140px),1fr))" }}><span>内置示例词</span><span>类别</span><span>级别</span><span>租户覆盖</span></div>
      <div className="catalog-table">{data.builtinTerms.map((entry) => {
        const override = overrides.get(entry.id);
        const active = !override?.disabled;
        return <article key={entry.id} className="catalog-row" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,140px),1fr))" }}>
          <strong>{entry.term}</strong><span>{categoryLabel[entry.category]}</span><span>{(override?.severity ?? entry.severity) === "block" ? "拦截" : "提示"}</span>
          <span>{override ? (active ? "已覆盖" : "已停用") : "默认"}</span>
          {canManage ? <div className="catalog-actions">{reasonInput(entry.id)}<button className="button" type="button" disabled={Boolean(busy) || (active && (reasonById[entry.id] ?? "").trim().length < 10)} onClick={() => void request(entry.id, `/api/v1/prohibited-terms/builtin/${encodeURIComponent(entry.id)}/override`, "PUT", { disabled: active, ...(active ? { reason: reasonById[entry.id] } : {}) }, "内置词覆盖已提交，批准后生效")}>{active ? "申请停用" : "申请启用"}</button>{override ? termActions(override) : null}</div> : null}
        </article>;
      })}</div>
    </section>
    <section style={{ marginTop: 22 }}>
      <div className="catalog-row catalog-labels" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,140px),1fr))" }}><span>租户词条</span><span>类别</span><span>级别</span><span>生效状态</span><span>修订与操作</span></div>
      <div className="catalog-table">{data.tenantTerms.map((row) => <article key={row.id} className="catalog-row" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,140px),1fr))", minHeight: "auto", paddingTop: 12, paddingBottom: 12 }}>
        <strong>{row.kind === "custom" ? row.term : row.builtinTermId ?? row.builtin_term_id}</strong><span>{categoryLabel[(row.category ?? "custom") as keyof typeof categoryLabel] ?? row.category}</span><span>{row.severity === "block" ? "拦截" : row.severity === "warn" ? "提示" : "—"}</span><span>{(row.approvedRevision ?? row.approved_revision) == null ? "待首次批准" : row.active && !row.disabled ? "生效中" : "已停用"}</span>
        <div style={{ display: "grid", gap: 7 }}><small>{row.revisions.map((revision) => `#${revision.revision} ${revision.status}${revision.loosening ? " · 放宽" : ""}`).join(" / ") || "暂无修订"}</small>{row.revisions.at(-1)?.reason ? <small>{row.revisions.at(-1)?.reason}</small> : null}{termActions(row)}</div>
      </article>)}{!data.tenantTerms.length ? <p className="catalog-version-empty">暂无租户词条。</p> : null}</div>
    </section>
    <section className="policy-panel" style={{ marginTop: 22 }}>
      <div className="policy-panel-head"><div><ShieldAlert size={18} /><h2>当前生效词表</h2></div><span>{data.effectiveLexicon.length} 条</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,220px),1fr))", gap: 1, background: "var(--line)" }}>{data.effectiveLexicon.map((entry) => <div key={entry.id} style={{ display: "grid", gap: 4, padding: "10px 12px", background: "var(--surface)", fontSize: 12 }}><strong>{entry.term}</strong><span>{categoryLabel[entry.category]} · {entry.severity === "block" ? "拦截" : "提示"}</span><small>{entry.suggestions.join("、") || "无替换建议"}</small></div>)}</div>
      <small style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", color: "var(--muted)" }}><BookOpen size={14} />版本 {data.builtinVersion} · 当前租户已批准词表与内置示例合并</small>
    </section>
  </main>;
}
