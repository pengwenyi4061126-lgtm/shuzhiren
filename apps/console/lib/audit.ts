import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type AuditEvent = {
  id: string;
  tenantId: string;
  type: string;
  resource: string;
  resourceId: string;
  actorId: string;
  actorName: string;
  occurredAt: string;
  detail: Record<string, string | number | boolean | null>;
};

type AuditStore = { events: AuditEvent[] };
type PersistentAuditRow = {
  id: string;
  tenant_id: string;
  event_type: string;
  resource_type: string;
  resource_key: string | null;
  external_subject: string | null;
  actor_name: string | null;
  occurred_at: Date | string;
  detail: unknown;
};

declare global { var shuzhirenAuditStore: AuditStore | undefined; }

function auditStore(): AuditStore {
  globalThis.shuzhirenAuditStore ??= { events: [] };
  return globalThis.shuzhirenAuditStore;
}

export async function recordAuditEvent(context: RequestContext, input: Omit<AuditEvent, "id" | "tenantId" | "actorId" | "actorName" | "occurredAt">) {
  if (!databasePool()) {
    const event: AuditEvent = { id: `audit_${crypto.randomUUID()}`, tenantId: context.tenantId, actorId: context.actorId, actorName: context.actorName, occurredAt: new Date().toISOString(), ...input };
    auditStore().events.unshift(event);
    return event;
  }
  return withTenantTransaction(context.tenantId, async (client) => recordAuditEventInTransaction(client, context, input));
}

export async function recordAuditEventInTransaction(client: import("pg").PoolClient, context: RequestContext, input: Omit<AuditEvent, "id" | "tenantId" | "actorId" | "actorName" | "occurredAt">) {
  const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
  const result = await client.query<PersistentAuditRow>(
    `insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
     values ($1, $2, $3, $4, $5::uuid, $6, $7::jsonb)
     returning id, tenant_id, event_type, resource_type, resource_key, $8::text as external_subject,
       $9::text as actor_name, occurred_at, detail`,
    [context.tenantId, actor.rows[0].id, input.type, input.resource, asUuid(input.resourceId), input.resourceId, JSON.stringify(input.detail), context.actorId, context.actorName]
  );
  return persistentAuditEvent(result.rows[0]);
}

export async function listAuditEvents(context: RequestContext) {
  if (!databasePool()) return auditStore().events.filter((event) => event.tenantId === context.tenantId);
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAuditRow>(
      `select a.id, a.tenant_id, a.event_type, a.resource_type, a.resource_key,
        u.external_subject, u.display_name as actor_name, a.occurred_at, a.detail
       from audit_events a left join users u on u.id = a.actor_id
       order by a.occurred_at desc limit 500`
    );
    return result.rows.map(persistentAuditEvent);
  });
}

function asUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function persistentAuditEvent(row: PersistentAuditRow): AuditEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.event_type,
    resource: row.resource_type,
    resourceId: row.resource_key ?? "",
    actorId: row.external_subject ?? "system",
    actorName: row.actor_name ?? "系统",
    occurredAt: new Date(row.occurred_at).toISOString(),
    detail: (typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail) as AuditEvent["detail"]
  };
}
