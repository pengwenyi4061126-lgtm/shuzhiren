import type { PoolClient } from "pg";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type EntitlementCode = "max_concurrent_live_runs" | "monthly_live_minutes";
export type Entitlement = { code: EntitlementCode; limitValue: number; used: number; remaining: number; effectiveFrom: string; effectiveUntil?: string; updatedAt: string };
type PersistentEntitlementRow = { code: EntitlementCode; limit_value: number; used: string | number; effective_from: Date | string; effective_until: Date | string | null; updated_at: Date | string };
type EntitlementStore = { values: Map<string, Map<EntitlementCode, Entitlement>> };

declare global { var shuzhirenEntitlementStore: EntitlementStore | undefined; }
function entitlementStore() { globalThis.shuzhirenEntitlementStore ??= { values: new Map() }; return globalThis.shuzhirenEntitlementStore; }

export async function listEntitlements(context: RequestContext): Promise<Entitlement[]> {
  if (!databasePool()) return [...(entitlementStore().values.get(context.tenantId)?.values() ?? [])];
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentEntitlementRow>(`select e.code, e.limit_value,
      case e.code
        when 'max_concurrent_live_runs' then (select count(*) from live_runs where state in ('LIVE', 'DEGRADED') or (state = 'ARMED' and scheduled_start_event_id is not null))
        when 'monthly_live_minutes' then (select coalesce(sum(quantity), 0) from usage_records where code = 'monthly_live_minutes' and occurred_at >= date_trunc('month', now()))
      end as used,
      e.effective_from, e.effective_until, e.updated_at
      from tenant_entitlements e order by e.code`);
    return result.rows.map(persistentEntitlement);
  });
}

export async function setEntitlement(context: RequestContext, input: { code: EntitlementCode; limitValue: number; effectiveFrom?: string; effectiveUntil?: string }) {
  if (!Number.isSafeInteger(input.limitValue) || input.limitValue <= 0 || input.limitValue > 10_000_000) throw new Response("limitValue must be a positive integer", { status: 400 });
  if (!databasePool()) {
    const values = entitlementStore().values.get(context.tenantId) ?? new Map<EntitlementCode, Entitlement>();
    const current = values.get(input.code);
    const entitlement: Entitlement = { code: input.code, limitValue: input.limitValue, used: current?.used ?? 0, remaining: Math.max(0, input.limitValue - (current?.used ?? 0)), effectiveFrom: input.effectiveFrom ?? new Date().toISOString().slice(0, 10), effectiveUntil: input.effectiveUntil, updatedAt: new Date().toISOString() };
    values.set(input.code, entitlement); entitlementStore().values.set(context.tenantId, values);
    await recordAuditEvent(context, { type: "entitlement.updated", resource: "tenant_entitlement", resourceId: `${context.tenantId}:${input.code}`, detail: { code: input.code, limitValue: input.limitValue } });
    return entitlement;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await syncActor(client, context);
    const result = await client.query<PersistentEntitlementRow>(`insert into tenant_entitlements (tenant_id, code, limit_value, effective_from, effective_until, updated_by)
      values ($1, $2::entitlement_code, $3, coalesce($4::date, current_date), $5::date, $6)
      on conflict (tenant_id, code) do update set limit_value = excluded.limit_value, effective_from = excluded.effective_from, effective_until = excluded.effective_until, updated_at = now(), updated_by = excluded.updated_by
      returning code, limit_value, 0::bigint as used, effective_from, effective_until, updated_at`, [context.tenantId, input.code, input.limitValue, input.effectiveFrom ?? null, input.effectiveUntil ?? null, actor]);
    const entitlement = persistentEntitlement(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "entitlement.updated", resource: "tenant_entitlement", resourceId: `${context.tenantId}:${input.code}`, detail: { code: input.code, limitValue: input.limitValue } });
    return entitlement;
  });
}

export async function assertLiveActivationAllowed(client: PoolClient, context: RequestContext, runId: string) {
  const rows = await client.query<{ code: EntitlementCode; limit_value: number }>("select code, limit_value from tenant_entitlements where effective_from <= current_date and (effective_until is null or effective_until >= current_date) for update");
  for (const entitlement of rows.rows) {
    if (entitlement.code === "max_concurrent_live_runs") {
      const active = await client.query<{ count: string }>("select count(*) from live_runs where (state in ('LIVE', 'DEGRADED') or (state = 'ARMED' and scheduled_start_event_id is not null)) and id <> $1", [runId]);
      if (Number(active.rows[0].count) >= entitlement.limit_value) throw new Response("Concurrent live-run entitlement is exhausted", { status: 409 });
    }
    if (entitlement.code === "monthly_live_minutes") {
      const used = await client.query<{ total: string }>("select coalesce(sum(quantity), 0) as total from usage_records where code = 'monthly_live_minutes' and occurred_at >= date_trunc('month', now())");
      if (Number(used.rows[0].total) >= entitlement.limit_value) throw new Response("Monthly live-minute entitlement is exhausted", { status: 409 });
    }
  }
}

function persistentEntitlement(row: PersistentEntitlementRow): Entitlement { const used = Number(row.used); return { code: row.code, limitValue: row.limit_value, used, remaining: Math.max(0, row.limit_value - used), effectiveFrom: new Date(row.effective_from).toISOString().slice(0, 10), effectiveUntil: row.effective_until ? new Date(row.effective_until).toISOString().slice(0, 10) : undefined, updatedAt: new Date(row.updated_at).toISOString() }; }
async function syncActor(client: PoolClient, context: RequestContext) { const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]); return actor.rows[0].id; }
