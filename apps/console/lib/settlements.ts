import type { RequestContext } from "@/lib/control-plane/auth-context";
import { requireTenantWideAccess } from "@/lib/control-plane/auth-context";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { isControlledEvidenceRef } from "@/lib/governance-input";

export const settlementLineTypes = ["gross_sale", "refund", "platform_fee", "adjustment", "payout"] as const;
export const settlementExceptionTypes = ["missing_operational_event", "missing_settlement_line", "gross_amount_mismatch", "refund_amount_mismatch", "unattributable_statement_line", "statement_net_mismatch"] as const;
export type SettlementLineType = typeof settlementLineTypes[number];
export type SettlementExceptionType = typeof settlementExceptionTypes[number];
export type SettlementBatchStatus = "imported" | "review_required" | "reconciled";
export type SettlementExceptionStatus = "open" | "resolved";
export type SettlementLine = { id: string; tenantId: string; batchId: string; externalLineId: string; lineType: SettlementLineType; externalOrderReference?: string; occurredAt: string; amountCents: number };
export type SettlementException = { id: string; tenantId: string; batchId: string; settlementLineId?: string; liveRunId?: string; orderReference?: string; exceptionType: SettlementExceptionType; expectedAmountCents?: number; actualAmountCents?: number; detail: string; status: SettlementExceptionStatus; resolvedBy?: string; resolvedAt?: string; resolution?: string; resolutionEvidenceRef?: string; createdAt: string };
export type SettlementBatch = { id: string; tenantId: string; channelConnectionId: string; providerStatementRef: string; periodStart: string; periodEnd: string; statementGeneratedAt?: string; sourceSha256: string; evidenceRef: string; importedBy: string; importedAt: string; status: SettlementBatchStatus; lines: SettlementLine[]; exceptions: SettlementException[] };
export type ImportSettlementBatchInput = { channelConnectionId: string; providerStatementRef: string; periodStart: string; periodEnd: string; statementGeneratedAt?: string; sourceSha256: string; evidenceRef: string; lines: Array<Omit<SettlementLine, "id" | "tenantId" | "batchId">> };

type SettlementStore = { batches: Map<string, SettlementBatch> };
type BatchRow = { id: string; tenant_id: string; channel_connection_id: string; provider_statement_ref: string; period_start: Date | string; period_end: Date | string; statement_generated_at: Date | string | null; source_sha256: string; evidence_ref: string; imported_by_subject: string; imported_at: Date | string; status: SettlementBatchStatus };
type LineRow = { id: string; tenant_id: string; settlement_batch_id: string; external_line_id: string; line_type: SettlementLineType; external_order_reference: string | null; occurred_at: Date | string; amount_cents: number | string };
type ExceptionRow = { id: string; tenant_id: string; settlement_batch_id: string; settlement_line_id: string | null; live_run_id: string | null; order_reference: string | null; exception_type: SettlementExceptionType; expected_amount_cents: number | string | null; actual_amount_cents: number | string | null; detail: string; status: SettlementExceptionStatus; resolved_by_subject: string | null; resolved_at: Date | string | null; resolution: string | null; resolution_evidence_ref: string | null; created_at: Date | string };
type OperationalRow = { order_reference: string; event_type: "order_paid" | "refund"; amount_cents: string | number; live_run_id: string | null };

declare global { var shuzhirenSettlementStore: SettlementStore | undefined; }
function settlementStore() { globalThis.shuzhirenSettlementStore ??= { batches: new Map() }; return globalThis.shuzhirenSettlementStore; }

export async function importSettlementBatch(context: RequestContext, rawInput: ImportSettlementBatchInput): Promise<SettlementBatch & { duplicate?: boolean }> {
  const input = normalizeImport(rawInput);
  if (!databasePool()) return importDemoBatch(context, input);
  return withTenantTransaction(context.tenantId, async (client) => {
    const existing = await client.query<BatchRow>(`select b.id, b.tenant_id, b.channel_connection_id, b.provider_statement_ref, b.period_start, b.period_end, b.statement_generated_at, b.source_sha256, b.evidence_ref, u.external_subject as imported_by_subject, b.imported_at, b.status from settlement_batches b join users u on u.id = b.imported_by where b.channel_connection_id = $1 and b.provider_statement_ref = $2`, [input.channelConnectionId, input.providerStatementRef]);
    if (existing.rows[0]) {
      const batch = persistentBatch(existing.rows[0], [], []);
      if (batch.sourceSha256 !== input.sourceSha256 || batch.evidenceRef !== input.evidenceRef || batch.periodStart !== input.periodStart || batch.periodEnd !== input.periodEnd) throw new Response("Provider statement reference was already imported with different source evidence", { status: 409 });
      return { ...(await getSettlementBatchInTransaction(client, batch.id)), duplicate: true };
    }
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const batch = await client.query<BatchRow>(`insert into settlement_batches (tenant_id, channel_connection_id, provider_statement_ref, period_start, period_end, statement_generated_at, source_sha256, evidence_ref, imported_by, status) values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7, $8, $9, 'imported') returning id, tenant_id, channel_connection_id, provider_statement_ref, period_start, period_end, statement_generated_at, source_sha256, evidence_ref, $10::text as imported_by_subject, imported_at, status`, [context.tenantId, input.channelConnectionId, input.providerStatementRef, input.periodStart, input.periodEnd, input.statementGeneratedAt ?? null, input.sourceSha256, input.evidenceRef, actor.rows[0].id, context.actorId]);
    const lines: SettlementLine[] = [];
    for (const line of input.lines) {
      const result = await client.query<LineRow>(`insert into settlement_lines (tenant_id, settlement_batch_id, external_line_id, line_type, external_order_reference, occurred_at, amount_cents) values ($1, $2, $3, $4::settlement_line_type, $5, $6::timestamptz, $7) returning id, tenant_id, settlement_batch_id, external_line_id, line_type, external_order_reference, occurred_at, amount_cents`, [context.tenantId, batch.rows[0].id, line.externalLineId, line.lineType, line.externalOrderReference ?? null, line.occurredAt, line.amountCents]);
      lines.push(persistentLine(result.rows[0]));
    }
    const operational = await client.query<OperationalRow>(`select order_reference, event_type, sum(amount_cents)::text as amount_cents, min(live_run_id)::text as live_run_id from commerce_events where channel_connection_id = $1 and occurred_at >= $2::timestamptz and occurred_at < $3::timestamptz and event_type in ('order_paid', 'refund') and order_reference is not null group by order_reference, event_type`, [input.channelConnectionId, input.periodStart, input.periodEnd]);
    const candidates = reconciliationCandidates(lines, operational.rows);
    const exceptions: SettlementException[] = [];
    for (const candidate of candidates) {
      const result = await client.query<ExceptionRow>(`insert into settlement_reconciliation_exceptions (tenant_id, settlement_batch_id, settlement_line_id, live_run_id, order_reference, exception_type, expected_amount_cents, actual_amount_cents, detail) values ($1, $2, $3, $4, $5, $6::settlement_exception_type, $7, $8, $9) returning id, tenant_id, settlement_batch_id, settlement_line_id, live_run_id, order_reference, exception_type, expected_amount_cents, actual_amount_cents, detail, status, null::text as resolved_by_subject, resolved_at, resolution, resolution_evidence_ref, created_at`, [context.tenantId, batch.rows[0].id, candidate.settlementLineId ?? null, candidate.liveRunId ?? null, candidate.orderReference ?? null, candidate.exceptionType, candidate.expectedAmountCents ?? null, candidate.actualAmountCents ?? null, candidate.detail]);
      exceptions.push(persistentException(result.rows[0]));
    }
    const status: SettlementBatchStatus = exceptions.length ? "review_required" : "reconciled";
    await client.query("update settlement_batches set status = $2::settlement_batch_status where id = $1", [batch.rows[0].id, status]);
    const result = persistentBatch({ ...batch.rows[0], status }, lines, exceptions);
    await recordAuditEventInTransaction(client, context, { type: "settlement_batch.imported", resource: "settlement_batch", resourceId: result.id, detail: { channelConnectionId: result.channelConnectionId, providerStatementRef: result.providerStatementRef, sourceSha256: result.sourceSha256, evidenceRef: result.evidenceRef, lineCount: lines.length, exceptionCount: exceptions.length } });
    return result;
  });
}

export async function listSettlementBatches(context: RequestContext) {
  requireTenantWideAccess(context);
  if (!databasePool()) return [...settlementStore().batches.values()].filter((batch) => batch.tenantId === context.tenantId).sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<BatchRow>(`select b.id, b.tenant_id, b.channel_connection_id, b.provider_statement_ref, b.period_start, b.period_end, b.statement_generated_at, b.source_sha256, b.evidence_ref, u.external_subject as imported_by_subject, b.imported_at, b.status from settlement_batches b join users u on u.id = b.imported_by order by b.imported_at desc`);
    return Promise.all(result.rows.map(async (row) => getSettlementBatchInTransaction(client, row.id)));
  });
}

export async function getSettlementBatch(context: RequestContext, batchId: string) {
  requireTenantWideAccess(context);
  if (!databasePool()) return settlementStore().batches.get(batchId) ?? null;
  return withTenantTransaction(context.tenantId, async (client) => getSettlementBatchInTransaction(client, batchId));
}

export async function resolveSettlementException(context: RequestContext, exceptionId: string, resolution: string, resolutionEvidenceRef: string) {
  requireTenantWideAccess(context);
  if (!["admin", "reviewer"].includes(context.role)) throw new Response("Insufficient permission", { status: 403 });
  const normalizedResolution = resolution.trim();
  if (normalizedResolution.length < 10 || normalizedResolution.length > 2000 || !isControlledEvidenceRef(resolutionEvidenceRef)) throw new Response("Settlement exception resolution is invalid", { status: 400 });
  if (!databasePool()) {
    for (const batch of settlementStore().batches.values()) {
      const exception = batch.exceptions.find((candidate) => candidate.id === exceptionId && candidate.tenantId === context.tenantId);
      if (!exception) continue;
      if (exception.status !== "open") throw new Response("Settlement exception is already resolved", { status: 409 });
      Object.assign(exception, { status: "resolved", resolvedBy: context.actorId, resolvedAt: new Date().toISOString(), resolution: normalizedResolution, resolutionEvidenceRef });
      if (!batch.exceptions.some((candidate) => candidate.status === "open")) batch.status = "reconciled";
      await recordAuditEvent(context, { type: "settlement_exception.resolved", resource: "settlement_exception", resourceId: exception.id, detail: { batchId: batch.id, evidenceRef: resolutionEvidenceRef } });
      return exception;
    }
    throw new Response("Settlement exception not found", { status: 404 });
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<ExceptionRow>(`update settlement_reconciliation_exceptions e set status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3, resolution_evidence_ref = $4 where e.id = $1 and e.status = 'open' returning e.id, e.tenant_id, e.settlement_batch_id, e.settlement_line_id, e.live_run_id, e.order_reference, e.exception_type, e.expected_amount_cents, e.actual_amount_cents, e.detail, e.status, $5::text as resolved_by_subject, e.resolved_at, e.resolution, e.resolution_evidence_ref, e.created_at`, [exceptionId, actor.rows[0].id, normalizedResolution, resolutionEvidenceRef, context.actorId]);
    if (!result.rows[0]) throw new Response("Settlement exception not found or already resolved", { status: 404 });
    const exception = persistentException(result.rows[0]);
    const remaining = await client.query<{ count: string }>("select count(*)::text as count from settlement_reconciliation_exceptions where settlement_batch_id = $1 and status = 'open'", [exception.batchId]);
    if (Number(remaining.rows[0].count) === 0) await client.query("update settlement_batches set status = 'reconciled' where id = $1 and status in ('imported', 'review_required')", [exception.batchId]);
    await recordAuditEventInTransaction(client, context, { type: "settlement_exception.resolved", resource: "settlement_exception", resourceId: exception.id, detail: { batchId: exception.batchId, evidenceRef: resolutionEvidenceRef } });
    return exception;
  });
}

async function importDemoBatch(context: RequestContext, input: NormalizedImport): Promise<SettlementBatch & { duplicate?: boolean }> {
  const existing = [...settlementStore().batches.values()].find((batch) => batch.tenantId === context.tenantId && batch.channelConnectionId === input.channelConnectionId && batch.providerStatementRef === input.providerStatementRef);
  if (existing) {
    if (existing.sourceSha256 !== input.sourceSha256 || existing.evidenceRef !== input.evidenceRef || existing.periodStart !== input.periodStart || existing.periodEnd !== input.periodEnd) throw new Response("Provider statement reference was already imported with different source evidence", { status: 409 });
    return { ...existing, duplicate: true };
  }
  const id = `settlement_${crypto.randomUUID()}`;
  const lines = input.lines.map((line) => ({ ...line, id: `settlement-line_${crypto.randomUUID()}`, tenantId: context.tenantId, batchId: id }));
  const exceptions = reconciliationCandidates(lines, []).map((candidate) => ({ id: `settlement-exception_${crypto.randomUUID()}`, tenantId: context.tenantId, batchId: id, status: "open" as const, createdAt: new Date().toISOString(), ...candidate }));
  const batch: SettlementBatch = { id, tenantId: context.tenantId, channelConnectionId: input.channelConnectionId, providerStatementRef: input.providerStatementRef, periodStart: input.periodStart, periodEnd: input.periodEnd, statementGeneratedAt: input.statementGeneratedAt, sourceSha256: input.sourceSha256, evidenceRef: input.evidenceRef, importedBy: context.actorId, importedAt: new Date().toISOString(), status: exceptions.length ? "review_required" : "reconciled", lines, exceptions };
  settlementStore().batches.set(id, batch);
  await recordAuditEvent(context, { type: "settlement_batch.imported", resource: "settlement_batch", resourceId: id, detail: { channelConnectionId: batch.channelConnectionId, providerStatementRef: batch.providerStatementRef, sourceSha256: batch.sourceSha256, evidenceRef: batch.evidenceRef, lineCount: lines.length, exceptionCount: exceptions.length } });
  return batch;
}

type NormalizedImport = Omit<ImportSettlementBatchInput, "lines"> & { lines: SettlementLine[] };
function normalizeImport(value: ImportSettlementBatchInput): NormalizedImport {
  if (!value || typeof value !== "object" || !identifier(value.channelConnectionId) || !identifier(value.providerStatementRef) || !validDate(value.periodStart) || !validDate(value.periodEnd) || Date.parse(value.periodEnd) <= Date.parse(value.periodStart) || !/^[a-f0-9]{64}$/.test(value.sourceSha256) || !isControlledEvidenceRef(value.evidenceRef) || (value.statementGeneratedAt !== undefined && !validDate(value.statementGeneratedAt)) || !Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > 1000) throw new Response("Settlement batch input is invalid", { status: 400 });
  const ids = new Set<string>();
  const lines = value.lines.map((line) => {
    if (!line || typeof line !== "object" || !identifier(line.externalLineId) || ids.has(line.externalLineId) || !settlementLineTypes.includes(line.lineType) || !validDate(line.occurredAt) || !Number.isSafeInteger(line.amountCents) || Math.abs(line.amountCents) > 1_000_000_000_000 || !validLineAmount(line.lineType, line.amountCents) || (line.externalOrderReference !== undefined && !orderReference(line.externalOrderReference))) throw new Response("Settlement line is invalid", { status: 400 });
    ids.add(line.externalLineId);
    return { ...line, id: "", tenantId: "", batchId: "", externalOrderReference: line.externalOrderReference?.trim() };
  });
  return { ...value, channelConnectionId: value.channelConnectionId.trim(), providerStatementRef: value.providerStatementRef.trim(), periodStart: new Date(value.periodStart).toISOString(), periodEnd: new Date(value.periodEnd).toISOString(), statementGeneratedAt: value.statementGeneratedAt ? new Date(value.statementGeneratedAt).toISOString() : undefined, sourceSha256: value.sourceSha256, evidenceRef: value.evidenceRef.trim(), lines };
}

function reconciliationCandidates(lines: SettlementLine[], operational: OperationalRow[]) {
  const candidates: Array<Omit<SettlementException, "id" | "tenantId" | "batchId" | "status" | "createdAt">> = [];
  const operationalByKey = new Map(operational.map((row) => [`${row.event_type}:${row.order_reference}`, { amount: Number(row.amount_cents), liveRunId: row.live_run_id ?? undefined }]));
  const settlementByKey = new Map<string, { amount: number; line: SettlementLine }>();
  for (const line of lines) {
    if (line.lineType !== "gross_sale" && line.lineType !== "refund") continue;
    if (!line.externalOrderReference) {
      candidates.push({ exceptionType: "unattributable_statement_line", settlementLineId: line.id || undefined, actualAmountCents: line.amountCents, detail: "平台销售或退款账单行缺少可对账的订单引用" });
      continue;
    }
    const key = `${line.lineType === "gross_sale" ? "order_paid" : "refund"}:${line.externalOrderReference}`;
    const existing = settlementByKey.get(key);
    settlementByKey.set(key, { amount: (existing?.amount ?? 0) + Math.abs(line.amountCents), line });
  }
  for (const [key, settlement] of settlementByKey) {
    const operationalEvent = operationalByKey.get(key);
    if (!operationalEvent) candidates.push({ exceptionType: "missing_operational_event", settlementLineId: settlement.line.id || undefined, orderReference: settlement.line.externalOrderReference, actualAmountCents: settlement.amount, detail: "平台账单存在销售或退款，但运营事件中没有对应订单事实" });
    else if (operationalEvent.amount !== settlement.amount) candidates.push({ exceptionType: key.startsWith("order_paid:") ? "gross_amount_mismatch" : "refund_amount_mismatch", settlementLineId: settlement.line.id || undefined, liveRunId: operationalEvent.liveRunId, orderReference: settlement.line.externalOrderReference, expectedAmountCents: operationalEvent.amount, actualAmountCents: settlement.amount, detail: "平台账单金额与运营事件聚合金额不一致" });
  }
  for (const [key, operationalEvent] of operationalByKey) if (!settlementByKey.has(key)) candidates.push({ exceptionType: "missing_settlement_line", liveRunId: operationalEvent.liveRunId, orderReference: key.slice(key.indexOf(":") + 1), expectedAmountCents: operationalEvent.amount, detail: "运营事件存在销售或退款，但平台账单中没有对应订单行" });
  const totals = Object.fromEntries(settlementLineTypes.map((type) => [type, lines.filter((line) => line.lineType === type).reduce((sum, line) => sum + line.amountCents, 0)])) as Record<SettlementLineType, number>;
  const statementNet = totals.gross_sale + totals.refund + totals.platform_fee + totals.adjustment;
  if (totals.payout !== 0 && statementNet !== totals.payout) candidates.push({ exceptionType: "statement_net_mismatch", expectedAmountCents: statementNet, actualAmountCents: totals.payout, detail: "账单销售、退款、费用和调整后的净额与平台声明打款额不一致" });
  return candidates;
}

async function getSettlementBatchInTransaction(client: import("pg").PoolClient, batchId: string): Promise<SettlementBatch> {
  const batch = await client.query<BatchRow>(`select b.id, b.tenant_id, b.channel_connection_id, b.provider_statement_ref, b.period_start, b.period_end, b.statement_generated_at, b.source_sha256, b.evidence_ref, u.external_subject as imported_by_subject, b.imported_at, b.status from settlement_batches b join users u on u.id = b.imported_by where b.id = $1`, [batchId]);
  if (!batch.rows[0]) throw new Response("Settlement batch not found", { status: 404 });
  const [lines, exceptions] = await Promise.all([
    client.query<LineRow>("select id, tenant_id, settlement_batch_id, external_line_id, line_type, external_order_reference, occurred_at, amount_cents from settlement_lines where settlement_batch_id = $1 order by occurred_at, external_line_id", [batchId]),
    client.query<ExceptionRow>(`select e.id, e.tenant_id, e.settlement_batch_id, e.settlement_line_id, e.live_run_id, e.order_reference, e.exception_type, e.expected_amount_cents, e.actual_amount_cents, e.detail, e.status, u.external_subject as resolved_by_subject, e.resolved_at, e.resolution, e.resolution_evidence_ref, e.created_at from settlement_reconciliation_exceptions e left join users u on u.id = e.resolved_by where e.settlement_batch_id = $1 order by e.created_at`, [batchId])
  ]);
  return persistentBatch(batch.rows[0], lines.rows.map(persistentLine), exceptions.rows.map(persistentException));
}

function persistentBatch(row: BatchRow, lines: SettlementLine[], exceptions: SettlementException[]): SettlementBatch { return { id: row.id, tenantId: row.tenant_id, channelConnectionId: row.channel_connection_id, providerStatementRef: row.provider_statement_ref, periodStart: new Date(row.period_start).toISOString(), periodEnd: new Date(row.period_end).toISOString(), statementGeneratedAt: row.statement_generated_at ? new Date(row.statement_generated_at).toISOString() : undefined, sourceSha256: row.source_sha256, evidenceRef: row.evidence_ref, importedBy: row.imported_by_subject, importedAt: new Date(row.imported_at).toISOString(), status: row.status, lines, exceptions }; }
function persistentLine(row: LineRow): SettlementLine { return { id: row.id, tenantId: row.tenant_id, batchId: row.settlement_batch_id, externalLineId: row.external_line_id, lineType: row.line_type, externalOrderReference: row.external_order_reference ?? undefined, occurredAt: new Date(row.occurred_at).toISOString(), amountCents: Number(row.amount_cents) }; }
function persistentException(row: ExceptionRow): SettlementException { return { id: row.id, tenantId: row.tenant_id, batchId: row.settlement_batch_id, settlementLineId: row.settlement_line_id ?? undefined, liveRunId: row.live_run_id ?? undefined, orderReference: row.order_reference ?? undefined, exceptionType: row.exception_type, expectedAmountCents: row.expected_amount_cents === null ? undefined : Number(row.expected_amount_cents), actualAmountCents: row.actual_amount_cents === null ? undefined : Number(row.actual_amount_cents), detail: row.detail, status: row.status, resolvedBy: row.resolved_by_subject ?? undefined, resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined, resolution: row.resolution ?? undefined, resolutionEvidenceRef: row.resolution_evidence_ref ?? undefined, createdAt: new Date(row.created_at).toISOString() }; }
function identifier(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200; }
function orderReference(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value); }
function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validLineAmount(type: SettlementLineType, amount: number) { return (type === "gross_sale" && amount > 0) || ((type === "refund" || type === "platform_fee") && amount < 0) || ((type === "adjustment" || type === "payout") && amount !== 0); }
