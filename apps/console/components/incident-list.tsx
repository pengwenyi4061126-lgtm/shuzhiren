"use client";

import { CheckCircle2, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { Incident } from "@/lib/incidents";
import { clientFetch } from "@/lib/client-request";

export function IncidentList({ initialIncidents, canResolve }: { initialIncidents: Incident[]; canResolve: boolean }) {
  const [incidents, setIncidents] = useState(initialIncidents);
  const [editing, setEditing] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function resolve(incidentId: string) {
    setBusy(incidentId); setError(null);
    try {
      const response = await clientFetch(`/api/v1/incidents/${encodeURIComponent(incidentId)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution }) });
      const payload = await response.json().catch(() => null) as { data?: { incident: Incident }; error?: string } | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error || "关闭事故单失败");
      setIncidents((current) => current.map((incident) => incident.id === incidentId ? payload.data!.incident : incident));
      setEditing(null); setResolution("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "关闭事故单失败"); } finally { setBusy(null); }
  }
  if (!incidents.length) return <div className="incident-empty"><CheckCircle2 size={22} />暂无事故单</div>;
  return <><ul className="incident-list">{incidents.map((incident) => <li key={incident.id}><header><div><strong>{incident.title}</strong><span className={`incident-severity ${incident.severity}`}>{incident.severity === "critical" ? "严重" : "警告"}</span></div><span className={`incident-status ${incident.status}`}>{incident.status === "open" ? "处理中" : "已解决"}</span></header><p>责任人：{incident.ownerName} · {new Date(incident.openedAt).toLocaleString("zh-CN")}</p>{incident.resolution ? <blockquote>{incident.resolution}<small>{incident.resolvedBy ?? "场控"} · {incident.resolvedAt ? new Date(incident.resolvedAt).toLocaleString("zh-CN") : ""}</small></blockquote> : null}{canResolve && incident.status === "open" ? editing === incident.id ? <div className="incident-resolve"><textarea value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="填写处置结论和恢复依据（至少 10 个字符）" /><div><button type="button" onClick={() => { setEditing(null); setResolution(""); }}>取消</button><button className="incident-confirm" type="button" disabled={busy === incident.id || resolution.trim().length < 10} onClick={() => resolve(incident.id)}>{busy === incident.id ? <LoaderCircle className="button-spinner" size={14} /> : <CheckCircle2 size={14} />}{busy === incident.id ? "提交中" : "确认解决"}</button></div></div> : <button className="incident-resolve-button" type="button" onClick={() => setEditing(incident.id)}>记录处置并解决</button> : null}</li>)}</ul>{error ? <p className="monitoring-error" role="alert">{error}</p> : null}</>;
}
