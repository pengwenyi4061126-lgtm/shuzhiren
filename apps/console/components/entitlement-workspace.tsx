"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useState } from "react";
import type { Entitlement, EntitlementCode } from "@/lib/entitlements";

const definitions: Array<{ code: EntitlementCode; label: string; description: string; unit: string; placeholder: string }> = [
  { code: "max_concurrent_live_runs", label: "并发直播场次", description: "同一租户同时处于直播中的场次数上限。", unit: "场", placeholder: "1" },
  { code: "monthly_live_minutes", label: "当月直播分钟数", description: "worker 为每个 LIVE 场次记录幂等分钟桶；仅在下一次开播前阻断超额。", unit: "分钟", placeholder: "1000" }
];

export function EntitlementWorkspace({ initialEntitlements, canManage }: { initialEntitlements: Entitlement[]; canManage: boolean }) {
  const [entitlements, setEntitlements] = useState(initialEntitlements);
  const [drafts, setDrafts] = useState<Record<EntitlementCode, string>>(() => Object.fromEntries(definitions.map(({ code, placeholder }) => [code, String(initialEntitlements.find((item) => item.code === code)?.limitValue ?? placeholder)])) as Record<EntitlementCode, string>);
  const [busy, setBusy] = useState<EntitlementCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save(code: EntitlementCode) {
    const limitValue = Number(drafts[code]);
    if (!Number.isSafeInteger(limitValue) || limitValue <= 0) { setError("额度必须是正整数"); return; }
    setBusy(code); setError(null);
    try {
      const response = await fetch(`/api/v1/entitlements/${code}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ limitValue }) });
      const payload = await response.json().catch(() => null) as { data?: Entitlement; error?: string } | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error || "更新额度失败");
      setEntitlements((current) => [...current.filter((item) => item.code !== code), payload.data!]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新额度失败"); } finally { setBusy(null); }
  }
  return <><section className="entitlement-list">{definitions.map((definition) => {
    const value = entitlements.find((item) => item.code === definition.code);
    return <article key={definition.code}><div><h2>{definition.label}</h2><p>{definition.description}</p><strong>{value ? `${value.used} / ${value.limitValue}` : "未配置"} <small>{definition.unit}</small></strong><span>{value ? `剩余 ${value.remaining} ${definition.unit} · 自 ${value.effectiveFrom} 生效` : "未配置时不拦截直播"}</span></div>{canManage ? <form onSubmit={(event) => { event.preventDefault(); void save(definition.code); }}><label>上限<input inputMode="numeric" value={drafts[definition.code]} onChange={(event) => setDrafts((current) => ({ ...current, [definition.code]: event.target.value }))} /></label><button type="submit" disabled={busy === definition.code}>{busy === definition.code ? <LoaderCircle className="button-spinner" size={15} /> : <Save size={15} />}{busy === definition.code ? "保存中" : "保存"}</button></form> : null}</article>;
  })}</section>{error ? <p className="entitlement-error" role="alert">{error}</p> : null}</>;
}
