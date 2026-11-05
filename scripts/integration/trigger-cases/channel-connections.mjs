// C1 (Requirement 8, migration 069): channel_connections_governed_verification on INSERT, UPDATE and DELETE.
// Before 069 every INSERT failed as "channel connection configuration is immutable" and DELETE reported the
// same misleading error; these cases pin the fixed behavior. Message texts are the raise exception texts of
// enforce_channel_connection_verification() in 069.
import { randomUUID } from "node:crypto";

const TABLE = "channel_connections";
const TRIGGER = "channel_connections_governed_verification";
const IMMUTABLE = "configuration is immutable";
const COLUMNS = "id, tenant_id, name, provider, status::text as status, output_protocol::text as output_protocol, secret_ref, capabilities, verification_evidence_ref, verified_by, last_verified_at is not null as has_verified_at";
const readById = (_ctx, a) => ({ sql: `select ${COLUMNS} from channel_connections where id = $1`, params: [a.channelId] });

async function tenantWithMember({ seed }) {
  const tenantId = await seed.tenant();
  const memberId = await seed.member({ tenantId, role: "admin" });
  return { tenantId, memberId };
}
function insertSql({ status, evidence, verifier }) {
  return (_ctx, a) => ({
    sql: "insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref, verified_by) values ($1, $2, 'C1 case channel', 'normalized-webhook-rtmp', $3, 'rtmp', 'secret://integration/c1', '{}'::jsonb, $4, $5, $6)",
    params: [a.channelId, a.tenantId, status, evidence ? new Date() : null, evidence ? "evidence://integration/c1-verification" : null, verifier ? verifier(a) : null]
  });
}

export default [
  {
    id: "channel_connections.governed_verification.insert.disabled.accept",
    table: TABLE, trigger: TRIGGER, op: "INSERT", expect: "accept",
    async arrange(ctx) { return { ...(await tenantWithMember(ctx)), channelId: randomUUID() }; },
    act: insertSql({ status: "disabled", evidence: false }),
    readBack: readById,
    expectedAfter: (a) => [{ id: a.channelId, tenant_id: a.tenantId, status: "disabled", secret_ref: "secret://integration/c1", verified_by: null, has_verified_at: false }]
  },
  {
    id: "channel_connections.governed_verification.insert.connected_with_evidence.accept",
    table: TABLE, trigger: TRIGGER, op: "INSERT", expect: "accept",
    async arrange(ctx) { return { ...(await tenantWithMember(ctx)), channelId: randomUUID() }; },
    act: insertSql({ status: "connected", evidence: true, verifier: (a) => a.memberId }),
    readBack: readById,
    expectedAfter: (a) => [{ id: a.channelId, status: "connected", verified_by: a.memberId, verification_evidence_ref: "evidence://integration/c1-verification", has_verified_at: true }]
  },
  {
    id: "channel_connections.governed_verification.insert.connected_without_evidence.reject",
    table: TABLE, trigger: TRIGGER, op: "INSERT", expect: "reject",
    message: "connected channel connections require verification evidence, time, and actor",
    messageExcludes: [IMMUTABLE],
    async arrange(ctx) { return { ...(await tenantWithMember(ctx)), channelId: randomUUID() }; },
    act: insertSql({ status: "connected", evidence: false }),
    readBack: readById
  },
  {
    id: "channel_connections.governed_verification.insert.outsider_verifier.reject",
    table: TABLE, trigger: TRIGGER, op: "INSERT", expect: "reject",
    message: "channel verification actor must be an active tenant member",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      const otherTenantId = await ctx.seed.tenant();
      const outsiderId = await ctx.seed.member({ tenantId: otherTenantId, role: "admin" });
      return { ...own, outsiderId, channelId: randomUUID() };
    },
    act: insertSql({ status: "connected", evidence: true, verifier: (a) => a.outsiderId }),
    readBack: readById
  },
  {
    id: "channel_connections.governed_verification.update.verify.accept",
    table: TABLE, trigger: TRIGGER, op: "UPDATE", updatedColumns: ["status", "last_verified_at", "verification_evidence_ref", "verified_by"], expect: "accept",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, channelId: await ctx.seed.channelConnection({ tenantId: own.tenantId, status: "disabled" }) };
    },
    act: (_ctx, a) => ({ sql: "update channel_connections set status = 'connected', last_verified_at = now(), verification_evidence_ref = 'evidence://integration/c1-update', verified_by = $2 where id = $1", params: [a.channelId, a.memberId] }),
    readBack: readById,
    expectedAfter: (a) => [{ id: a.channelId, status: "connected", verified_by: a.memberId, verification_evidence_ref: "evidence://integration/c1-update" }]
  },
  {
    id: "channel_connections.governed_verification.update.secret_ref.reject",
    table: TABLE, trigger: TRIGGER, op: "UPDATE", updatedColumns: ["secret_ref"], expect: "reject",
    message: "channel connection configuration is immutable",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, channelId: await ctx.seed.channelConnection({ tenantId: own.tenantId, verifier: own.memberId }) };
    },
    act: (_ctx, a) => ({ sql: "update channel_connections set secret_ref = 'secret://integration/c1-mutated' where id = $1", params: [a.channelId] }),
    readBack: readById
  },
  {
    id: "channel_connections.governed_verification.delete.reject",
    table: TABLE, trigger: TRIGGER, op: "DELETE", expect: "reject",
    message: "channel connections cannot be deleted",
    messageExcludes: [IMMUTABLE],
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, channelId: await ctx.seed.channelConnection({ tenantId: own.tenantId, verifier: own.memberId }) };
    },
    act: (_ctx, a) => ({ sql: "delete from channel_connections where id = $1", params: [a.channelId] }),
    readBack: readById
  }
];
