import { requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess } from "@/lib/control-plane/run-access";
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
export type AuditChainVerification = { verified: boolean; sealedEvents: number; legacyEvents: number; detail: string };
export type AuditEvidenceEvent = AuditEvent & { chainSequence: number | null; previousHash: string | null; eventHash: string | null };
export type AuditEvidenceExport = { generatedAt: string; chain: AuditChainVerification; events: AuditEvidenceEvent[] };

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
  chain_sequence?: number | string | null;
  previous_hash?: string | null;
  event_hash?: string | null;
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
  requireTenantWideAccess(context);
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

export async function listAuditEventsForRun(context: RequestContext, runId: string) {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) return auditStore().events.filter((event) => event.tenantId === context.tenantId && (event.resourceId === runId || event.detail.runId === runId));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAuditRow>(
      `select a.id, a.tenant_id, a.event_type, a.resource_type, a.resource_key,
        u.external_subject, u.display_name as actor_name, a.occurred_at, a.detail
       from audit_events a left join users u on u.id = a.actor_id
       where a.resource_key = $1 or a.detail ->> 'runId' = $1
       order by a.occurred_at desc limit 250`,
      [runId]
    );
    return result.rows.map(persistentAuditEvent);
  });
}

export async function verifyAuditChain(context: RequestContext): Promise<AuditChainVerification> {
  requireTenantWideAccess(context);
  if (!databasePool()) return { verified: false, sealedEvents: 0, legacyEvents: auditStore().events.filter((event) => event.tenantId === context.tenantId).length, detail: "演示模式不提供持久化哈希链" };
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<{ verified: boolean; sealed_events: string | number; legacy_events: string | number; detail: string }>("select * from verify_audit_chain($1::uuid)", [context.tenantId]);
    const row = result.rows[0];
    if (!row) throw new Error("Audit chain verification returned no result");
    return { verified: row.verified, sealedEvents: Number(row.sealed_events), legacyEvents: Number(row.legacy_events), detail: row.detail };
  });
}

export async function exportAuditEvidence(context: RequestContext): Promise<AuditEvidenceExport> {
  requireTenantWideAccess(context);
  await recordAuditEvent(context, { type: "audit.exported", resource: "audit_evidence_export", resourceId: `audit-export:${crypto.randomUUID()}`, detail: { format: "json", scope: "tenant_chain" } });
  const [chain, events] = await Promise.all([verifyAuditChain(context), listAuditEvidenceEvents(context)]);
  return { generatedAt: new Date().toISOString(), chain, events };
}

async function listAuditEvidenceEvents(context: RequestContext): Promise<AuditEvidenceEvent[]> {
  if (!databasePool()) return auditStore().events.filter((event) => event.tenantId === context.tenantId).map((event) => ({ ...event, chainSequence: null, previousHash: null, eventHash: null })).slice(0, 10000);
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAuditRow>(
      `select a.id, a.tenant_id, a.event_type, a.resource_type, a.resource_key,
        u.external_subject, u.display_name as actor_name, a.occurred_at, a.detail,
        a.chain_sequence, a.previous_hash, a.event_hash
       from audit_events a left join users u on u.id = a.actor_id
       order by a.chain_sequence asc nulls first, a.occurred_at asc limit 10000`
    );
    return result.rows.map((row) => ({ ...persistentAuditEvent(row), chainSequence: row.chain_sequence === null || row.chain_sequence === undefined ? null : Number(row.chain_sequence), previousHash: row.previous_hash ?? null, eventHash: row.event_hash ?? null }));
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
