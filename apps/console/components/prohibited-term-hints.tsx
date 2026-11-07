"use client";

import { useEffect, useState } from "react";
import { clientFetch } from "@/lib/client-request";
import { applySuggestion, type Finding } from "@/lib/shared/prohibited-terms.mjs";

type ScanContext = "script" | "template" | "faq" | "overlay" | "reply";
type ScanResult = { data?: { findings?: Finding[] }; error?: string };
const categoryLabel = { extreme: "绝对化", medical: "医疗", false_claim: "不实宣称", offsite_trade: "站外交易", custom: "租户自定义" } as const;

export function ProhibitedTermHints({ text, context, onChange, readOnly = false }: { text: string; context: ScanContext; onChange: (text: string) => void; readOnly?: boolean }) {
  const [result, setResult] = useState<{ text: string; findings: Finding[]; error: string | null } | null>(null);

  useEffect(() => {
    let active = true;
    if (!text.trim()) return () => { active = false; };
    const timer = window.setTimeout(() => {
      void clientFetch("/api/v1/prohibited-terms/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, context })
      }).then(async (response) => {
        const payload = await response.json().catch(() => null) as ScanResult | null;
        if (!response.ok || !payload?.data?.findings) throw new Error(payload?.error ?? "扫描未完成");
        if (active) setResult({ text, findings: payload.data.findings, error: null });
      }).catch((cause) => {
        if (active) setResult({ text, findings: [], error: cause instanceof Error ? cause.message : "扫描未完成" });
      });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [text, context]);

  const current = result?.text === text ? result : null;
  if (!text.trim() && !current?.error) return null;
  return <div aria-live="polite" style={{ display: "grid", gap: 6, marginTop: 6 }}>
    {current?.error ? <small role="status" style={{ color: "var(--muted)" }}>{current.error}</small> : null}
    {current?.findings.map((finding, index) => <div key={`${finding.termId}:${finding.start}:${index}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "7px 9px", borderLeft: `3px solid ${finding.severity === "block" ? "var(--red)" : "var(--orange)"}`, background: "var(--surface-subtle)", fontSize: 12 }}>
      <strong>{finding.term}</strong><span>{categoryLabel[finding.category]}</span><span>{finding.severity === "block" ? "拦截" : "提示"}</span>
      {!readOnly ? finding.suggestions.map((suggestion) => <button key={suggestion} type="button" className="icon-button" onClick={() => {
        try { onChange(applySuggestion(text, finding, suggestion)); } catch { setResult({ text, findings: [], error: null }); }
      }}>{suggestion}</button>) : null}
    </div>)}
  </div>;
}
