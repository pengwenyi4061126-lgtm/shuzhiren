import type { RequestContext } from "@/lib/control-plane/auth-context";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { listAlerts } from "@/lib/monitoring";

export type Incident = { id: string; tenantId: string; runId: string; alertId?: string; severity: "warning" | "critical"; title: string; status: "open" | "resolved"; ownerName: string; openedAt: string; resolution?: string; resolvedAt?: string; resolvedBy?: string };
type PersistentIncidentRow = { id: string; tenant_id: string; live_run_id: string; runtime_alert_id: string | null; severity: Incident["severity"]; title: string; status: Incident["status"]; owner_id: string; owner_name: string | null; opened_at: Date | string; resolution: string | null; resolved_at: Date | string | null; resolved_by_name: string | null };
type IncidentStore = { incidents: Map<string, Incident> };

declare global { var shuzhirenIncidentStore: IncidentStore | undefined; }

function incidentStore() { globalThis.shuzhirenIncidentStore ??= { incidents: new Map() }; return globalThis.shuzhirenIncidentStore; }

export async function listIncidents(context: RequestContext, runId?: string) {
  if (!databasePool()) return [...incidentStore().incidents.values()].filter((incident) => incident.tenantId === context.tenantId && (!runId || incident.runId === runId)).sort((left, right) => right.openedAt.localeCompare(left.openedAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentIncidentRow>(`select i.id, i.tenant_id, i.live_run_id, i.runtime_alert_id, i.severity, i.title, i.status, i.owner_id, owner.display_name as owner_name, i.opened_at, i.resolution, i.resolved_at, resolver.display_name as resolved_by_name
      from incidents i
      left join users owner on owner.id = i.owner_id
      left join users resolver on resolver.id = i.resolved_by
      where ($1::uuid is null or i.live_run_id = $1)
      order by i.opened_at desc limit 500`, [runId ?? null]);
    return result.rows.map(persistentIncident);
  });
}

export async function createIncidentFromAlert(context: RequestContext, alertId: string) {
  if (!databasePool()) {
    const matching = [...incidentStore().incidents.values()].find((incident) => incident.tenantId === context.tenantId && incident.alertId === alertId);
    if (matching) return { incident: matching, duplicate: true as const };
    const alert = (await listAlerts(context)).find((candidate) => candidate.id === alertId);
    if (!alert) throw new Response("Runtime alert not found", { status: 404 });
    if (alert.status !== "open") throw new Response("Resolved alerts cannot create incidents", { status: 409 });
    const incident: Incident = { id: `incident_${crypto.randomUUID()}`, tenantId: context.tenantId, runId: alert.runId, alertId, severity: alert.severity, title: `运行告警处置：${alert.code}`, status: "open", ownerName: context.actorName, openedAt: new Date().toISOString() };
    incidentStore().incidents.set(incident.id, incident);
    await recordAuditEvent(context, { type: "incident.opened", resource: "incident", resourceId: incident.id, detail: { alertId, runId: incident.runId, severity: incident.severity } });
    return { incident, duplicate: false as const };
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const alert = await client.query<{ id: string; live_run_id: string; severity: Incident["severity"]; code: string; status: "open" | "resolved" }>("select id, live_run_id, severity, code, status from runtime_alerts where id = $1 for update", [alertId]);
    if (!alert.rows[0]) throw new Response("Runtime alert not found", { status: 404 });
    if (alert.rows[0].status !== "open") throw new Response("Resolved alerts cannot create incidents", { status: 409 });
    const existing = await client.query<PersistentIncidentRow>(`select i.id, i.tenant_id, i.live_run_id, i.runtime_alert_id, i.severity, i.title, i.status, i.owner_id, owner.display_name as owner_name, i.opened_at, i.resolution, i.resolved_at, resolver.display_name as resolved_by_name
      from incidents i left join users owner on owner.id = i.owner_id left join users resolver on resolver.id = i.resolved_by
      where i.runtime_alert_id = $1`, [alertId]);
    if (existing.rows[0]) return { incident: persistentIncident(existing.rows[0]), duplicate: true as const };
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const created = await client.query<PersistentIncidentRow>(`insert into incidents (tenant_id, live_run_id, runtime_alert_id, severity, title, owner_id)
      values ($1, $2, $3, $4, $5, $6)
      returning id, tenant_id, live_run_id, runtime_alert_id, severity, title, status, owner_id, $7::text as owner_name, opened_at, resolution, resolved_at, null::text as resolved_by_name`, [context.tenantId, alert.rows[0].live_run_id, alertId, alert.rows[0].severity, `运行告警处置：${alert.rows[0].code}`, actor.rows[0].id, context.actorName]);
    const incident = persistentIncident(created.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "incident.opened", resource: "incident", resourceId: incident.id, detail: { alertId, runId: incident.runId, severity: incident.severity } });
    return { incident, duplicate: false as const };
  });
}

export async function resolveIncident(context: RequestContext, incidentId: string, resolution: string) {
  const trimmed = resolution.trim();
  if (trimmed.length < 10 || trimmed.length > 2000) throw new Response("Resolution must be 10 to 2000 characters", { status: 400 });
  if (!databasePool()) {
    const incident = incidentStore().incidents.get(incidentId);
    if (!incident || incident.tenantId !== context.tenantId) throw new Response("Incident not found", { status: 404 });
    if (incident.status === "resolved") return { incident, duplicate: true as const };
    if (context.role !== "admin" && incident.ownerName !== context.actorName) throw new Response("Only the incident owner can resolve it", { status: 403 });
    const resolved = { ...incident, status: "resolved" as const, resolution: trimmed, resolvedAt: new Date().toISOString(), resolvedBy: context.actorName };
    incidentStore().incidents.set(incidentId, resolved);
    await recordAuditEvent(context, { type: "incident.resolved", resource: "incident", resourceId: incident.id, detail: { runId: incident.runId, resolutionLength: trimmed.length } });
    return { incident: resolved, duplicate: false as const };
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const current = await client.query<PersistentIncidentRow>(`select i.id, i.tenant_id, i.live_run_id, i.runtime_alert_id, i.severity, i.title, i.status, i.owner_id, owner.display_name as owner_name, i.opened_at, i.resolution, i.resolved_at, resolver.display_name as resolved_by_name
      from incidents i left join users owner on owner.id = i.owner_id left join users resolver on resolver.id = i.resolved_by where i.id = $1 for update of i`, [incidentId]);
    if (!current.rows[0]) throw new Response("Incident not found", { status: 404 });
    if (current.rows[0].status === "resolved") return { incident: persistentIncident(current.rows[0]), duplicate: true as const };
    if (context.role !== "admin" && current.rows[0].owner_id !== actor.rows[0].id) throw new Response("Only the incident owner can resolve it", { status: 403 });
    const updated = await client.query<PersistentIncidentRow>(`update incidents set status = 'resolved', resolution = $2, resolved_at = now(), resolved_by = $3 where id = $1
      returning id, tenant_id, live_run_id, runtime_alert_id, severity, title, status, $4::text as owner_name, opened_at, resolution, resolved_at, $5::text as resolved_by_name`, [incidentId, trimmed, actor.rows[0].id, current.rows[0].owner_name ?? "场控", context.actorName]);
    const incident = persistentIncident(updated.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "incident.resolved", resource: "incident", resourceId: incident.id, detail: { runId: incident.runId, resolutionLength: trimmed.length } });
    return { incident, duplicate: false as const };
  });
}

function persistentIncident(row: PersistentIncidentRow): Incident { return { id: row.id, tenantId: row.tenant_id, runId: row.live_run_id, alertId: row.runtime_alert_id ?? undefined, severity: row.severity, title: row.title, status: row.status, ownerName: row.owner_name ?? "场控", openedAt: new Date(row.opened_at).toISOString(), resolution: row.resolution ?? undefined, resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined, resolvedBy: row.resolved_by_name ?? undefined }; }
