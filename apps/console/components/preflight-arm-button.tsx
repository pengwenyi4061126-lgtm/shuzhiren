"use client";

import { LoaderCircle, Radio } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clientFetch } from "@/lib/client-request";

export function PreflightArmButton({ runId, enabled, canOperate }: { runId: string; enabled: boolean; canOperate: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canArm = enabled && canOperate;

  async function arm() {
    if (!canArm || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await clientFetch(`/api/v1/live-runs/${encodeURIComponent(runId)}/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "arm" })
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || "预检武装失败");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "预检武装失败");
    } finally {
      setBusy(false);
    }
  }

  return <div className="preflight-arm-action">
    <button className="publish-button" disabled={!canArm || busy} onClick={arm} type="button" title={!canOperate ? "当前角色仅可查看" : !enabled ? "场次必须处于预检状态且全部检查通过" : undefined}>
      {busy ? <LoaderCircle className="button-spinner" size={16} /> : <Radio size={16} />}{busy ? "武装中" : "确认待开播"}
    </button>
    {error ? <p role="alert">预检武装未完成：{error}</p> : null}
  </div>;
}
