"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Activity, CheckCircle2, CircleHelp, Clock3, RotateCcw, Send, TriangleAlert } from "lucide-react";
import type { RuntimeOutboxEvent } from "@/lib/control-plane/outbox";
import { clientFetch } from "@/lib/client-request";
import { UncertainCommandsPanel } from "@/components/uncertain-commands-panel";

// An event the Gateway answered command_outcome_uncertain: it may have run partly, so it is not retried
// automatically and is shown apart from ordinary failures.
function outcomeUncertain(event: RuntimeOutboxEvent) { return Boolean(event.outcomeUncertainAt) && event.state === "failed"; }

export function OutboxWorkspace({ initialEvents, canResolveUncertain = false }: { initialEvents: RuntimeOutboxEvent[]; canResolveUncertain?: boolean }) {
  const [events, setEvents] = useState(initialEvents);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A failed manual delivery changes the event's state (and possibly its uncertain flag) on the server.
  const refresh = useCallback(async () => {
    try {
      const response = await clientFetch("/api/v1/runtime/outbox", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as { data?: RuntimeOutboxEvent[] } | null;
      if (response.ok && Array.isArray(payload?.data)) setEvents(payload.data);
    } catch { /* keep the current list; the error of the delivery is already shown */ }
  }, []);

  async function deliver(event: RuntimeOutboxEvent) {
    if (busy || event.state === "delivering" || event.state === "delivered") return;
    setBusy(event.id);
    setError(null);
    try {
      const response = await clientFetch(`/api/v1/runtime/outbox/${encodeURIComponent(event.id)}/deliver`, { method: "POST" });
      const payload = await response.json().catch(() => null) as { data?: { event?: RuntimeOutboxEvent }; error?: string; gatewayCode?: string } | null;
      if (!response.ok || !payload?.data?.event) {
        await refresh();
        throw new Error(payload?.gatewayCode === "command_outcome_uncertain" ? "结果不确定，需人工核对媒体会话" : payload?.error || "投递失败");
      }
      setEvents((items) => items.map((item) => item.id === event.id ? payload.data!.event! : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "投递失败"); } finally { setBusy(null); }
  }

  const uncertain = events.filter(outcomeUncertain).length;
  const failed = events.filter((event) => event.state === "failed" && !outcomeUncertain(event)).length;
  const active = events.filter((event) => event.state === "pending" || event.state === "delivering").length;
  return <main className="outbox-page">
    <header className="outbox-header"><div><p>运行时队列</p><h1>媒体投递与恢复</h1><span>自动 worker 使用租约和退避投递；人工立即投递仅用于场控确认后的恢复或停止命令。</span></div><div className="outbox-summary"><span><Activity size={15} />{active} 待处理</span><span className={failed ? "outbox-failed-count" : ""}><TriangleAlert size={15} />{failed} 失败</span><span className={uncertain ? "outbox-uncertain-count" : ""}><CircleHelp size={15} />{uncertain} 结果不确定</span></div></header>
    {error ? <p className="catalog-error" role="alert">{error}</p> : null}
    <section className="outbox-table" aria-label="运行时投递队列"><div className="outbox-row outbox-labels"><span>命令</span><span>会话</span><span>状态</span><span>尝试与错误</span><span>操作</span></div>{events.length ? events.map((event) => {
      const channelReply = event.type === "channel.reply.dispatch";
      const label = channelReply ? "channel_reply" : event.type === "speech.dispatch" ? "grounded_speech" : event.command.type;
      const reference = channelReply ? event.channelConnectionId : event.sessionId;
      const runId = channelReply ? event.runId : event.command.runId;
      const isUncertain = outcomeUncertain(event);
      const stateLabel = isUncertain
        ? <span className="outbox-state uncertain"><CircleHelp size={15} />结果不确定</span>
        : <span className={`outbox-state ${event.state}`}>{event.state === "delivered" ? <CheckCircle2 size={15} /> : event.state === "delivering" ? <Clock3 size={15} /> : <Send size={15} />}{event.state}</span>;
      const note = isUncertain ? "结果不确定，需人工核对媒体会话" : event.lastError ?? (event.deliveredAt ? `完成于 ${new Date(event.deliveredAt).toLocaleString("zh-CN")}` : event.state === "cancelled" ? "已由场控取消" : "等待 worker 领取");
      const action = channelReply ? "Worker 投递" : busy === event.id ? "投递中" : <><RotateCcw size={14} />{isUncertain ? "核对后重新投递" : "立即投递"}</>;
      return <div className="outbox-row" key={event.id}><div><strong>{label}</strong><small>{runId}</small></div><code>{reference}</code>{stateLabel}<div><strong>第 {event.attempts} 次</strong><small>{note}</small>{isUncertain && event.lastError ? <small>{event.lastError}</small> : null}</div><button type="button" className="subtle-button" disabled={channelReply || Boolean(busy) || event.state === "delivering" || event.state === "delivered" || event.state === "cancelled"} onClick={() => deliver(event)}>{action}</button></div>;
    }) : <div className="outbox-empty">暂无运行时命令</div>}</section>
    {canResolveUncertain ? <UncertainCommandsPanel onResolved={refresh} /> : null}
    <Link className="catalog-back" href="/"><Activity size={16} />返回指挥台</Link>
  </main>;
}
