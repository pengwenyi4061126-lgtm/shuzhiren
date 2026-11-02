"use client";

import Link from "next/link";
import { useState } from "react";
import { Activity, CheckCircle2, Clock3, RotateCcw, Send, TriangleAlert } from "lucide-react";
import type { MediaOutboxEvent } from "@/lib/control-plane/outbox";

export function OutboxWorkspace({ initialEvents }: { initialEvents: MediaOutboxEvent[] }) {
  const [events, setEvents] = useState(initialEvents);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function deliver(event: MediaOutboxEvent) {
    if (busy || event.state === "delivering" || event.state === "delivered") return;
    setBusy(event.id);
    setError(null);
    try {
      const response = await fetch(`/api/v1/runtime/outbox/${encodeURIComponent(event.id)}/deliver`, { method: "POST" });
      const payload = await response.json().catch(() => null) as { data?: { event?: MediaOutboxEvent }; error?: string } | null;
      if (!response.ok || !payload?.data?.event) throw new Error(payload?.error || "投递失败");
      setEvents((items) => items.map((item) => item.id === event.id ? payload.data!.event! : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "投递失败"); } finally { setBusy(null); }
  }

  const failed = events.filter((event) => event.state === "failed").length;
  const active = events.filter((event) => event.state === "pending" || event.state === "delivering").length;
  return <main className="outbox-page">
    <header className="outbox-header"><div><p>运行时队列</p><h1>媒体投递与恢复</h1><span>自动 worker 使用租约和退避投递；人工立即投递仅用于场控确认后的恢复。</span></div><div className="outbox-summary"><span><Activity size={15} />{active} 待处理</span><span className={failed ? "outbox-failed-count" : ""}><TriangleAlert size={15} />{failed} 失败</span></div></header>
    {error ? <p className="catalog-error" role="alert">{error}</p> : null}
    <section className="outbox-table" aria-label="媒体投递队列"><div className="outbox-row outbox-labels"><span>命令</span><span>会话</span><span>状态</span><span>尝试与错误</span><span>操作</span></div>{events.length ? events.map((event) => <div className="outbox-row" key={event.id}><div><strong>{event.command.type}</strong><small>{event.command.runId}</small></div><code>{event.sessionId}</code><span className={`outbox-state ${event.state}`}>{event.state === "delivered" ? <CheckCircle2 size={15} /> : event.state === "delivering" ? <Clock3 size={15} /> : <Send size={15} />}{event.state}</span><div><strong>第 {event.attempts} 次</strong><small>{event.lastError ?? (event.deliveredAt ? `完成于 ${new Date(event.deliveredAt).toLocaleString("zh-CN")}` : "等待 worker 领取")}</small></div><button type="button" className="subtle-button" disabled={Boolean(busy) || event.state === "delivering" || event.state === "delivered"} onClick={() => deliver(event)}>{busy === event.id ? "投递中" : <><RotateCcw size={14} />立即投递</>}</button></div>) : <div className="outbox-empty">暂无媒体命令</div>}</section>
    <Link className="catalog-back" href="/"><Activity size={16} />返回指挥台</Link>
  </main>;
}
