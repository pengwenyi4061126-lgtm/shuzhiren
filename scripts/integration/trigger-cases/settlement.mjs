// C2 (Requirement 9, migration 070): the settlement governance triggers. Before 070 the batch and exception
// functions compared TG_OP with lower-case literals: updates were unrestricted and DELETE silently removed 0
// rows without an error. Message texts are the raise exception texts of 062 (tenant links) and 070.
import { randomUUID } from "node:crypto";

const BATCHES = "settlement_batches";
const LINES = "settlement_lines";
const EXCEPTIONS = "settlement_reconciliation_exceptions";
const BATCH_TRIGGER = "settlement_batches_governed_mutation";
const LINE_TRIGGER = "settlement_lines_governed_mutation";
const LINE_LINK_TRIGGER = "settlement_lines_validate_tenant_link";
const EXCEPTION_TRIGGER = "settlement_exceptions_governed_mutation";
const EXCEPTION_LINK_TRIGGER = "settlement_exceptions_validate_tenant_link";

/** Tenant, admin, disabled channel, one imported batch with one gross_sale line and one open exception. */
export async function arrangeSettlement({ client, seed }, { batchStatus = "imported" } = {}) {
  const tenantId = await seed.tenant();
  const memberId = await seed.member({ tenantId, role: "admin" });
  const channelId = await seed.channelConnection({ tenantId, status: "disabled" });
  const batchId = randomUUID();
  const lineId = randomUUID();
  const exceptionId = randomUUID();
  await client.query("insert into settlement_batches (id, tenant_id, channel_connection_id, provider_statement_ref, period_start, period_end, source_sha256, evidence_ref, imported_by) values ($1, $2, $3, $4, now() - interval '1 day', now(), repeat('a', 64), 'evidence://integration/settlement', $5)", [batchId, tenantId, channelId, `it-statement-${batchId}`, memberId]);
  await client.query("insert into settlement_lines (id, tenant_id, settlement_batch_id, external_line_id, line_type, external_order_reference, occurred_at, amount_cents) values ($1, $2, $3, 'it-line-1', 'gross_sale', 'it-order-1', now(), 100)", [lineId, tenantId, batchId]);
  await client.query("insert into settlement_reconciliation_exceptions (id, tenant_id, settlement_batch_id, settlement_line_id, order_reference, exception_type, actual_amount_cents, detail) values ($1, $2, $3, $4, 'it-order-1', 'missing_operational_event', 100, 'Integration settlement exception')", [exceptionId, tenantId, batchId, lineId]);
  if (batchStatus === "review_required" || batchStatus === "reconciled") await client.query("update settlement_batches set status = $2::settlement_batch_status where id = $1", [batchId, batchStatus]);
  return { tenantId, memberId, channelId, batchId, lineId, exceptionId };
}

const batchById = (_ctx, a) => ({ sql: "select id, status::text as status, source_sha256 from settlement_batches where id = $1", params: [a.batchId] });
const lineById = (_ctx, a) => ({ sql: "select id, amount_cents::text as amount_cents, settlement_batch_id from settlement_lines where id = $1", params: [a.lineId] });
const exceptionById = (_ctx, a) => ({ sql: "select id, status::text as status, detail, resolved_by, resolution from settlement_reconciliation_exceptions where id = $1", params: [a.exceptionId] });
const resolveSql = (detail = null) => (_ctx, a) => ({
  sql: "update settlement_reconciliation_exceptions set status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = 'Integration settlement resolution', resolution_evidence_ref = 'evidence://integration/settlement-resolution', detail = coalesce($3, detail) where id = $1",
  params: [a.exceptionId, a.memberId, detail]
});

export default [
  {
    id: "settlement_batches.governed_mutation.update.imported_to_review_required.accept",
    table: BATCHES, trigger: BATCH_TRIGGER, op: "UPDATE", updatedColumns: ["status"], expect: "accept",
    arrange: (ctx) => arrangeSettlement(ctx),
    act: (_ctx, a) => ({ sql: "update settlement_batches set status = 'review_required' where id = $1", params: [a.batchId] }),
    readBack: batchById,
    expectedAfter: (a) => [{ id: a.batchId, status: "review_required" }]
  },
  {
    id: "settlement_batches.governed_mutation.update.reconciled_to_imported.reject",
    table: BATCHES, trigger: BATCH_TRIGGER, op: "UPDATE", updatedColumns: ["status"], expect: "reject",
    message: "settlement batch status transition is not permitted",
    arrange: (ctx) => arrangeSettlement(ctx, { batchStatus: "reconciled" }),
    act: (_ctx, a) => ({ sql: "update settlement_batches set status = 'imported' where id = $1", params: [a.batchId] }),
    readBack: batchById
  },
  {
    id: "settlement_batches.governed_mutation.update.source_sha256.reject",
    table: BATCHES, trigger: BATCH_TRIGGER, op: "UPDATE", updatedColumns: ["source_sha256", "status"], expect: "reject",
    message: "settlement batch source evidence is immutable",
    arrange: (ctx) => arrangeSettlement(ctx),
    act: (_ctx, a) => ({ sql: "update settlement_batches set source_sha256 = repeat('b', 64), status = 'reconciled' where id = $1", params: [a.batchId] }),
    readBack: batchById
  },
  {
    id: "settlement_batches.governed_mutation.delete.reject",
    table: BATCHES, trigger: BATCH_TRIGGER, op: "DELETE", expect: "reject",
    message: "settlement batches are immutable",
    // Without a referencing line or exception, so only the trigger (not a foreign key) can stop the delete.
    async arrange(ctx) {
      const a = await arrangeSettlement(ctx);
      const batchId = randomUUID();
      await ctx.client.query("insert into settlement_batches (id, tenant_id, channel_connection_id, provider_statement_ref, period_start, period_end, source_sha256, evidence_ref, imported_by) values ($1, $2, $3, $4, now() - interval '1 day', now(), repeat('c', 64), 'evidence://integration/settlement', $5)", [batchId, a.tenantId, a.channelId, `it-statement-${batchId}`, a.memberId]);
      return { ...a, batchId };
    },
    act: (_ctx, a) => ({ sql: "delete from settlement_batches where id = $1", params: [a.batchId] }),
    readBack: batchById
  },
  {
    id: "settlement_lines.governed_mutation.update.reject",
    table: LINES, trigger: LINE_TRIGGER, op: "UPDATE", updatedColumns: ["amount_cents"], expect: "reject",
    message: "settlement lines are immutable",
    arrange: (ctx) => arrangeSettlement(ctx),
    act: (_ctx, a) => ({ sql: "update settlement_lines set amount_cents = 1 where id = $1", params: [a.lineId] }),
    readBack: lineById
  },
  {
    id: "settlement_lines.governed_mutation.delete.reject",
    table: LINES, trigger: LINE_TRIGGER, op: "DELETE", expect: "reject",
    message: "settlement lines are immutable",
    async arrange(ctx) {
      const a = await arrangeSettlement(ctx);
      const lineId = randomUUID();
      await ctx.client.query("insert into settlement_lines (id, tenant_id, settlement_batch_id, external_line_id, line_type, occurred_at, amount_cents) values ($1, $2, $3, 'it-line-unreferenced', 'platform_fee', now(), -5)", [lineId, a.tenantId, a.batchId]);
      return { ...a, lineId };
    },
    act: (_ctx, a) => ({ sql: "delete from settlement_lines where id = $1", params: [a.lineId] }),
    readBack: lineById
  },
  {
    id: "settlement_lines.validate_tenant_link.insert.accept",
    table: LINES, trigger: LINE_LINK_TRIGGER, op: "INSERT", expect: "accept",
    async arrange(ctx) { return { ...(await arrangeSettlement(ctx)), lineId: randomUUID() }; },
    act: (_ctx, a) => ({ sql: "insert into settlement_lines (id, tenant_id, settlement_batch_id, external_line_id, line_type, occurred_at, amount_cents) values ($1, $2, $3, 'it-line-2', 'refund', now(), -40)", params: [a.lineId, a.tenantId, a.batchId] }),
    readBack: lineById,
    expectedAfter: (a) => [{ id: a.lineId, amount_cents: "-40", settlement_batch_id: a.batchId }]
  },
  {
    id: "settlement_lines.validate_tenant_link.insert.cross_tenant.reject",
    table: LINES, trigger: LINE_LINK_TRIGGER, op: "INSERT", expect: "reject",
    message: "settlement line must belong to a batch in the same tenant",
    async arrange(ctx) {
      const a = await arrangeSettlement(ctx);
      return { ...a, otherTenantId: await ctx.seed.tenant(), lineId: randomUUID() };
    },
    act: (_ctx, a) => ({ sql: "insert into settlement_lines (id, tenant_id, settlement_batch_id, external_line_id, line_type, occurred_at, amount_cents) values ($1, $2, $3, 'it-line-x', 'gross_sale', now(), 10)", params: [a.lineId, a.otherTenantId, a.batchId] }),
    readBack: lineById
  },
  {
    id: "settlement_reconciliation_exceptions.governed_mutation.update.resolve.accept",
    table: EXCEPTIONS, trigger: EXCEPTION_TRIGGER, op: "UPDATE", updatedColumns: ["status", "resolved_by", "resolved_at", "resolution", "resolution_evidence_ref"], expect: "accept",
    arrange: (ctx) => arrangeSettlement(ctx),
    act: resolveSql(),
    readBack: exceptionById,
    expectedAfter: (a) => [{ id: a.exceptionId, status: "resolved", resolved_by: a.memberId, resolution: "Integration settlement resolution" }]
  },
  {
    id: "settlement_reconciliation_exceptions.governed_mutation.update.facts.reject",
    table: EXCEPTIONS, trigger: EXCEPTION_TRIGGER, op: "UPDATE", updatedColumns: ["status", "detail"], expect: "reject",
    message: "settlement exception facts are immutable",
    arrange: (ctx) => arrangeSettlement(ctx),
    act: resolveSql("Mutated settlement detail"),
    readBack: exceptionById
  },
  {
    id: "settlement_reconciliation_exceptions.governed_mutation.update.reopen.reject",
    table: EXCEPTIONS, trigger: EXCEPTION_TRIGGER, op: "UPDATE", updatedColumns: ["status"], expect: "reject",
    message: "resolved settlement exceptions are immutable",
    async arrange(ctx) {
      const a = await arrangeSettlement(ctx);
      const resolve = resolveSql()(ctx, a);
      await ctx.client.query(resolve.sql, resolve.params);
      return a;
    },
    act: (_ctx, a) => ({ sql: "update settlement_reconciliation_exceptions set status = 'open', resolved_by = null, resolved_at = null, resolution = null, resolution_evidence_ref = null where id = $1", params: [a.exceptionId] }),
    readBack: exceptionById
  },
  {
    id: "settlement_reconciliation_exceptions.governed_mutation.delete.reject",
    table: EXCEPTIONS, trigger: EXCEPTION_TRIGGER, op: "DELETE", expect: "reject",
    message: "settlement exceptions are immutable",
    arrange: (ctx) => arrangeSettlement(ctx),
    act: (_ctx, a) => ({ sql: "delete from settlement_reconciliation_exceptions where id = $1", params: [a.exceptionId] }),
    readBack: exceptionById
  },
  {
    id: "settlement_reconciliation_exceptions.validate_tenant_link.insert.foreign_line.reject",
    table: EXCEPTIONS, trigger: EXCEPTION_LINK_TRIGGER, op: "INSERT", expect: "reject",
    message: "settlement exception line must belong to its batch",
    async arrange(ctx) {
      const a = await arrangeSettlement(ctx);
      const other = await arrangeSettlement(ctx);
      return { ...a, foreignLineId: other.lineId, exceptionId: randomUUID() };
    },
    act: (_ctx, a) => ({ sql: "insert into settlement_reconciliation_exceptions (id, tenant_id, settlement_batch_id, settlement_line_id, exception_type, detail) values ($1, $2, $3, $4, 'unattributable_statement_line', 'Foreign line')", params: [a.exceptionId, a.tenantId, a.batchId, a.foreignLineId] }),
    readBack: exceptionById
  },
  {
    id: "settlement_reconciliation_exceptions.validate_tenant_link.insert.accept",
    table: EXCEPTIONS, trigger: EXCEPTION_LINK_TRIGGER, op: "INSERT", expect: "accept",
    async arrange(ctx) { return { ...(await arrangeSettlement(ctx)), exceptionId: randomUUID() }; },
    act: (_ctx, a) => ({ sql: "insert into settlement_reconciliation_exceptions (id, tenant_id, settlement_batch_id, exception_type, detail) values ($1, $2, $3, 'statement_net_mismatch', 'Net mismatch')", params: [a.exceptionId, a.tenantId, a.batchId] }),
    readBack: exceptionById,
    expectedAfter: (a) => [{ id: a.exceptionId, status: "open", detail: "Net mismatch", resolved_by: null }]
  },
  {
    // The governed trigger fires first (name order) and passes a legal resolution; the link trigger then accepts.
    id: "settlement_reconciliation_exceptions.validate_tenant_link.update.resolve.accept",
    table: EXCEPTIONS, trigger: EXCEPTION_LINK_TRIGGER, op: "UPDATE", updatedColumns: ["status", "resolved_by"], expect: "accept",
    arrange: (ctx) => arrangeSettlement(ctx),
    act: resolveSql(),
    readBack: exceptionById,
    expectedAfter: (a) => [{ id: a.exceptionId, status: "resolved", resolved_by: a.memberId }]
  }
];
