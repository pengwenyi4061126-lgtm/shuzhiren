"use client";

import { Check, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { RuntimeAlert } from "@/lib/monitoring";

export function MonitoringAlertList({ initialAlerts, canAcknowledge }: { initialAlerts: RuntimeAlert[]; canAcknowledge: boolean }) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function acknowledge(alertId: string) {
    setBusy(alertId); setError(null);
    try {
      const response = await fetch(`/api/v1/alerts/${encodeURIComponent(alertId)}/acknowledge`, { method: "POST" });
      const payload = await response.json().catch(() => null) as { data?: { alert: RuntimeAlert }; error?: string } | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error || "告警确认失败");
      setAlerts((current) => current.map((alert) => alert.id === alertId ? payload.data!.alert : alert));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "告警确认失败");
    } finally { setBusy(null); }
  }

  if (!alerts.length) return <div className="no-alerts"><Check size={20} />没有未解决告警</div>;
  return <><ul className="alert-list">{alerts.map((alert) => <li key={alert.id}><div><strong>{alert.code}</strong><span>{alert.message}</span>{alert.acknowledgedAt ? <small>已由 {alert.acknowledgedBy ?? "场控"} 于 {new Date(alert.acknowledgedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 接手</small> : <small>尚未确认接手</small>}</div>{canAcknowledge && !alert.acknowledgedAt ? <button className="alert-acknowledge" type="button" onClick={() => acknowledge(alert.id)} disabled={busy === alert.id}>{busy === alert.id ? <LoaderCircle className="button-spinner" size={14} /> : <Check size={14} />}{busy === alert.id ? "确认中" : "确认接手"}</button> : null}</li>)}</ul>{error ? <p className="monitoring-error" role="alert">{error}</p> : null}</>;
}
