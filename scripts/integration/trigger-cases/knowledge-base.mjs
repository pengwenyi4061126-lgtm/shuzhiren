// Knowledge base (migration 087): knowledge_entries_governed_mutation on INSERT, UPDATE and DELETE of entries,
// knowledge_entry_approvals_governed on INSERT, UPDATE and DELETE of approval snapshots, and
// knowledge_documents_append_only on UPDATE and DELETE of imported documents. Message texts are the raise
// exception texts of enforce_knowledge_entry_mutation(), enforce_knowledge_entry_approval_insert() and
// reject_knowledge_document_mutation() in 087.
import { createHash, randomUUID } from "node:crypto";
const ENTRIES = "knowledge_entries";
const ENTRY_TRIGGER = "knowledge_entries_governed_mutation";
const APPROVALS = "knowledge_entry_approvals";
const APPROVAL_TRIGGER = "knowledge_entry_approvals_governed";
const DOCUMENTS = "knowledge_documents";
const DOCUMENT_TRIGGER = "knowledge_documents_append_only";
const QUESTION = "退货规则是什么";
const ALIASES = ["能退货吗"];
const ANSWER = "支持七天无理由退货，具体以订单页说明为准。";
const NEW_ANSWER = "签收后七天内可以申请退货，请以订单页说明为准。";
const KEYWORDS = ["退货"];
const TERMS = ["退货", "货规", "规则", "七天"];
const LEXICON_SHA = "a".repeat(64);
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const readEntry = (_ctx, a) => ({ sql: "select id, kind, question, answer, revision, status, approved_approval_id, retired_at is not null as retired, created_by from knowledge_entries where id = $1", params: [a.entryId] });
const readApproval = (_ctx, a) => ({ sql: "select id, entry_id, revision, answer, answer_sha256, approved_by from knowledge_entry_approvals where id = $1", params: [a.approvalId] });
const readDocument = (_ctx, a) => ({ sql: "select id, title, body_sha256, chunk_count from knowledge_documents where id = $1", params: [a.documentId] });

/** A tenant with two members. Entries are inserted by `insertEntry`; nothing else is needed for the triggers. */
async function base(ctx) {
  const tenantId = await ctx.seed.tenant();
  const memberId = await ctx.seed.member({ tenantId, role: "admin" });
  const otherMemberId = await ctx.seed.member({ tenantId, role: "reviewer" });
  return { tenantId, memberId, otherMemberId, entryId: randomUUID(), approvalId: randomUUID() };
}

async function insertEntry({ client }, a, { id = a.entryId, answer = ANSWER, kind = "faq" } = {}) {
  await client.query(
    "insert into knowledge_entries (id, tenant_id, kind, question, alias_questions, answer, keywords, search_terms, created_by, updated_by) values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::text[], $9, $9)",
    [id, a.tenantId, kind, QUESTION, JSON.stringify(ALIASES), answer, JSON.stringify(KEYWORDS), TERMS, a.memberId]
  );
  return id;
}

/** Inserts a snapshot that copies the entry as it is now, unless `overrides` say otherwise. */
async function insertApproval({ client }, a, { id = a.approvalId, entryId = a.entryId, revision = 1, answer = ANSWER, sha, terms = TERMS } = {}) {
  await client.query(
    "insert into knowledge_entry_approvals (id, tenant_id, entry_id, revision, question, alias_questions, answer, keywords, search_terms, answer_sha256, lexicon_sha256, approved_by) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::text[], $10, $11, $12)",
    [id, a.tenantId, entryId, revision, QUESTION, JSON.stringify(ALIASES), answer, JSON.stringify(KEYWORDS), terms, sha ?? sha256(answer), LEXICON_SHA, a.otherMemberId]
  );
  return id;
}

const pendingEntry = async (ctx) => {
  const a = await base(ctx);
  await insertEntry(ctx, a);
  return a;
};
/** An entry that went through the legal path: pending, snapshot of revision 1, then approved. */
const approvedEntry = async (ctx) => {
  const a = await pendingEntry(ctx);
  await insertApproval(ctx, a);
  await ctx.client.query("update knowledge_entries set status = 'approved', approved_approval_id = $2 where id = $1", [a.entryId, a.approvalId]);
  return a;
};
/** An approved entry whose content changed: revision 2, pending, with the snapshot of revision 1 left behind. */
const editedEntry = async (ctx) => {
  const a = await approvedEntry(ctx);
  await ctx.client.query("update knowledge_entries set answer = $2, status = 'pending', approved_approval_id = null, revision = 2 where id = $1", [a.entryId, NEW_ANSWER]);
  return a;
};
const retiredEntry = async (ctx) => {
  const a = await approvedEntry(ctx);
  await ctx.client.query("update knowledge_entries set status = 'retired', approved_approval_id = null, retired_at = now() where id = $1", [a.entryId]);
  return a;
};

function rejectedEntryUpdate(name, message, arrange, sql, params = () => []) {
  return {
    id: `knowledge_entries.governed.update.${name}.reject`,
    table: ENTRIES, trigger: ENTRY_TRIGGER, op: "UPDATE", expect: "reject", message,
    arrange,
    act: (_ctx, a) => ({ sql, params: [a.entryId, ...params(a)] }),
    readBack: readEntry
  };
}

function rejectedApprovalInsert(name, message, arrange, overrides = () => ({})) {
  return {
    id: `knowledge_entry_approvals.governed.insert.${name}.reject`,
    table: APPROVALS, trigger: APPROVAL_TRIGGER, op: "INSERT", expect: "reject", message,
    arrange,
    act: (_ctx, a) => {
      const o = { entryId: a.entryId, revision: 1, answer: ANSWER, terms: TERMS, ...overrides(a) };
      return {
        sql: "insert into knowledge_entry_approvals (id, tenant_id, entry_id, revision, question, alias_questions, answer, keywords, search_terms, answer_sha256, lexicon_sha256, approved_by) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::text[], $10, $11, $12)",
        params: [a.approvalId, a.tenantId, o.entryId, o.revision, QUESTION, JSON.stringify(ALIASES), o.answer, JSON.stringify(KEYWORDS), o.terms, o.sha ?? sha256(o.answer), LEXICON_SHA, a.otherMemberId]
      };
    },
    readBack: readApproval
  };
}

/** An imported document; the entries of a document import reference it. */
async function documentFixture(ctx) {
  const a = await base(ctx);
  const documentId = randomUUID();
  await ctx.client.query(
    "insert into knowledge_documents (id, tenant_id, title, source_ref, body, body_sha256, chunk_count, created_by) values ($1, $2, '退货说明', 'evidence://integration/returns', '支持七天无理由退货。', $3, 1, $4)",
    [documentId, a.tenantId, sha256("支持七天无理由退货。"), a.memberId]
  );
  return { ...a, documentId };
}

export default [
  {
    id: "knowledge_entries.governed.insert.pending.accept",
    table: ENTRIES, trigger: ENTRY_TRIGGER, op: "INSERT", expect: "accept",
    arrange: base,
    act: (_ctx, a) => ({
      sql: "insert into knowledge_entries (id, tenant_id, kind, question, alias_questions, answer, keywords, search_terms, created_by, updated_by) values ($1, $2, 'faq', $3, $4::jsonb, $5, $6::jsonb, $7::text[], $8, $8)",
      params: [a.entryId, a.tenantId, QUESTION, JSON.stringify(ALIASES), ANSWER, JSON.stringify(KEYWORDS), TERMS, a.memberId]
    }),
    readBack: readEntry,
    expectedAfter: (a) => [{ id: a.entryId, kind: "faq", question: QUESTION, answer: ANSWER, revision: 1, status: "pending", approved_approval_id: null, retired: false }]
  },
  {
    id: "knowledge_entries.governed.insert.second_revision.reject",
    table: ENTRIES, trigger: ENTRY_TRIGGER, op: "INSERT", expect: "reject",
    message: "knowledge entries must be created pending approval at revision 1",
    arrange: base,
    act: (_ctx, a) => ({
      sql: "insert into knowledge_entries (id, tenant_id, kind, question, alias_questions, answer, keywords, search_terms, revision, created_by, updated_by) values ($1, $2, 'faq', $3, $4::jsonb, $5, $6::jsonb, $7::text[], 2, $8, $8)",
      params: [a.entryId, a.tenantId, QUESTION, JSON.stringify(ALIASES), ANSWER, JSON.stringify(KEYWORDS), TERMS, a.memberId]
    }),
    readBack: readEntry
  },
  {
    id: "knowledge_entries.governed.update.content_change.accept",
    table: ENTRIES, trigger: ENTRY_TRIGGER, op: "UPDATE", expect: "accept",
    arrange: pendingEntry,
    act: (_ctx, a) => ({ sql: "update knowledge_entries set answer = $2, revision = 2, updated_by = $3 where id = $1", params: [a.entryId, NEW_ANSWER, a.otherMemberId] }),
    readBack: readEntry,
    expectedAfter: (a) => [{ id: a.entryId, answer: NEW_ANSWER, revision: 2, status: "pending", approved_approval_id: null }]
  },
  {
    id: "knowledge_entries.governed.update.approved_content_change.accept",
    table: ENTRIES, trigger: ENTRY_TRIGGER, op: "UPDATE", expect: "accept",
    arrange: approvedEntry,
    act: (_ctx, a) => ({ sql: "update knowledge_entries set answer = $2, status = 'pending', approved_approval_id = null, revision = 2 where id = $1", params: [a.entryId, NEW_ANSWER] }),
    readBack: readEntry,
    expectedAfter: (a) => [{ id: a.entryId, answer: NEW_ANSWER, revision: 2, status: "pending", approved_approval_id: null }]
  },
  {
    id: "knowledge_entries.governed.update.approve_with_snapshot.accept",
    table: ENTRIES, trigger: ENTRY_TRIGGER, op: "UPDATE", expect: "accept",
    arrange: async (ctx) => {
      const a = await pendingEntry(ctx);
      await insertApproval(ctx, a);
      return a;
    },
    act: (_ctx, a) => ({ sql: "update knowledge_entries set status = 'approved', approved_approval_id = $2 where id = $1", params: [a.entryId, a.approvalId] }),
    readBack: readEntry,
    expectedAfter: (a) => [{ id: a.entryId, revision: 1, status: "approved", approved_approval_id: a.approvalId }]
  },
  {
    id: "knowledge_entries.governed.update.retire.accept",
    table: ENTRIES, trigger: ENTRY_TRIGGER, op: "UPDATE", expect: "accept",
    arrange: approvedEntry,
    act: (_ctx, a) => ({ sql: "update knowledge_entries set status = 'retired', approved_approval_id = null, retired_at = now() where id = $1", params: [a.entryId] }),
    readBack: readEntry,
    expectedAfter: (a) => [{ id: a.entryId, status: "retired", approved_approval_id: null, retired: true }]
  },
  rejectedEntryUpdate("content_without_pending", "a changed knowledge entry must return to pending approval with the next revision", approvedEntry,
    "update knowledge_entries set answer = $2, revision = 2 where id = $1", () => [NEW_ANSWER]),
  rejectedEntryUpdate("content_without_revision", "a changed knowledge entry must return to pending approval with the next revision", pendingEntry,
    "update knowledge_entries set answer = $2 where id = $1", () => [NEW_ANSWER]),
  rejectedEntryUpdate("content_revision_skipped", "a changed knowledge entry must return to pending approval with the next revision", pendingEntry,
    "update knowledge_entries set answer = $2, revision = 3 where id = $1", () => [NEW_ANSWER]),
  rejectedEntryUpdate("search_terms_without_revision", "a changed knowledge entry must return to pending approval with the next revision", pendingEntry,
    "update knowledge_entries set search_terms = $2::text[] where id = $1", () => [["退货", "新词"]]),
  rejectedEntryUpdate("revision_without_content", "the revision of a knowledge entry changes only with its content", pendingEntry,
    "update knowledge_entries set revision = 2 where id = $1"),
  rejectedEntryUpdate("unapprove_without_content", "an approved knowledge entry returns to pending approval only when its content changes", approvedEntry,
    "update knowledge_entries set status = 'pending', approved_approval_id = null where id = $1"),
  rejectedEntryUpdate("kind", "knowledge entry identity is immutable", pendingEntry,
    "update knowledge_entries set kind = 'document_chunk' where id = $1"),
  rejectedEntryUpdate("created_by", "knowledge entry identity is immutable", pendingEntry,
    "update knowledge_entries set created_by = $2 where id = $1", (a) => [a.otherMemberId]),
  rejectedEntryUpdate("tenant", "knowledge entry identity is immutable", pendingEntry,
    "update knowledge_entries set tenant_id = $2 where id = $1", () => [randomUUID()]),
  rejectedEntryUpdate("retired_content", "a retired knowledge entry cannot change", retiredEntry,
    "update knowledge_entries set answer = $2, status = 'pending', revision = 2, retired_at = null where id = $1", () => [NEW_ANSWER]),
  rejectedEntryUpdate("retired_updated_by", "a retired knowledge entry cannot change", retiredEntry,
    "update knowledge_entries set updated_by = $2 where id = $1", (a) => [a.otherMemberId]),
  rejectedEntryUpdate("approve_without_snapshot", "an approved knowledge entry must match the approval snapshot of its current revision", pendingEntry,
    "update knowledge_entries set status = 'approved', approved_approval_id = $2 where id = $1", () => [randomUUID()]),
  rejectedEntryUpdate("approve_with_old_revision_snapshot", "an approved knowledge entry must match the approval snapshot of its current revision", editedEntry,
    "update knowledge_entries set status = 'approved', approved_approval_id = $2 where id = $1", (a) => [a.approvalId]),
  {
    id: "knowledge_entries.governed.delete.reject",
    table: ENTRIES, trigger: ENTRY_TRIGGER, op: "DELETE", expect: "reject",
    message: "knowledge entries are retained for audit",
    arrange: pendingEntry,
    act: (_ctx, a) => ({ sql: "delete from knowledge_entries where id = $1", params: [a.entryId] }),
    readBack: readEntry
  },

  {
    id: "knowledge_entry_approvals.governed.insert.current_revision.accept",
    table: APPROVALS, trigger: APPROVAL_TRIGGER, op: "INSERT", expect: "accept",
    arrange: pendingEntry,
    act: (_ctx, a) => ({
      sql: "insert into knowledge_entry_approvals (id, tenant_id, entry_id, revision, question, alias_questions, answer, keywords, search_terms, answer_sha256, lexicon_sha256, approved_by) values ($1, $2, $3, 1, $4, $5::jsonb, $6, $7::jsonb, $8::text[], $9, $10, $11)",
      params: [a.approvalId, a.tenantId, a.entryId, QUESTION, JSON.stringify(ALIASES), ANSWER, JSON.stringify(KEYWORDS), TERMS, sha256(ANSWER), LEXICON_SHA, a.otherMemberId]
    }),
    readBack: readApproval,
    expectedAfter: (a) => [{ id: a.approvalId, entry_id: a.entryId, revision: 1, answer: ANSWER, answer_sha256: sha256(ANSWER), approved_by: a.otherMemberId }]
  },
  rejectedApprovalInsert("old_revision", "a knowledge entry approval must use the current revision of the entry", editedEntry, () => ({ revision: 1 })),
  rejectedApprovalInsert("future_revision", "a knowledge entry approval must use the current revision of the entry", pendingEntry, () => ({ revision: 2 })),
  rejectedApprovalInsert("answer_differs", "a knowledge entry approval must copy the content of the entry", pendingEntry, () => ({ answer: NEW_ANSWER })),
  rejectedApprovalInsert("search_terms_differ", "a knowledge entry approval must copy the content of the entry", pendingEntry, () => ({ terms: ["退货", "别的词"] })),
  rejectedApprovalInsert("hash_mismatch", "a knowledge entry approval hash does not match its answer", pendingEntry, () => ({ sha: sha256(NEW_ANSWER) })),
  rejectedApprovalInsert("entry_retired", "only a pending knowledge entry can be approved", retiredEntry, () => ({ revision: 1 })),
  rejectedApprovalInsert("entry_already_approved", "only a pending knowledge entry can be approved", approvedEntry, () => ({ revision: 1 })),
  rejectedApprovalInsert("entry_of_another_tenant", "a knowledge entry approval needs an entry of the same tenant", async (ctx) => {
    const a = await pendingEntry(ctx);
    const other = await base(ctx);
    await insertEntry(ctx, other);
    return { ...a, otherTenantEntryId: other.entryId };
  }, (a) => ({ entryId: a.otherTenantEntryId })),
  {
    id: "knowledge_entry_approvals.governed.update.reject",
    table: APPROVALS, trigger: APPROVAL_TRIGGER, op: "UPDATE", expect: "reject",
    message: "knowledge entry approvals are append-only",
    arrange: approvedEntry,
    act: (_ctx, a) => ({ sql: "update knowledge_entry_approvals set answer_sha256 = $2 where id = $1", params: [a.approvalId, sha256("别的答案")] }),
    readBack: readApproval
  },
  {
    id: "knowledge_entry_approvals.governed.delete.reject",
    table: APPROVALS, trigger: APPROVAL_TRIGGER, op: "DELETE", expect: "reject",
    message: "knowledge entry approvals are append-only",
    arrange: approvedEntry,
    act: (_ctx, a) => ({ sql: "delete from knowledge_entry_approvals where id = $1", params: [a.approvalId] }),
    readBack: readApproval
  },

  {
    id: "knowledge_documents.append_only.update.reject",
    table: DOCUMENTS, trigger: DOCUMENT_TRIGGER, op: "UPDATE", expect: "reject",
    message: "knowledge documents are append-only",
    arrange: documentFixture,
    act: (_ctx, a) => ({ sql: "update knowledge_documents set title = '改写后的标题' where id = $1", params: [a.documentId] }),
    readBack: readDocument
  },
  {
    id: "knowledge_documents.append_only.delete.reject",
    table: DOCUMENTS, trigger: DOCUMENT_TRIGGER, op: "DELETE", expect: "reject",
    message: "knowledge documents are append-only",
    arrange: documentFixture,
    act: (_ctx, a) => ({ sql: "delete from knowledge_documents where id = $1", params: [a.documentId] }),
    readBack: readDocument
  }
];
