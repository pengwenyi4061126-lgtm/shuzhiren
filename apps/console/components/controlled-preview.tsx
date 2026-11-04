"use client";

import { Eye, LoaderCircle, MonitorOff, RefreshCw } from "lucide-react";
import { useState } from "react";
import { clientFetch as fetch } from "@/lib/client-request";
import type { RuntimePreview } from "@/lib/runtime-gateway";

type Props = { runId: string; canOperate: boolean };
type PreviewResponse = { data: RuntimePreview };

const unavailableLabel: Record<Extract<RuntimePreview, { available: false }>["reason"], string> = {
  demo_mode: "演示模式不提供运行时预览",
  not_configured: "预览 broker 尚未配置",
  session_inactive: "运行时会话尚未就绪"
};

export function ControlledPreview({ runId, canOperate }: Props) {
  const [preview, setPreview] = useState<RuntimePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestPreview() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/live-runs/${runId}/preview`, { cache: "no-store" });
      const payload = await response.json() as PreviewResponse | { error?: string };
      if (!response.ok || !("data" in payload)) throw new Error("runtime_preview_unavailable");
      setPreview(payload.data);
    } catch {
      setError("预览授权暂时不可用");
    } finally {
      setLoading(false);
    }
  }

  if (preview?.available) {
    return <div className="preview preview-active" aria-label="受控直播预览"><iframe allow="autoplay; fullscreen" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms" src={preview.url} title="受控直播预览" /><div className="preview-toolbar"><span>授权至 {new Date(preview.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><button aria-label="刷新预览授权" className="icon-button" disabled={loading} onClick={requestPreview} title="刷新预览授权" type="button"><RefreshCw size={16} /></button></div></div>;
  }

  const message = error ?? (preview ? unavailableLabel[preview.reason] : canOperate ? "预览尚未请求" : "当前角色不能请求运行时预览");
  return <div className="preview preview-empty" aria-live="polite"><MonitorOff aria-hidden="true" size={28} /><span>{message}</span>{canOperate ? <button className="button" disabled={loading} onClick={requestPreview} type="button">{loading ? <LoaderCircle className="button-spinner" size={16} /> : <Eye size={16} />}{loading ? "获取授权中" : "打开预览"}</button> : null}</div>;
}
