"use client";

import { useState, type FormEvent } from "react";
import { FilePlus2 } from "lucide-react";
import { clientFetch } from "@/lib/client-request";
import type { KnowledgeDocument } from "@/lib/knowledge-base";
import styles from "./knowledge-workspace.module.css";

type Payload = { data?: { document: KnowledgeDocument; created: unknown[] }; error?: string };
type Draft = { title: string; sourceRef: string; body: string };
const emptyDraft: Draft = { title: "", sourceRef: "", body: "" };

export function KnowledgeImportPanel({ documents, onImported }: { documents: KnowledgeDocument[]; onImported: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await clientFetch("/api/v1/knowledge-documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: draft.title, sourceRef: draft.sourceRef, body: draft.body })
      });
      const payload = await response.json().catch(() => null) as Payload | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error ?? "文档导入失败");
      setNotice(`已导入 ${payload.data.created.length} 个待审批片段。`);
      setDraft(emptyDraft);
      await onImported();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "文档导入失败"); }
    finally { setBusy(false); }
  }

  return <section className={styles.editor} aria-label="纯文本文档导入">
    <div className={styles.sectionHead}><h2>导入文档</h2><span>{documents.length} 份</span></div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    <form className={styles.form} onSubmit={submit}>
      <label>标题<input required maxLength={120} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>受控来源引用<input required maxLength={300} placeholder="evidence://source/document-id 或 urn:namespace:id" value={draft.sourceRef} onChange={(event) => setDraft({ ...draft, sourceRef: event.target.value })} /></label>
      <label className={styles.wide}>纯文本正文<textarea rows={6} required value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></label>
      <div className={styles.formActions}><button className={styles.primary} type="submit" disabled={busy || !draft.body.trim()}><FilePlus2 size={15} />{busy ? "导入中" : "导入为待审批条目"}</button><small>{Array.from(draft.body).length} / 50000 字符</small></div>
    </form>
    {documents.length ? <div className={styles.list}>{documents.map((document) => <article className={styles.entry} key={document.id}>
      <div className={styles.entryMain}><div className={styles.entryTitle}><h3>{document.title}</h3><span className={styles.status}>{document.chunkCount} 个片段</span></div><div className={styles.meta} style={{ overflowWrap: "anywhere" }}><span>{document.sourceRef}</span><span>SHA-256 {document.bodySha256}</span><span>{new Date(document.createdAt).toLocaleString()}</span></div></div>
    </article>)}</div> : <div className={styles.empty}>尚无导入文档。</div>}
  </section>;
}
