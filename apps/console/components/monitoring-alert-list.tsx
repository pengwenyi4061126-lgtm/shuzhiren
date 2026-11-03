"use client";

import { Check, LoaderCircle, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { RuntimeAlert } from "@/lib/monitoring";
import { runbookForAlertCode } from "@/lib/runbooks";
import { clientFetch } from "@/lib/client-request";

export function MonitoringAlertList({ initialAlerts, initialIncidentAlertIds = [], canAcknowledge }: { initialAlerts: RuntimeAlert[]; initialIncidentAlertIds?: string[]; canAcknowledge: boolean }) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [busy, setBusy] = useState<string | null>(null);
  const [incidentAlertIds, setIncidentAlertIds] = useState<Set<string>>(new Set(initialIncidentAlertIds));
  const [error, setError] = useState<string | null>(null);

  async function acknowledge(alertId: string) {
    setBusy(alertId); setError(null);
    try {
      const response = await clientFetch(`/api/v1/alerts/${encodeURIComponent(alertId)}/acknowledge`, { method: "POST" });
      const payload = await response.json().catch(() => null) as { data?: { alert: RuntimeAlert }; error?: string } | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error || "告警确认失败");
      setAlerts((current) => current.map((alert) => alert.id === alertId ? payload.data!.alert : alert));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "告警确认失败");
    } finally { setBusy(null); }
  }

  async function openIncident(alertId: string) {
    setBusy(`incident:${alertId}`); setError(null);
    try {
      const response = await clientFetch("/api/v1/incidents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alertId }) });
      const payload = await response.json().catch(() => null) as { data?: unknown; error?: string } | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error || "创建事故单失败");
      setIncidentAlertIds((current) => new Set(current).add(alertId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建事故单失败");
    } finally { setBusy(null); }
  }

  if (!alerts.length) return <div className="no-alerts"><Check size={20} />没有未解决告警</div>;
  return <><ul className="alert-list">{alerts.map((alert) => { const runbook = runbookForAlertCode(alert.code); return <li key={alert.id}><div><strong>{alert.code}</strong><span>{alert.message}</span>{runbook ? <Link className="alert-runbook" href={`/runbooks#${runbook.id}`}>查看处置：{runbook.title}</Link> : null}{alert.acknowledgedAt ? <small>已由 {alert.acknowledgedBy ?? "场控"} 于 {new Date(alert.acknowledgedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 接手</small> : <small>尚未确认接手</small>}</div>{canAcknowledge ? <aside className="alert-actions">{!alert.acknowledgedAt ? <button className="alert-acknowledge" type="button" onClick={() => acknowledge(alert.id)} disabled={busy === alert.id}>{busy === alert.id ? <LoaderCircle className="button-spinner" size={14} /> : <Check size={14} />}{busy === alert.id ? "确认中" : "确认接手"}</button> : null}{incidentAlertIds.has(alert.id) ? <span className="alert-incident-open">事故单已建立</span> : <button className="alert-incident" type="button" onClick={() => openIncident(alert.id)} disabled={busy === `incident:${alert.id}`}>{busy === `incident:${alert.id}` ? <LoaderCircle className="button-spinner" size={14} /> : <ShieldAlert size={14} />}{busy === `incident:${alert.id}` ? "创建中" : "建立事故单"}</button>}</aside> : null}</li>; })}</ul>{error ? <p className="monitoring-error" role="alert">{error}</p> : null}</>;
}
