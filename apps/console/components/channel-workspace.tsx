"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { BadgeCheck, CircleDotDashed, Link2, MonitorPlay, Plus, Radio, X } from "lucide-react";
import type { ChannelConnection, ChannelProvider, ChannelStatus, OutputProtocol } from "@/lib/channels";

type Draft = { name: string; provider: ChannelProvider; secretRef: string; outputProtocol: OutputProtocol };
const emptyDraft: Draft = { name: "", provider: "generic-rtmp", secretRef: "", outputProtocol: "rtmp" };

export function ChannelWorkspace({ initialConnections }: { initialConnections: ChannelConnection[] }) {
  const [connections, setConnections] = useState(initialConnections);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [verificationRefs, setVerificationRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function request<T>(url: string, init: RequestInit) {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null;
    if (!response.ok || !payload?.data) throw new Error(payload?.error || "操作失败，请稍后重试");
    return payload.data;
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy("create");
    try {
      const connection = await request<ChannelConnection>("/api/v1/channels/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name.trim(), provider: draft.provider, secretRef: draft.secretRef.trim(), outputProtocol: draft.outputProtocol }) });
      setConnections((items) => [connection, ...items]);
      setOpen(false);
      setDraft(emptyDraft);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建渠道连接失败"); } finally { setBusy(null); }
  }

  async function verify(id: string, status: ChannelStatus) {
    const evidenceRef = verificationRefs[id]?.trim();
    if (!evidenceRef) { setError("请先填写本次渠道验证的证据引用"); return; }
    setError(null);
    setBusy(id);
    try {
      const connection = await request<ChannelConnection>(`/api/v1/channels/connections/${encodeURIComponent(id)}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, evidenceRef }) });
      setConnections((items) => items.map((item) => item.id === id ? connection : item));
      setVerificationRefs((items) => ({ ...items, [id]: "" }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "验证状态更新失败"); } finally { setBusy(null); }
  }

  return <main className="channels-page">
    <header className="channels-header"><div><p>渠道中心</p><h1>平台连接与能力</h1><span>适配器能力由服务端注册表提供；控制台只保存受管密钥引用与验证证据。</span></div><div className="channel-header-actions"><span className="channel-connected"><BadgeCheck size={16} />{connections.filter((item) => item.status === "connected").length} 已连接</span><button type="button" onClick={() => { setError(null); setOpen(true); }}><Plus size={16} />新增连接</button></div></header>
    {error ? <p className="catalog-error" role="alert">{error}</p> : null}
    {open ? <section className="catalog-form channel-form"><div className="catalog-form-head"><div><h2>新增渠道连接</h2><span>新连接默认禁用，只有记录验证证据后才能标记为已连接。</span></div><button className="icon-button" type="button" onClick={() => setOpen(false)} aria-label="关闭"><X size={16} /></button></div><form onSubmit={create}><label>连接名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required placeholder="店播 RTMP 备用通道" /></label><label>平台适配器<select value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value as ChannelProvider })}><option value="generic-rtmp">generic-rtmp</option><option value="normalized-webhook-rtmp">normalized-webhook-rtmp</option></select></label><label>密钥引用<input value={draft.secretRef} onChange={(event) => setDraft({ ...draft, secretRef: event.target.value })} required placeholder="kms://tenant/channel/backup" /></label><label>输出协议<select value={draft.outputProtocol} onChange={(event) => setDraft({ ...draft, outputProtocol: event.target.value as OutputProtocol })}><option value="rtmp">RTMP</option></select></label><button disabled={busy === "create"} type="submit">{busy === "create" ? "创建中" : "创建禁用连接"}</button></form></section> : null}
    <section className="channels-table"><div className="channels-row channels-labels"><span>连接</span><span>输出</span><span>互动与商品</span><span>合规与回放</span><span>验证状态</span></div>{connections.map((connection) => <div className="channels-row channel-item" key={connection.id}><div className="channel-name"><Radio size={18} /><div><strong>{connection.name}</strong><small>{connection.capability.channel} · {connection.secretRef}</small></div></div><span>{connection.outputProtocol.toUpperCase()} · 最大 {connection.capability.maxResolution}</span><span>{connection.capability.supportsComments ? "支持互动" : "无评论接口"} · {connection.capability.supportsProductPins ? "支持挂车" : "无商品接口"}</span><span>{connection.capability.requiresAiDisclosure ? "要求 AI 标识" : "AI 标识可选"} · {connection.capability.supportsReplay ? "支持回放" : "无回放接口"}</span><div className="channel-verify"><span className={`channel-status ${connection.status}`}><CircleDotDashed size={15} />{connection.status}</span><input aria-label="验证证据引用" value={verificationRefs[connection.id] ?? ""} onChange={(event) => setVerificationRefs((items) => ({ ...items, [connection.id]: event.target.value }))} placeholder={connection.verificationEvidenceRef ?? "验证报告或工单 ID"} disabled={busy === connection.id} /><select aria-label="连接验证状态" value={connection.status} onChange={(event) => verify(connection.id, event.target.value as ChannelStatus)} disabled={busy === connection.id}><option value="connected">connected</option><option value="degraded">degraded</option><option value="disabled">disabled</option></select></div></div>)}</section>
    <section className="channel-notice"><MonitorPlay size={18} /><div><strong>预检约束</strong><p>场次会根据已绑定渠道校验协议、分辨率、AI 标识、验证证据和验证时效。没有商品接口的 RTMP 渠道只能使用平台侧人工挂车或已批准的画面引导，不允许假装已完成商品同步。</p></div></section><Link className="catalog-back" href="/"><Link2 size={16} />返回指挥台</Link>
  </main>;
}
