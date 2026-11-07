// Prohibited terms (migration 088): tenant_prohibited_terms_governed_mutation,
// tenant_prohibited_term_revisions_governed_mutation, show_revision_prohibited_term_snapshots_governed and
// show_revisions_require_lexicon_snapshot. Message texts are the raise exception texts of the functions in 088, or the
// constraint names PostgreSQL puts into its error for the declarative rules (loosening needs a reason and a second approver).
import { randomUUID } from "node:crypto";

const TERMS = "tenant_prohibited_terms";
const TERM_TRIGGER = "tenant_prohibited_terms_governed_mutation";
const REVISIONS = "tenant_prohibited_term_revisions";
const REVISION_TRIGGER = "tenant_prohibited_term_revisions_governed_mutation";
const SNAPSHOTS = "show_revision_prohibited_term_snapshots";
const SNAPSHOT_TRIGGER = "show_revision_prohibited_term_snapshots_governed";
const SHOW_REVISIONS = "show_revisions";
const APPROVAL_TRIGGER = "show_revisions_require_lexicon_snapshot";
const LOOSENING_REASON = "Legal confirmed this wording is allowed here.";
const SUGGESTIONS = ["活动价", "优惠价"];

const readTerm = (_ctx, a) => ({ sql: "select id, kind, term, approved_revision, severity, suggestions, disabled, active from tenant_prohibited_terms where id = $1", params: [a.termId] });
const readRevision = (_ctx, a) => ({ sql: "select id, term_id, revision, severity, suggestions, disabled, active, loosening, reason, status, decided_by from tenant_prohibited_term_revisions where id = $1", params: [a.revisionId] });
const readSnapshot = (_ctx, a) => ({ sql: "select show_revision_id, builtin_version, lexicon, term_count from show_revision_prohibited_term_snapshots where show_revision_id = $1", params: [a.showRevisionId] });
const readShowRevision = (_ctx, a) => ({ sql: "select id, approval_status from show_revisions where id = $1", params: [a.showRevisionId] });

/** A tenant with a requester and a second member who can approve. */
async function people(ctx) {
  const tenantId = await ctx.seed.tenant();
  const requesterId = await ctx.seed.member({ tenantId, role: "admin" });
  const approverId = await ctx.seed.member({ tenantId, role: "reviewer" });
  return { tenantId, requesterId, approverId };
}

async function insertTerm({ client }, { tenantId, userId, kind = "custom", id = randomUUID(), term = `特价秒杀${id.slice(0, 6)}`, builtinTermId = "builtin:extreme:001", category = "custom" }) {
  const custom = kind === "custom";
  await client.query(
    "insert into tenant_prohibited_terms (id, tenant_id, kind, builtin_term_id, term, normalized_term, category, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [id, tenantId, kind, custom ? null : builtinTermId, custom ? term : null, custom ? term.toLowerCase() : null, category, userId]
  );
  return id;
}

async function insertRevision({ client }, { tenantId, termId, userId, revision = 1, severity = "block", suggestions = SUGGESTIONS, disabled = false, active = true, loosening = false, reason = null, id = randomUUID() }) {
  await client.query(
    "insert into tenant_prohibited_term_revisions (id, tenant_id, term_id, revision, severity, suggestions, disabled, active, loosening, reason, requested_by) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)",
    [id, tenantId, termId, revision, severity, JSON.stringify(suggestions), disabled, active, loosening, reason, userId]
  );
  return id;
}

const decideRevision = ({ client }, { revisionId, decidedBy, status = "approved" }) =>
  client.query("update tenant_prohibited_term_revisions set status = $3, decided_by = $2, decided_at = now() where id = $1", [revisionId, decidedBy, status]);

/** A custom term with an approved revision 1 (block, two suggestions); the term row still carries no approved values. */
async function approvedRevisionFixture(ctx) {
  const base = await people(ctx);
  const termId = await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId });
  const revisionId = await insertRevision(ctx, { tenantId: base.tenantId, termId, userId: base.requesterId });
  await decideRevision(ctx, { revisionId, decidedBy: base.approverId });
  return { ...base, termId, revisionId };
}

/** A custom term whose revision 1 is applied, so the term row carries the approved values. */
async function appliedTermFixture(ctx) {
  const fixture = await approvedRevisionFixture(ctx);
  await ctx.client.query("update tenant_prohibited_terms set approved_revision = 1, severity = 'block', suggestions = $2::jsonb, disabled = false, active = true, approved_at = (select decided_at from tenant_prohibited_term_revisions where id = $3) where id = $1", [fixture.termId, JSON.stringify(SUGGESTIONS), fixture.revisionId]);
  return fixture;
}

/** An update of the effective values of the term; `set` replaces parts of the legal `to revision 1` statement. */
function rejectedTermUpdate(name, message, { arrange = approvedRevisionFixture, set }) {
  return {
    id: `tenant_prohibited_terms.governed.update.${name}.reject`,
    table: TERMS, trigger: TERM_TRIGGER, op: "UPDATE", expect: "reject", message,
    arrange,
    act: (_ctx, a) => ({ sql: `update tenant_prohibited_terms set ${set(a)} where id = $1`, params: [a.termId] }),
    readBack: readTerm
  };
}
const approvedAt = (a) => `(select decided_at from tenant_prohibited_term_revisions where id = '${a.revisionId}')`;

async function revisionInDraft(ctx, { snapshot = false } = {}) {
  const tenantId = await ctx.seed.tenant();
  const memberId = await ctx.seed.member({ tenantId, role: "admin" });
  const { revisionId: showRevisionId } = await ctx.seed.revision({ tenantId, approver: memberId, segments: [], approve: false });
  if (snapshot) await insertSnapshot(ctx, { tenantId, showRevisionId });
  return { tenantId, memberId, showRevisionId };
}
const insertSnapshot = ({ client }, { tenantId, showRevisionId }) =>
  client.query("insert into show_revision_prohibited_term_snapshots (tenant_id, show_revision_id, builtin_version, lexicon, lexicon_sha256, term_count) values ($1, $2, 'test-1', '[]'::jsonb, repeat('0', 64), 0)", [tenantId, showRevisionId]);
const approveShowRevision = ({ client }, a) =>
  client.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [a.showRevisionId, a.memberId]);

export default [
  // tenant_prohibited_terms_governed_mutation
  {
    id: "tenant_prohibited_terms.governed.insert.unapproved_custom.accept",
    table: TERMS, trigger: TERM_TRIGGER, op: "INSERT", expect: "accept",
    arrange: async (ctx) => ({ ...(await people(ctx)), termId: randomUUID() }),
    act: (_ctx, a) => ({
      sql: "insert into tenant_prohibited_terms (id, tenant_id, kind, term, normalized_term, category, created_by) values ($1, $2, 'custom', '特价秒杀', '特价秒杀', 'custom', $3)",
      params: [a.termId, a.tenantId, a.requesterId]
    }),
    readBack: readTerm,
    expectedAfter: (a) => [{ id: a.termId, kind: "custom", term: "特价秒杀", approved_revision: null, severity: null, suggestions: null, disabled: false, active: true }]
  },
  {
    id: "tenant_prohibited_terms.governed.insert.with_approved_values.reject",
    table: TERMS, trigger: TERM_TRIGGER, op: "INSERT", expect: "reject",
    message: "a prohibited term is created without approved values; they come from an approved revision",
    arrange: async (ctx) => ({ ...(await people(ctx)), termId: randomUUID() }),
    act: (_ctx, a) => ({
      sql: "insert into tenant_prohibited_terms (id, tenant_id, kind, term, normalized_term, category, approved_revision, severity, suggestions, approved_at, created_by) values ($1, $2, 'custom', '特价秒杀', '特价秒杀', 'custom', 1, 'warn', '[]'::jsonb, now(), $3)",
      params: [a.termId, a.tenantId, a.requesterId]
    }),
    readBack: readTerm
  },
  {
    id: "tenant_prohibited_terms.governed.update.approved_values.accept",
    table: TERMS, trigger: TERM_TRIGGER, op: "UPDATE", expect: "accept",
    arrange: approvedRevisionFixture,
    act: (_ctx, a) => ({
      sql: `update tenant_prohibited_terms set approved_revision = 1, severity = 'block', suggestions = '["活动价","优惠价"]'::jsonb, disabled = false, active = true, approved_at = ${approvedAt(a)} where id = $1`,
      params: [a.termId]
    }),
    readBack: readTerm,
    expectedAfter: (a) => [{ id: a.termId, approved_revision: 1, severity: "block", suggestions: SUGGESTIONS, disabled: false, active: true }]
  },
  rejectedTermUpdate("without_approved_revision", "the approved values of a prohibited term must equal those of an approved revision", {
    arrange: async (ctx) => {
      const base = await people(ctx);
      const termId = await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId });
      const revisionId = await insertRevision(ctx, { tenantId: base.tenantId, termId, userId: base.requesterId });
      return { ...base, termId, revisionId };
    },
    set: () => "approved_revision = 1, severity = 'block', suggestions = '[\"活动价\",\"优惠价\"]'::jsonb, approved_at = now()"
  }),
  rejectedTermUpdate("values_differ_from_revision", "the approved values of a prohibited term must equal those of an approved revision", {
    set: (a) => `approved_revision = 1, severity = 'warn', suggestions = '["活动价","优惠价"]'::jsonb, approved_at = ${approvedAt(a)}`
  }),
  rejectedTermUpdate("approved_at_differs_from_revision", "the approved values of a prohibited term must equal those of an approved revision", {
    set: () => "approved_revision = 1, severity = 'block', suggestions = '[\"活动价\",\"优惠价\"]'::jsonb, approved_at = now() + interval '1 day'"
  }),
  rejectedTermUpdate("revision_not_increasing", "the approved revision of a prohibited term must increase", {
    arrange: appliedTermFixture,
    set: () => "approved_revision = 1, severity = 'warn'"
  }),
  rejectedTermUpdate("severity_without_revision", "the approved revision of a prohibited term must increase", {
    arrange: appliedTermFixture,
    set: () => "severity = 'warn'"
  }),
  rejectedTermUpdate("identity", "prohibited term identity is immutable", {
    arrange: appliedTermFixture,
    set: () => "term = '改写后的词', normalized_term = '改写后的词'"
  }),
  {
    id: "tenant_prohibited_terms.governed.delete.reject",
    table: TERMS, trigger: TERM_TRIGGER, op: "DELETE", expect: "reject",
    message: "prohibited terms are retained for audit; request a change that turns the term off instead",
    arrange: approvedRevisionFixture,
    act: (_ctx, a) => ({ sql: "delete from tenant_prohibited_terms where id = $1", params: [a.termId] }),
    readBack: readTerm
  },

  // tenant_prohibited_term_revisions_governed_mutation
  {
    id: "tenant_prohibited_term_revisions.governed.insert.first_revision.accept",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "INSERT", expect: "accept",
    arrange: async (ctx) => {
      const base = await people(ctx);
      return { ...base, termId: await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId }), revisionId: randomUUID() };
    },
    act: (_ctx, a) => ({
      sql: "insert into tenant_prohibited_term_revisions (id, tenant_id, term_id, revision, severity, suggestions, disabled, active, loosening, requested_by) values ($1, $2, $3, 1, 'block', '[]'::jsonb, false, true, false, $4)",
      params: [a.revisionId, a.tenantId, a.termId, a.requesterId]
    }),
    readBack: readRevision,
    expectedAfter: (a) => [{ id: a.revisionId, term_id: a.termId, revision: 1, status: "pending", loosening: false, decided_by: null }]
  },
  {
    id: "tenant_prohibited_term_revisions.governed.insert.loosening_with_reason.accept",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "INSERT", expect: "accept",
    arrange: async (ctx) => {
      const base = await people(ctx);
      const termId = await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId });
      const first = await insertRevision(ctx, { tenantId: base.tenantId, termId, userId: base.requesterId });
      await decideRevision(ctx, { revisionId: first, decidedBy: base.approverId });
      return { ...base, termId, revisionId: randomUUID() };
    },
    act: (_ctx, a) => ({
      sql: "insert into tenant_prohibited_term_revisions (id, tenant_id, term_id, revision, severity, suggestions, disabled, active, loosening, reason, requested_by) values ($1, $2, $3, 2, 'block', '[]'::jsonb, false, false, true, $5, $4)",
      params: [a.revisionId, a.tenantId, a.termId, a.requesterId, LOOSENING_REASON]
    }),
    readBack: readRevision,
    expectedAfter: (a) => [{ id: a.revisionId, revision: 2, active: false, loosening: true, reason: LOOSENING_REASON, status: "pending" }]
  },
  ...[
    ["revision_number_gap", "a prohibited term revision must use the next revision number of its term", 2, "false, true, false"],
    ["turning_off_not_flagged_as_loosening", "a revision that turns a prohibited term off or lowers its severity is a loosening change", 1, "false, false, false"]
  ].map(([name, message, revision, flags]) => ({
    id: `tenant_prohibited_term_revisions.governed.insert.${name}.reject`,
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "INSERT", expect: "reject", message,
    arrange: async (ctx) => {
      const base = await people(ctx);
      return { ...base, termId: await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId }), revisionId: randomUUID() };
    },
    act: (_ctx, a) => ({
      sql: `insert into tenant_prohibited_term_revisions (id, tenant_id, term_id, revision, severity, suggestions, disabled, active, loosening, requested_by) values ($1, $2, $3, ${revision}, 'block', '[]'::jsonb, ${flags}, $4)`,
      params: [a.revisionId, a.tenantId, a.termId, a.requesterId]
    }),
    readBack: readRevision
  })),
  {
    id: "tenant_prohibited_term_revisions.governed.insert.already_approved.reject",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "INSERT", expect: "reject",
    message: "a prohibited term revision is created pending approval",
    arrange: async (ctx) => {
      const base = await people(ctx);
      return { ...base, termId: await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId }), revisionId: randomUUID() };
    },
    act: (_ctx, a) => ({
      sql: "insert into tenant_prohibited_term_revisions (id, tenant_id, term_id, revision, severity, suggestions, disabled, active, loosening, status, requested_by, decided_by, decided_at) values ($1, $2, $3, 1, 'block', '[]'::jsonb, false, true, false, 'approved', $4, $5, now())",
      params: [a.revisionId, a.tenantId, a.termId, a.requesterId, a.approverId]
    }),
    readBack: readRevision
  },
  {
    id: "tenant_prohibited_term_revisions.governed.insert.loosening_without_reason.reject",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "INSERT", expect: "reject",
    message: "tenant_prohibited_term_revisions_loosening_reason_check",
    arrange: async (ctx) => {
      const base = await people(ctx);
      return { ...base, termId: await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId }), revisionId: randomUUID() };
    },
    act: (_ctx, a) => ({
      sql: "insert into tenant_prohibited_term_revisions (id, tenant_id, term_id, revision, severity, suggestions, disabled, active, loosening, requested_by) values ($1, $2, $3, 1, 'block', '[]'::jsonb, false, false, true, $4)",
      params: [a.revisionId, a.tenantId, a.termId, a.requesterId]
    }),
    readBack: readRevision
  },
  {
    id: "tenant_prohibited_term_revisions.governed.update.approve.accept",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "UPDATE", expect: "accept",
    arrange: async (ctx) => {
      const base = await people(ctx);
      const termId = await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId });
      return { ...base, termId, revisionId: await insertRevision(ctx, { tenantId: base.tenantId, termId, userId: base.requesterId }) };
    },
    act: (_ctx, a) => ({ sql: "update tenant_prohibited_term_revisions set status = 'approved', decided_by = $2, decided_at = now() where id = $1", params: [a.revisionId, a.approverId] }),
    readBack: readRevision,
    expectedAfter: (a) => [{ id: a.revisionId, status: "approved", decided_by: a.approverId }]
  },
  {
    id: "tenant_prohibited_term_revisions.governed.update.reject_decision.accept",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "UPDATE", expect: "accept",
    arrange: async (ctx) => {
      const base = await people(ctx);
      const termId = await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId });
      return { ...base, termId, revisionId: await insertRevision(ctx, { tenantId: base.tenantId, termId, userId: base.requesterId }) };
    },
    act: (_ctx, a) => ({ sql: "update tenant_prohibited_term_revisions set status = 'rejected', decided_by = $2, decided_at = now() where id = $1", params: [a.revisionId, a.approverId] }),
    readBack: readRevision,
    expectedAfter: (a) => [{ id: a.revisionId, status: "rejected", decided_by: a.approverId }]
  },
  {
    id: "tenant_prohibited_term_revisions.governed.update.content.reject",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "UPDATE", expect: "reject",
    message: "prohibited term revision content is immutable",
    arrange: async (ctx) => {
      const base = await people(ctx);
      const termId = await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId });
      return { ...base, termId, revisionId: await insertRevision(ctx, { tenantId: base.tenantId, termId, userId: base.requesterId }) };
    },
    act: (_ctx, a) => ({ sql: "update tenant_prohibited_term_revisions set severity = 'warn' where id = $1", params: [a.revisionId] }),
    readBack: readRevision
  },
  {
    id: "tenant_prohibited_term_revisions.governed.update.decided_twice.reject",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "UPDATE", expect: "reject",
    message: "a prohibited term revision can only be decided once, from pending to approved or rejected",
    arrange: async (ctx) => {
      const fixture = await approvedRevisionFixture(ctx);
      return fixture;
    },
    act: (_ctx, a) => ({ sql: "update tenant_prohibited_term_revisions set status = 'rejected', decided_by = $2, decided_at = now() where id = $1", params: [a.revisionId, a.approverId] }),
    readBack: readRevision
  },
  {
    id: "tenant_prohibited_term_revisions.governed.update.loosening_self_approval.reject",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "UPDATE", expect: "reject",
    message: "tenant_prohibited_term_revisions_loosening_approver_check",
    arrange: async (ctx) => {
      const base = await people(ctx);
      const termId = await insertTerm(ctx, { tenantId: base.tenantId, userId: base.requesterId });
      return { ...base, termId, revisionId: await insertRevision(ctx, { tenantId: base.tenantId, termId, userId: base.requesterId, active: false, loosening: true, reason: LOOSENING_REASON }) };
    },
    act: (_ctx, a) => ({ sql: "update tenant_prohibited_term_revisions set status = 'approved', decided_by = $2, decided_at = now() where id = $1", params: [a.revisionId, a.requesterId] }),
    readBack: readRevision
  },
  {
    id: "tenant_prohibited_term_revisions.governed.delete.reject",
    table: REVISIONS, trigger: REVISION_TRIGGER, op: "DELETE", expect: "reject",
    message: "prohibited term revisions are retained for audit",
    arrange: approvedRevisionFixture,
    act: (_ctx, a) => ({ sql: "delete from tenant_prohibited_term_revisions where id = $1", params: [a.revisionId] }),
    readBack: readRevision
  },

  // show_revision_prohibited_term_snapshots_governed
  {
    id: "show_revision_prohibited_term_snapshots.governed.insert.draft_revision.accept",
    table: SNAPSHOTS, trigger: SNAPSHOT_TRIGGER, op: "INSERT", expect: "accept",
    arrange: (ctx) => revisionInDraft(ctx),
    act: (_ctx, a) => ({
      sql: "insert into show_revision_prohibited_term_snapshots (tenant_id, show_revision_id, builtin_version, lexicon, lexicon_sha256, term_count) values ($1, $2, 'test-1', '[]'::jsonb, repeat('0', 64), 0)",
      params: [a.tenantId, a.showRevisionId]
    }),
    readBack: readSnapshot,
    expectedAfter: (a) => [{ show_revision_id: a.showRevisionId, builtin_version: "test-1", lexicon: [], term_count: 0 }]
  },
  {
    id: "show_revision_prohibited_term_snapshots.governed.insert.approved_revision.reject",
    table: SNAPSHOTS, trigger: SNAPSHOT_TRIGGER, op: "INSERT", expect: "reject",
    message: "a prohibited term snapshot can only be written while the show revision is a draft",
    arrange: async (ctx) => {
      // The BEFORE trigger runs ahead of the primary key check, so it is the trigger that refuses a second snapshot of an approved revision.
      const fixture = await revisionInDraft(ctx, { snapshot: true });
      await approveShowRevision(ctx, fixture);
      return fixture;
    },
    act: (_ctx, a) => ({
      sql: "insert into show_revision_prohibited_term_snapshots (tenant_id, show_revision_id, builtin_version, lexicon, lexicon_sha256, term_count) values ($1, $2, 'test-2', '[]'::jsonb, repeat('1', 64), 0)",
      params: [a.tenantId, a.showRevisionId]
    }),
    readBack: readSnapshot
  },
  {
    id: "show_revision_prohibited_term_snapshots.governed.update.reject",
    table: SNAPSHOTS, trigger: SNAPSHOT_TRIGGER, op: "UPDATE", expect: "reject",
    message: "show revision prohibited term snapshots are append-only",
    arrange: (ctx) => revisionInDraft(ctx, { snapshot: true }),
    act: (_ctx, a) => ({ sql: "update show_revision_prohibited_term_snapshots set builtin_version = 'test-2' where show_revision_id = $1", params: [a.showRevisionId] }),
    readBack: readSnapshot
  },
  {
    id: "show_revision_prohibited_term_snapshots.governed.delete.reject",
    table: SNAPSHOTS, trigger: SNAPSHOT_TRIGGER, op: "DELETE", expect: "reject",
    message: "show revision prohibited term snapshots are append-only",
    arrange: (ctx) => revisionInDraft(ctx, { snapshot: true }),
    act: (_ctx, a) => ({ sql: "delete from show_revision_prohibited_term_snapshots where show_revision_id = $1", params: [a.showRevisionId] }),
    readBack: readSnapshot
  },

  // show_revisions_require_lexicon_snapshot
  {
    id: "show_revisions.require_lexicon_snapshot.update.approve_with_snapshot.accept",
    table: SHOW_REVISIONS, trigger: APPROVAL_TRIGGER, op: "UPDATE", updatedColumns: ["approval_status"], expect: "accept",
    arrange: (ctx) => revisionInDraft(ctx, { snapshot: true }),
    act: (_ctx, a) => ({ sql: "update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", params: [a.showRevisionId, a.memberId] }),
    readBack: readShowRevision,
    expectedAfter: (a) => [{ id: a.showRevisionId, approval_status: "approved" }]
  },
  {
    id: "show_revisions.require_lexicon_snapshot.update.approve_without_snapshot.reject",
    table: SHOW_REVISIONS, trigger: APPROVAL_TRIGGER, op: "UPDATE", updatedColumns: ["approval_status"], expect: "reject",
    message: "Approved program revisions require a frozen prohibited-term lexicon snapshot",
    arrange: (ctx) => revisionInDraft(ctx),
    act: (_ctx, a) => ({ sql: "update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", params: [a.showRevisionId, a.memberId] }),
    readBack: readShowRevision
  }
];
