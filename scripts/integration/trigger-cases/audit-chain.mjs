// L16 (Requirement 30, migration 074): audit_chain_heads_guard rejects every direct write to a chain head;
// only the sealing trigger on audit_events (seal_audit_event, SECURITY DEFINER) moves the head.
import { randomUUID } from "node:crypto";

const GUARD = "audit_chain_heads_guard";
const GUARD_MESSAGE = "audit_chain_heads is maintained only by seal_audit_event";
const headOf = (_ctx, a) => ({ sql: "select tenant_id, last_sequence::int as last_sequence, last_hash from audit_chain_heads where tenant_id = $1", params: [a.tenantId] });

/** A tenant whose chain already has one sealed event (and so a head row). */
async function sealedTenant({ client, seed }) {
  const tenantId = await seed.tenant();
  await client.query("insert into audit_events (tenant_id, event_type, resource_type, detail) values ($1, 'integration.sealed', 'tenant', '{}'::jsonb)", [tenantId]);
  return { tenantId };
}

export default [
  {
    id: "audit_chain_heads.guard.insert.direct.reject",
    table: "audit_chain_heads", trigger: GUARD, op: "INSERT", expect: "reject", message: GUARD_MESSAGE,
    async arrange({ seed }) { return { tenantId: await seed.tenant() }; },
    act: (_ctx, a) => ({ sql: "insert into audit_chain_heads (tenant_id) values ($1)", params: [a.tenantId] }),
    readBack: headOf
  },
  {
    id: "audit_chain_heads.guard.update.direct.reject",
    table: "audit_chain_heads", trigger: GUARD, op: "UPDATE", updatedColumns: ["last_sequence", "last_hash"], expect: "reject", message: GUARD_MESSAGE,
    arrange: sealedTenant,
    act: (_ctx, a) => ({ sql: "update audit_chain_heads set last_sequence = 0, last_hash = repeat('0', 64) where tenant_id = $1", params: [a.tenantId] }),
    readBack: headOf
  },
  {
    id: "audit_chain_heads.guard.delete.direct.reject",
    table: "audit_chain_heads", trigger: GUARD, op: "DELETE", expect: "reject", message: GUARD_MESSAGE,
    arrange: sealedTenant,
    act: (_ctx, a) => ({ sql: "delete from audit_chain_heads where tenant_id = $1", params: [a.tenantId] }),
    readBack: headOf
  },
  {
    // The runtime worker holds only INSERT on audit_events (service-principals.sql); sealing still advances the head.
    id: "audit_events.hash_chain.insert.runtime_worker.accept",
    table: "audit_events", trigger: "audit_events_hash_chain", op: "INSERT", expect: "accept", as: "runtime_worker", tenantContext: true,
    async arrange(ctx) { return { ...(await sealedTenant(ctx)), eventId: randomUUID() }; },
    act: (_ctx, a) => ({ sql: "insert into audit_events (id, tenant_id, event_type, resource_type, detail) values ($1, $2, 'integration.worker', 'tenant', '{}'::jsonb)", params: [a.eventId, a.tenantId] }),
    readBack: (_ctx, a) => ({ sql: "select e.id, e.chain_sequence::int as chain_sequence, e.previous_hash = h_prev.event_hash as links_previous, h.last_sequence::int as head_sequence, h.last_hash = e.event_hash as head_matches, (select verified from verify_audit_chain($2::uuid)) as verified from audit_events e join audit_chain_heads h on h.tenant_id = e.tenant_id left join audit_events h_prev on h_prev.tenant_id = e.tenant_id and h_prev.chain_sequence = e.chain_sequence - 1 where e.id = $1", params: [a.eventId, a.tenantId] }),
    expectedAfter: (a) => [{ id: a.eventId, chain_sequence: 2, links_previous: true, head_sequence: 2, head_matches: true, verified: true }]
  }
];
