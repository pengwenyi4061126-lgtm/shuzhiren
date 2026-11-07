"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Archive, BadgeCheck, CircleAlert, ClipboardCheck, Pencil, Plus, Search, X } from "lucide-react";
import { clientFetch } from "@/lib/client-request";
import { ProhibitedTermHints } from "@/components/prohibited-term-hints";
import type { KnowledgeEntry, KnowledgeSearchResult } from "@/lib/knowledge-base";
import styles from "./knowledge-workspace.module.css";

type ProductOption = { id: string; name: string; externalSku: string };
type EntryDraft = { question: string; aliasQuestions: string; answer: string; keywords: string; productId: string };
type ApiPayload<T> = { data?: T; error?: string; detail?: unknown };
type SearchPayload = ApiPayload<KnowledgeSearchResult>;
const emptyDraft: EntryDraft = { question: "", aliasQuestions: "", answer: "", keywords: "", productId: "" };
const statusLabel: Record<KnowledgeEntry["status"], string> = { pending: "待审批", approved: "已批准", retired: "已下线" };
const reasonLabel: Record<KnowledgeSearchResult["reason"], string> = { matched: "唯一命中", below_threshold: "低于阈值", ambiguous: "命中有歧义", no_candidates: "没有候选" };

function lines(value: string) { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }

export function KnowledgeWorkspace({ initialEntries, products, actorId, canManage, canApprove }: {
  initialEntries: KnowledgeEntry[];
  products: ProductOption[];
  actorId: string;
  canManage: boolean;
  canApprove: boolean;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [draft, setDraft] = useState<EntryDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | KnowledgeEntry["status"]>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewQuestion, setPreviewQuestion] = useState("");
  const [previewProductId, setPreviewProductId] = useState("");
  const [minScorePermille, setMinScorePermille] = useState("600");
  const [preview, setPreview] = useState<KnowledgeSearchResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const visibleEntries = useMemo(() => entries.filter((entry) =>
    (filter === "all" || entry.status === filter)
    && (!query.trim() || `${entry.question}\n${entry.aliasQuestions.join("\n")}\n${entry.keywords.join("\n")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  ), [entries, filter, query]);

  async function reload() {
    const response = await clientFetch("/api/v1/knowledge-entries", { cache: "no-store" });
    const payload = await response.json().catch(() => null) as ApiPayload<KnowledgeEntry[]> | null;
    if (!response.ok || !Array.isArray(payload?.data)) throw new Error(payload?.error ?? "知识条目读取失败");
    setEntries(payload.data);
  }

  function startEdit(entry: KnowledgeEntry) {
    setEditingId(entry.id);
    setDraft({ question: entry.question, aliasQuestions: entry.aliasQuestions.join("\n"), answer: entry.answer, keywords: entry.keywords.join("\n"), productId: entry.productId ?? "" });
    setError(null);
    setNotice(null);
  }

  function clearDraft() {
    setEditingId(null);
    setDraft(emptyDraft);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save"); setError(null); setNotice(null);
    const body = {
      kind: "faq",
      question: draft.question.trim(),
      aliasQuestions: lines(draft.aliasQuestions),
      answer: draft.answer.trim(),
      keywords: lines(draft.keywords),
      ...(draft.productId ? { productId: draft.productId } : {})
    };
    try {
      const response = await clientFetch(editingId ? `/api/v1/knowledge-entries/${encodeURIComponent(editingId)}` : "/api/v1/knowledge-entries", {
        method: editingId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => null) as ApiPayload<KnowledgeEntry> | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error ?? "条目保存失败");
      await reload();
      setNotice(editingId ? "条目已更新；内容变更后需重新审批。" : "条目已创建，批准后生效。");
      clearDraft();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "条目保存失败"); }
    finally { setBusy(null); }
  }

  async function mutate(entry: KnowledgeEntry, action: "approve" | "retire") {
    const key = `${action}:${entry.id}`;
    setBusy(key); setError(null); setNotice(null);
    try {
      const response = await clientFetch(action === "approve"
        ? `/api/v1/knowledge-entries/${encodeURIComponent(entry.id)}/approve`
        : `/api/v1/knowledge-entries/${encodeURIComponent(entry.id)}`, { method: action === "approve" ? "POST" : "DELETE" });
      const payload = await response.json().catch(() => null) as ApiPayload<KnowledgeEntry> | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error ?? "条目操作失败");
      await reload();
      setNotice(action === "approve" ? "条目已批准并生效。" : "条目已下线。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "条目操作失败"); }
    finally { setBusy(null); }
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("preview"); setPreviewError(null); setPreview(null);
    try {
      const response = await clientFetch("/api/v1/knowledge-entries/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: previewQuestion.trim(), minScorePermille: Number(minScorePermille), ...(previewProductId ? { productId: previewProductId } : {}) })
      });
      const payload = await response.json().catch(() => null) as SearchPayload | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error ?? "检索预览失败");
      setPreview(payload.data);
    } catch (cause) { setPreviewError(cause instanceof Error ? cause.message : "检索预览失败"); }
    finally { setBusy(null); }
  }

  return <main className={styles.page}>
    <header className={styles.header}>
      <div><p>治理配置</p><h1>知识库</h1></div>
      <div className={styles.summary}><span>{entries.length} 条</span><span>{entries.filter((entry) => entry.status === "approved").length} 条已批准</span></div>
    </header>
    {error ? <p className={styles.error} role="alert"><CircleAlert size={15} />{error}</p> : null}
    {notice ? <p className={styles.notice} role="status"><BadgeCheck size={15} />{notice}</p> : null}

    {canManage ? <section className={styles.editor} aria-label={editingId ? "编辑知识条目" : "新建知识条目"}>
      <div className={styles.sectionHead}><h2>{editingId ? "编辑条目" : "新建条目"}</h2>{editingId ? <button className={styles.iconButton} type="button" aria-label="取消编辑" title="取消编辑" onClick={clearDraft}><X size={16} /></button> : null}</div>
      <form className={styles.form} onSubmit={save}>
        <label className={styles.wide}>问题<textarea rows={2} maxLength={200} required value={draft.question} onChange={(event) => setDraft({ ...draft, question: event.target.value })} /><ProhibitedTermHints text={draft.question} context="faq" onChange={(question) => setDraft({ ...draft, question })} /></label>
        <label>别名问题（每行一条）<textarea rows={3} value={draft.aliasQuestions} onChange={(event) => setDraft({ ...draft, aliasQuestions: event.target.value })} /><ProhibitedTermHints text={draft.aliasQuestions} context="faq" onChange={(aliasQuestions) => setDraft({ ...draft, aliasQuestions })} /></label>
        <label>答案<textarea rows={4} maxLength={300} required value={draft.answer} onChange={(event) => setDraft({ ...draft, answer: event.target.value })} /><ProhibitedTermHints text={draft.answer} context="faq" onChange={(answer) => setDraft({ ...draft, answer })} /></label>
        <label>关键词（每行一条）<textarea rows={3} value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} /><small>至少填写一个可检索关键词。</small></label>
        <label>关联商品<select value={draft.productId} onChange={(event) => setDraft({ ...draft, productId: event.target.value })}><option value="">全部商品</option>{products.map((product) => <option value={product.id} key={product.id}>{product.name} · {product.externalSku}</option>)}</select></label>
        <div className={styles.formActions}><button className={styles.primary} type="submit" disabled={busy === "save"}>{busy === "save" ? "保存中" : editingId ? "保存修改" : <><Plus size={15} />创建待审批条目</>}</button>{editingId ? <button className={styles.secondary} type="button" onClick={clearDraft}>取消</button> : null}</div>
      </form>
    </section> : null}

    <section className={styles.entries} aria-label="知识条目">
      <div className={styles.sectionHead}>
        <h2>条目</h2>
        <div className={styles.filters}>
          <label className={styles.search}><Search size={15} /><input aria-label="搜索知识条目" placeholder="搜索问题或关键词" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <select aria-label="按状态筛选" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">全部状态</option><option value="pending">待审批</option><option value="approved">已批准</option><option value="retired">已下线</option></select>
        </div>
      </div>
      {visibleEntries.length ? <div className={styles.list}>{visibleEntries.map((entry) => {
        const selfApproval = entry.status === "pending" && entry.updatedBy === actorId;
        const product = products.find((item) => item.id === entry.productId);
        return <article className={styles.entry} key={entry.id}>
          <div className={styles.entryMain}>
            <div className={styles.entryTitle}><h3>{entry.question}</h3><span className={`${styles.status} ${entry.status === "approved" ? styles.approved : entry.status === "retired" ? styles.retired : ""}`}>{entry.status === "approved" ? <BadgeCheck size={13} /> : <ClipboardCheck size={13} />}{statusLabel[entry.status]}</span></div>
            <p className={styles.answer}>{entry.answer}</p>
            <div className={styles.meta}><span>修订 {entry.revision}</span><span>{product ? `${product.name} · ${product.externalSku}` : "全部商品"}</span>{entry.aliasQuestions.length ? <span>别名：{entry.aliasQuestions.join("、")}</span> : null}{entry.keywords.length ? <span>关键词：{entry.keywords.join("、")}</span> : null}</div>
          </div>
          <div className={styles.actions}>
            {canApprove && entry.status === "pending" ? <div className={styles.approvalAction}><button className={styles.secondary} type="button" disabled={Boolean(busy) || selfApproval} onClick={() => void mutate(entry, "approve")}>{busy === `approve:${entry.id}` ? "批准中" : "批准"}</button>{selfApproval ? <small>最后修改人不能批准此条目</small> : null}</div> : null}
            {canManage && entry.status !== "retired" ? <button className={styles.iconButton} type="button" aria-label="编辑条目" title="编辑条目" disabled={Boolean(busy)} onClick={() => startEdit(entry)}><Pencil size={15} /></button> : null}
            {canManage && entry.status !== "retired" ? <button className={styles.iconButton} type="button" aria-label="下线条目" title="下线条目" disabled={Boolean(busy)} onClick={() => void mutate(entry, "retire")}><Archive size={15} /></button> : null}
          </div>
        </article>;
      })}</div> : <div className={styles.empty}>没有符合筛选条件的条目。</div>}
    </section>

    <section className={styles.preview} aria-label="知识检索预览">
      <div className={styles.sectionHead}><h2>检索预览</h2></div>
      <form className={styles.previewForm} onSubmit={search}>
        <label className={styles.previewQuestion}>问题<textarea rows={2} maxLength={500} required value={previewQuestion} onChange={(event) => setPreviewQuestion(event.target.value)} /></label>
        <label>商品<select value={previewProductId} onChange={(event) => setPreviewProductId(event.target.value)}><option value="">全部商品</option>{products.map((product) => <option value={product.id} key={product.id}>{product.name} · {product.externalSku}</option>)}</select></label>
        <label>最低分数<input type="number" min={300} max={1000} step={1} required value={minScorePermille} onChange={(event) => setMinScorePermille(event.target.value)} /></label>
        <button className={styles.primary} type="submit" disabled={busy === "preview" || !previewQuestion.trim()}><Search size={14} />{busy === "preview" ? "检索中" : "检索"}</button>
      </form>
      {previewError ? <p className={styles.error} role="alert">{previewError}</p> : null}
      {preview ? <div className={styles.previewResult}>
        <div className={styles.previewStatus}><strong>{reasonLabel[preview.reason]}</strong><span>{preview.hit ? `${preview.hit.scorePermille} / 1000` : `${preview.candidates.length} 个候选`}</span></div>
        {preview.hit ? <article><h3>{preview.hit.question}</h3><p>{preview.hit.answer}</p><small>修订 {preview.hit.revision} · 关键词命中 {preview.hit.keywordHits} · 批准快照 {preview.hit.approvalId.slice(0, 8)}</small></article> : null}
        {preview.reason === "ambiguous" ? <ul>{preview.candidates.slice(0, 5).map((candidate) => <li key={candidate.entryId}>{candidate.question}<span>{candidate.scorePermille} / 1000</span></li>)}</ul> : null}
      </div> : null}
    </section>
  </main>;
}
