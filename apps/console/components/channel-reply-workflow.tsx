"use client";

import { Send, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { clientFetch } from "@/lib/client-request";
import type { ChannelReplyDraft } from "@/lib/channel-replies";
import type { LiveInteraction } from "@/lib/interactions";
import { ProhibitedTermHints } from "@/components/prohibited-term-hints";

type Props = { runId: string; canOperate: boolean; canReview: boolean };

export function ChannelReplyWorkflow({ runId, canOperate, canReview }: Props) {
  const [interactions, setInteractions] = useState<LiveInteraction[]>([]);
  const [drafts, setDrafts] = useState<ChannelReplyDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channelInteractions = useMemo(() => interactions.filter((item) => Boolean(item.channelConnectionId)), [interactions]);
  const selected = channelInteractions.find((item) => item.id === selectedId) ?? channelInteractions[0] ?? null;
  const draft = selected ? drafts.find((item) => item.interactionId === selected.id) : undefined;

  useEffect(() => {
    let active = true;
    const load = async () => {
      const encoded = encodeURIComponent(runId);
      const [interactionResponse, draftResponse] = await Promise.all([clientFetch(`/api/v1/live-runs/${encoded}/interactions`), clientFetch(`/api/v1/live-runs/${encoded}/reply-drafts`)]);
      const interactionPayload = await interactionResponse.json().catch(() => null) as { data?: LiveInteraction[] } | null;
      const draftPayload = await draftResponse.json().catch(() => null) as { data?: ChannelReplyDraft[] } | null;
      if (!active) return;
      if (interactionResponse.ok && interactionPayload?.data) setInteractions(interactionPayload.data);
      if (draftResponse.ok && draftPayload?.data) setDrafts(draftPayload.data);
    };
    void load().catch(() => undefined);
    const timer = window.setInterval(() => void load().catch(() => undefined), 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [runId]);

  useEffect(() => { setBody(draft?.body ?? ""); setRejectionReason(""); }, [draft?.body, draft?.id, selected?.id]);

  async function request(path: string, init: RequestInit = {}) {
    setBusy(path); setError(null);
    try {
      const response = await clientFetch(`/api/v1/live-runs/${encodeURIComponent(runId)}/reply-drafts${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
      const payload = await response.json().catch(() => null) as { data?: ChannelReplyDraft; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "渠道回复操作失败");
      if (payload?.data) setDrafts((items) => [payload.data!, ...items.filter((item) => item.id !== payload.data!.id)]);
      return payload?.data;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "渠道回复操作失败"); return undefined; } finally { setBusy(null); }
  }

  async function createDraft() {
    if (!selected || !body.trim()) return;
    await request("", { method: "POST", body: JSON.stringify({ interactionId: selected.id, channelConnectionId: selected.channelConnectionId, body }) });
  }

  async function saveDraft() { if (draft) await request(`/${encodeURIComponent(draft.id)}`, { method: "PUT", body: JSON.stringify({ body }) }); }
  async function action(action: "submit" | "approve" | "send" | "retry") { if (draft) await request(`/${encodeURIComponent(draft.id)}/${action}`, { method: "POST" }); }
  async function reject() { if (draft && rejectionReason.trim()) await request(`/${encodeURIComponent(draft.id)}/reject`, { method: "POST", body: JSON.stringify({ reason: rejectionReason }) }); }

  return <section className="panel channel-reply-panel">
    <div className="panel-header"><div><h2>渠道人工回复</h2><span>仅渠道入站互动进入发送闭环</span></div><Send size={18} /></div>
    {error ? <p className="command-error" role="alert">回复未执行：{error}</p> : null}
    <div className="queue-list">{channelInteractions.length ? channelInteractions.map((item) => <button className={selected?.id === item.id ? "question selected" : "question"} key={item.id} type="button" onClick={() => setSelectedId(item.id)}><span className={`risk ${item.risk}`}>{drafts.find((draft) => draft.interactionId === item.id)?.status ?? "待建草稿"}</span><strong>{item.text}</strong><small>{item.channelConnectionId}</small></button>) : <div className="queue-empty">暂无来自渠道的待回复互动</div>}</div>
    {selected ? <div className="handoff-box"><ShieldCheck size={16} /><div><span>{draft ? `回复状态：${draft.status}` : "填写正文后创建可审计草稿"}</span><textarea aria-label="渠道回复正文" value={body} maxLength={1000} disabled={!canOperate || Boolean(draft && draft.status !== "draft")} onChange={(event) => setBody(event.target.value)} placeholder="输入要发送到来源渠道的回复" /><ProhibitedTermHints text={body} context="reply" onChange={setBody} /></div>
      {!draft && canOperate ? <button className="handle-interaction" disabled={!body.trim() || Boolean(busy)} onClick={createDraft} type="button">创建草稿</button> : null}
      {draft?.status === "draft" && canOperate ? <><button className="handle-interaction" disabled={Boolean(busy)} onClick={saveDraft} type="button">保存草稿</button><button className="handle-interaction" disabled={Boolean(busy)} onClick={() => action("submit")} type="button">提交审核</button></> : null}
      {draft?.status === "pending_approval" && canReview ? <><button className="handle-interaction" disabled={Boolean(busy)} onClick={() => action("approve")} type="button">批准发送</button><input aria-label="拒绝原因" value={rejectionReason} maxLength={1000} onChange={(event) => setRejectionReason(event.target.value)} placeholder="拒绝原因" /><button className="handle-interaction" disabled={!rejectionReason.trim() || Boolean(busy)} onClick={reject} type="button">拒绝</button></> : null}
      {draft?.status === "approved" && canOperate ? <button className="handle-interaction" disabled={Boolean(busy)} onClick={() => action("send")} type="button">进入投递队列</button> : null}
      {draft?.status === "failed" && canOperate ? <button className="handle-interaction" disabled={Boolean(busy)} onClick={() => action("retry")} type="button">重新授权投递</button> : null}
    </div> : null}
  </section>;
}
