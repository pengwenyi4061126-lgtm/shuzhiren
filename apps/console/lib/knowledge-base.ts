import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAuditEvent, recordAuditEventInTransaction, type AuditEventInput } from "@/lib/audit";
import { requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { findProduct } from "@/lib/catalog";
import { latestApprovedPolicyProfile } from "@/lib/policy-profiles";
import { currentDemoLexicon, currentLexiconInTransaction } from "@/lib/prohibited-terms";
import { guardBroadcastText } from "@/lib/shared/broadcast-guard.mjs";
import { chunkKnowledgeDocument, knowledgeQueryTerms, knowledgeSearchTerms, rankKnowledgeHits, scoreKnowledgeEntry, type KnowledgeRankReason } from "@/lib/shared/knowledge-match.mjs";
import { lexiconSha256, type LexiconTerm } from "@/lib/shared/prohibited-terms.mjs";
import type { PolicyRule } from "@/lib/policy-engine";

export type KnowledgeEntryInput = { kind: "faq"; question: string; aliasQuestions: string[]; answer: string; keywords: string[]; productId?: string };
export type KnowledgeEntryPatch = Partial<KnowledgeEntryInput>;
export type KnowledgeDocumentInput = { title: string; sourceRef: string; body: string };
export type KnowledgeDocument = { id: string; tenantId: string; title: string; sourceRef: string; bodySha256: string; chunkCount: number; createdBy: string; createdAt: string };
export type KnowledgeEntry = {
  id: string; tenantId: string; kind: "faq" | "document_chunk"; question: string; aliasQuestions: string[]; answer: string; keywords: string[];
  productId?: string; searchTerms: string[]; revision: number; status: "pending" | "approved" | "retired";
  approvedApprovalId?: string; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string; retiredAt?: string;
};
export type KnowledgeEntryApproval = {
  id: string; entryId: string; revision: number; question: string; aliasQuestions: string[]; answer: string; keywords: string[];
  searchTerms: string[]; productId?: string; answerSha256: string; policyProfileId: string | null; lexiconSha256: string; approvedBy: string; approvedAt: string;
};
export type KnowledgeHit = { approvalId: string; entryId: string; revision: number; question: string; answer: string; answerSha256: string; scorePermille: number; keywordHits: number };
export type KnowledgeEvidence = { type: "knowledge_entry"; approvalId: string; entryId: string; revision: number; answerSha256: string; scorePermille: number };
export type KnowledgeSearchInput = { question: string; productId?: string; minScorePermille?: number };
export type KnowledgeSearchResult = { hit: KnowledgeHit | null; reason: KnowledgeRankReason; candidates: KnowledgeHit[] };
export type KnowledgeEntryInputIssue = { field: string; reason: string; value?: string };
export type KnowledgePolicyFailure = { field: "question" | "aliasQuestions" | "answer"; aliasIndex?: number; text: string; decision: string; reasons: string[]; findings: ReturnType<typeof guardBroadcastText>["findings"] };
type KnowledgeStore = { entries: Map<string, KnowledgeEntry>; approvals: Map<string, KnowledgeEntryApproval>; documents: Map<string, KnowledgeDocument> };
type PersistentEntryRow = {
  id: string; tenant_id: string; kind: "faq" | "document_chunk"; question: string; alias_questions: unknown; answer: string; keywords: unknown;
  product_id: string | null; search_terms: string[]; revision: number; status: "pending" | "approved" | "retired";
  approved_approval_id: string | null; created_by: string; updated_by: string; created_at: Date | string; updated_at: Date | string; retired_at: Date | string | null;
};
type PersistentApprovalRow = { id: string; approved_at: Date | string };
type KnowledgeCandidate = { approval_id: string; entry_id: string; revision: number; question: string; alias_questions: unknown; answer: string; keywords: unknown; search_terms: string[]; answer_sha256: string; product_id?: string | null };
type PersistentDocumentRow = { id: string; tenant_id: string; title: string; source_ref: string; body_sha256: string; chunk_count: number; created_by: string; created_at: Date | string };

declare global { var shuzhirenKnowledgeStore: KnowledgeStore | undefined; }

function store(): KnowledgeStore {
  globalThis.shuzhirenKnowledgeStore ??= { entries: new Map(), approvals: new Map(), documents: new Map() };
  return globalThis.shuzhirenKnowledgeStore;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const length = (value: string) => [...value].length;
const asStringArray = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const jsonValue = (value: unknown) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
};
const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : undefined;
const columns = "id, tenant_id, kind, question, alias_questions, answer, keywords, product_id, search_terms, revision, status, approved_approval_id, created_by::text as created_by, updated_by::text as updated_by, created_at, updated_at, retired_at";

export function parseKnowledgeEntryInput(value: unknown): KnowledgeEntryInput | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["kind", "question", "aliasQuestions", "answer", "keywords", "productId"].includes(key))) return null;
  if (value.kind !== "faq" || typeof value.question !== "string" || typeof value.answer !== "string" || !Array.isArray(value.aliasQuestions) || !Array.isArray(value.keywords)) return null;
  if (!value.aliasQuestions.every((item) => typeof item === "string") || !value.keywords.every((item) => typeof item === "string")) return null;
  if (value.productId !== undefined && (typeof value.productId !== "string" || value.productId.trim() === "")) return null;
  return { kind: "faq", question: value.question, aliasQuestions: value.aliasQuestions as string[], answer: value.answer, keywords: value.keywords as string[], ...(typeof value.productId === "string" ? { productId: value.productId } : {}) };
}

export function parseKnowledgeEntryPatch(value: unknown): KnowledgeEntryPatch | null {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => !["question", "aliasQuestions", "answer", "keywords", "productId"].includes(key))) return null;
  if (value.question !== undefined && typeof value.question !== "string" || value.answer !== undefined && typeof value.answer !== "string") return null;
  if (value.aliasQuestions !== undefined && (!Array.isArray(value.aliasQuestions) || !value.aliasQuestions.every((item) => typeof item === "string"))) return null;
  if (value.keywords !== undefined && (!Array.isArray(value.keywords) || !value.keywords.every((item) => typeof item === "string"))) return null;
  if (value.productId !== undefined && value.productId !== null && (typeof value.productId !== "string" || value.productId.trim() === "")) return null;
  return value as KnowledgeEntryPatch;
}

export function knowledgeEntryInputIssues(input: KnowledgeEntryInput, searchTermCount = rawSearchTermCount(input)): KnowledgeEntryInputIssue[] {
  const issues: KnowledgeEntryInputIssue[] = [];
  if (length(input.question.trim()) < 1 || length(input.question) > 200) issues.push({ field: "question", reason: "length must be 1-200 characters" });
  if (input.aliasQuestions.length > 5 || input.aliasQuestions.some((alias) => length(alias.trim()) < 1 || length(alias) > 200)) issues.push({ field: "aliasQuestions", reason: "must contain 0-5 questions of 1-200 characters" });
  if (length(input.answer.trim()) < 1 || length(input.answer) > 300) issues.push({ field: "answer", reason: "length must be 1-300 characters" });
  if (input.keywords.length > 20 || input.keywords.some((keyword) => length(keyword.trim()) < 1 || length(keyword) > 30)) issues.push({ field: "keywords", reason: "must contain 0-20 keywords of 1-30 characters" });
  for (const keyword of input.keywords) if (!knowledgeQueryTerms(keyword).length) issues.push({ field: "keywords", reason: "keyword must produce at least one search term", value: keyword });
  if (searchTermCount === 0) issues.push({ field: "searchTerms", reason: "at least one searchable term is required" });
  if (searchTermCount > 2000) issues.push({ field: "searchTerms", reason: "search terms cannot exceed 2000" });
  return issues;
}

export async function listKnowledgeEntries(context: RequestContext): Promise<KnowledgeEntry[]> {
  requireTenantWideAccess(context);
  if (!databasePool()) return [...store().entries.values()].filter((entry) => entry.tenantId === context.tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return withTenantTransaction(context.tenantId, async (client) => (await client.query<PersistentEntryRow>(`select ${columns} from knowledge_entries order by updated_at desc, id`)).rows.map(persistentEntry));
}

export async function listKnowledgeDocuments(context: RequestContext): Promise<KnowledgeDocument[]> {
  requireTenantWideAccess(context);
  if (!databasePool()) return [...store().documents.values()].filter((document) => document.tenantId === context.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return withTenantTransaction(context.tenantId, async (client) => (await client.query<PersistentDocumentRow>(
    "select id, tenant_id, title, source_ref, body_sha256, chunk_count, created_by::text as created_by, created_at from knowledge_documents order by created_at desc, id"
  )).rows.map(persistentDocument));
}

export function parseKnowledgeDocumentInput(value: unknown): KnowledgeDocumentInput | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["title", "sourceRef", "body"].includes(key))) return null;
  if (typeof value.title !== "string" || typeof value.sourceRef !== "string" || typeof value.body !== "string") return null;
  return { title: value.title, sourceRef: value.sourceRef, body: value.body };
}

export async function importKnowledgeDocument(context: RequestContext, input: KnowledgeDocumentInput): Promise<{ document: KnowledgeDocument; created: KnowledgeEntry[] }> {
  requireTenantWideAccess(context);
  if (context.role !== "admin" && context.role !== "operator") throw new Response("Knowledge document import requires admin or operator", { status: 403, statusText: "knowledge_document_forbidden" });
  const title = input.title.trim();
  const sourceRef = input.sourceRef.trim();
  const body = input.body;
  const bodyLength = Array.from(body).length;
  if (Array.from(title).length < 1 || Array.from(title).length > 120) throw new Response("Title must contain 1 to 120 characters", { status: 400, statusText: "knowledge_document_title_invalid" });
  if (sourceRef.length > 300 || !/^(?:evidence:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]*|urn:[A-Za-z0-9][A-Za-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._:/-]*)$/.test(sourceRef)) throw new Response("Source must be a controlled evidence:// or urn: reference", { status: 400, statusText: "knowledge_document_reference_invalid" });
  if (bodyLength < 1 || bodyLength > 50_000 || !body.trim()) throw new Response("Body must contain 1 to 50000 characters", { status: 400, statusText: "knowledge_document_body_invalid" });

  let chunks: string[];
  try { chunks = chunkKnowledgeDocument(body); }
  catch (error) {
    const reason = error && typeof error === "object" && "reason" in error ? String(error.reason) : "invalid_document";
    throw new Response(reason, { status: 400, statusText: `knowledge_document_${reason}` });
  }
  if (!chunks.length || chunks.some((answer) => !knowledgeSearchTerms({ question: firstSentence(answer), aliasQuestions: [], keywords: [] }).length)) {
    throw new Response("Document chunks must contain searchable text", { status: 400, statusText: "knowledge_document_no_search_terms" });
  }
  const bodySha256 = sha256(body);
  if (!databasePool()) {
    const document: KnowledgeDocument = { id: `knowledge_document_${randomUUID()}`, tenantId: context.tenantId, title, sourceRef, bodySha256, chunkCount: chunks.length, createdBy: context.actorId, createdAt: new Date().toISOString() };
    const created = chunks.map((answer) => {
      const question = firstSentence(answer);
      return { id: `knowledge_${randomUUID()}`, tenantId: context.tenantId, kind: "document_chunk" as const, question, aliasQuestions: [], answer, keywords: [], searchTerms: knowledgeSearchTerms({ question, aliasQuestions: [], keywords: [] }), revision: 1, status: "pending" as const, createdBy: context.actorId, updatedBy: context.actorId, createdAt: document.createdAt, updatedAt: document.createdAt };
    });
    await recordAuditEvent(context, { type: "knowledge_document.imported", resource: "knowledge_document", resourceId: document.id, detail: { documentId: document.id, bodySha256, chunkCount: chunks.length } });
    store().documents.set(document.id, document);
    for (const entry of created) store().entries.set(entry.id, entry);
    return { document, created };
  }

  return mapDatabaseErrors(() => withTenantTransaction(context.tenantId, async (client) => {
    const actor = await syncActor(client, context);
    const row = (await client.query<PersistentDocumentRow>(`insert into knowledge_documents (tenant_id, title, source_ref, body, body_sha256, chunk_count, created_by)
      values ($1, $2, $3, $4, $5, $6, $7) returning id, tenant_id, title, source_ref, body_sha256, chunk_count, created_by::text as created_by, created_at`,
    [context.tenantId, title, sourceRef, body, bodySha256, chunks.length, actor])).rows[0];
    const document = persistentDocument(row);
    const created: KnowledgeEntry[] = [];
    for (const answer of chunks) {
      const question = firstSentence(answer);
      const searchTerms = knowledgeSearchTerms({ question, aliasQuestions: [], keywords: [] });
      const entry = (await client.query<PersistentEntryRow>(`insert into knowledge_entries (tenant_id, kind, question, alias_questions, answer, keywords, search_terms, source_document_id, created_by, updated_by)
        values ($1, 'document_chunk', $2, '[]'::jsonb, $3, '[]'::jsonb, $4::text[], $5, $6, $6) returning ${columns}`,
      [context.tenantId, question, answer, searchTerms, document.id, actor])).rows[0];
      created.push(persistentEntry(entry));
    }
    await recordAuditEventInTransaction(client, context, { type: "knowledge_document.imported", resource: "knowledge_document", resourceId: document.id, detail: { documentId: document.id, bodySha256, chunkCount: chunks.length } });
    return { document, created };
  }));
}

export async function getKnowledgeEntry(context: RequestContext, entryId: string): Promise<KnowledgeEntry> {
  requireTenantWideAccess(context);
  if (!databasePool()) return demoEntry(context, entryId);
  if (!isUuid(entryId)) throw entryNotFound();
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<PersistentEntryRow>(`select ${columns} from knowledge_entries where id = $1`, [entryId])).rows[0];
    if (!row) throw entryNotFound();
    return persistentEntry(row);
  });
}

export async function createKnowledgeEntry(context: RequestContext, input: KnowledgeEntryInput): Promise<KnowledgeEntry> {
  requireTenantWideAccess(context);
  const issues = knowledgeEntryInputIssues(input);
  if (issues.some((issue) => issue.field === "searchTerms" && issue.reason.includes("required"))) throw new Response("search_terms_empty", { status: 400, statusText: "knowledge_entry_search_terms_empty" });
  if (issues.length) throw new Response(JSON.stringify({ issues }), { status: issues.some((issue) => issue.reason === "keyword must produce at least one search term" || issue.field === "searchTerms" && !issue.reason.includes("required")) ? 422 : 400, statusText: "invalid_knowledge_entry" });
  if (!databasePool()) {
    await assertDemoProduct(context, input.productId);
    const now = new Date().toISOString();
    const normalized = normalizedInput(input);
    const entry: KnowledgeEntry = { id: `knowledge_${randomUUID()}`, tenantId: context.tenantId, ...normalized, searchTerms: knowledgeSearchTerms(normalized), revision: 1, status: "pending", createdBy: context.actorId, updatedBy: context.actorId, createdAt: now, updatedAt: now };
    store().entries.set(entry.id, entry);
    await recordAuditEvent(context, entryAudit("knowledge_entry.created", entry));
    return entry;
  }
  return mapDatabaseErrors(() => withTenantTransaction(context.tenantId, async (client) => {
    await assertProductInTransaction(client, context, input.productId);
    const actor = await syncActor(client, context);
    const row = (await client.query<PersistentEntryRow>(`insert into knowledge_entries (tenant_id, kind, question, alias_questions, answer, keywords, product_id, search_terms, created_by, updated_by)
      values ($1, 'faq', $2, $3::jsonb, $4, $5::jsonb, $6, $7::text[], $8, $8) returning ${columns}`,
    [context.tenantId, input.question.trim(), JSON.stringify(input.aliasQuestions.map((item) => item.trim())), input.answer.trim(), JSON.stringify(input.keywords.map((item) => item.trim())), input.productId ?? null, knowledgeSearchTerms(input), actor])).rows[0];
    const entry = persistentEntry(row);
    await recordAuditEventInTransaction(client, context, entryAudit("knowledge_entry.created", entry));
    return entry;
  }));
}

export async function updateKnowledgeEntry(context: RequestContext, entryId: string, patch: KnowledgeEntryPatch): Promise<KnowledgeEntry> {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const existing = demoEntry(context, entryId);
    if (existing.status === "retired") throw new Response("Retired knowledge entries cannot be changed", { status: 409, statusText: "knowledge_entry_retired" });
    const nextInput = normalizedInput({ ...existing, ...patch, kind: "faq" });
    assertValidEntry(nextInput);
    await assertDemoProduct(context, nextInput.productId);
    const changed = contentChanged(existing, nextInput);
    const updated: KnowledgeEntry = { ...existing, ...nextInput, searchTerms: knowledgeSearchTerms(nextInput), revision: existing.revision + (changed ? 1 : 0), status: changed ? "pending" : existing.status, approvedApprovalId: changed ? undefined : existing.approvedApprovalId, updatedBy: context.actorId, updatedAt: new Date().toISOString() };
    store().entries.set(entryId, updated);
    await recordAuditEvent(context, entryAudit("knowledge_entry.updated", updated, { approvalReset: changed }));
    return updated;
  }
  if (!isUuid(entryId)) throw entryNotFound();
  return mapDatabaseErrors(() => withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<PersistentEntryRow>(`select ${columns} from knowledge_entries where id = $1 for update`, [entryId])).rows[0];
    if (!row) throw entryNotFound();
    const existing = persistentEntry(row);
    if (existing.status === "retired") throw new Response("Retired knowledge entries cannot be changed", { status: 409, statusText: "knowledge_entry_retired" });
    const nextInput = normalizedInput({ ...existing, ...patch, kind: "faq" });
    assertValidEntry(nextInput);
    await assertProductInTransaction(client, context, nextInput.productId);
    const reset = contentChanged(existing, nextInput);
    const actor = await syncActor(client, context);
    const updated = persistentEntry((await client.query<PersistentEntryRow>(`update knowledge_entries set question = $2, alias_questions = $3::jsonb, answer = $4, keywords = $5::jsonb, product_id = $6, search_terms = $7::text[], revision = revision + case when $8::boolean then 1 else 0 end, status = case when $8::boolean then 'pending' else status end, approved_approval_id = case when $8::boolean then null else approved_approval_id end, retired_at = null, updated_by = $9, updated_at = now() where id = $1 returning ${columns}`,
    [entryId, nextInput.question, JSON.stringify(nextInput.aliasQuestions), nextInput.answer, JSON.stringify(nextInput.keywords), nextInput.productId ?? null, knowledgeSearchTerms(nextInput), reset, actor])).rows[0]);
    await recordAuditEventInTransaction(client, context, entryAudit("knowledge_entry.updated", updated, { approvalReset: reset }));
    return updated;
  }));
}

export async function retireKnowledgeEntry(context: RequestContext, entryId: string): Promise<KnowledgeEntry> {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const existing = demoEntry(context, entryId);
    if (existing.status === "retired") throw new Response("Knowledge entry is already retired", { status: 409, statusText: "knowledge_entry_retired" });
    const retired: KnowledgeEntry = { ...existing, status: "retired", approvedApprovalId: undefined, retiredAt: new Date().toISOString(), updatedBy: context.actorId, updatedAt: new Date().toISOString() };
    store().entries.set(entryId, retired);
    await recordAuditEvent(context, entryAudit("knowledge_entry.retired", retired));
    return retired;
  }
  if (!isUuid(entryId)) throw entryNotFound();
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<PersistentEntryRow>(`select ${columns} from knowledge_entries where id = $1 for update`, [entryId])).rows[0];
    if (!row) throw entryNotFound();
    if (row.status === "retired") throw new Response("Knowledge entry is already retired", { status: 409, statusText: "knowledge_entry_retired" });
    const actor = await syncActor(client, context);
    const retired = persistentEntry((await client.query<PersistentEntryRow>(`update knowledge_entries set status = 'retired', approved_approval_id = null, retired_at = now(), updated_by = $2, updated_at = now() where id = $1 returning ${columns}`, [entryId, actor])).rows[0]);
    await recordAuditEventInTransaction(client, context, entryAudit("knowledge_entry.retired", retired));
    return retired;
  });
}

export async function approveKnowledgeEntry(context: RequestContext, entryId: string): Promise<KnowledgeEntry> {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const entry = demoEntry(context, entryId);
    if (entry.status === "retired") throw new Response("Retired knowledge entries cannot be approved", { status: 409, statusText: "knowledge_entry_retired" });
    if (entry.status !== "pending") throw new Response("Knowledge entry is not pending approval", { status: 409, statusText: "knowledge_entry_not_pending" });
    if (entry.updatedBy === context.actorId) throw secondApproverRequired();
    const lexicon = currentDemoLexicon(context.tenantId);
    const failures = policyFailures(entry, [], lexicon);
    if (failures.length) throw policyBlocked(failures);
    const approval = makeApproval(entry, context.actorId, null, lexicon);
    store().approvals.set(approval.id, approval);
    const approved = { ...entry, status: "approved" as const, approvedApprovalId: approval.id, updatedAt: approval.approvedAt };
    store().entries.set(entry.id, approved);
    await recordAuditEvent(context, approvalAudit(approved, approval));
    return approved;
  }
  if (!isUuid(entryId)) throw entryNotFound();
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<PersistentEntryRow>(`select ${columns} from knowledge_entries where id = $1 for update`, [entryId])).rows[0];
    if (!row) throw entryNotFound();
    const entry = persistentEntry(row);
    if (entry.status === "retired") throw new Response("Retired knowledge entries cannot be approved", { status: 409, statusText: "knowledge_entry_retired" });
    if (entry.status !== "pending") throw new Response("Knowledge entry is not pending approval", { status: 409, statusText: "knowledge_entry_not_pending" });
    const actor = await syncActor(client, context);
    if (entry.updatedBy === actor) throw secondApproverRequired();
    const profile = await latestApprovedPolicyProfile(client);
    const lexicon = await currentLexiconInTransaction(client);
    const failures = policyFailures(entry, profile?.rules ?? [], lexicon);
    if (failures.length) throw policyBlocked(failures);
    const answerSha256 = sha256(entry.answer);
    const approval = (await client.query<PersistentApprovalRow>(`insert into knowledge_entry_approvals (tenant_id, entry_id, revision, question, alias_questions, answer, keywords, search_terms, product_id, answer_sha256, policy_profile_id, lexicon_sha256, approved_by)
      values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::text[], $9, $10, $11, $12, $13) returning id, approved_at`,
    [context.tenantId, entry.id, entry.revision, entry.question, JSON.stringify(entry.aliasQuestions), entry.answer, JSON.stringify(entry.keywords), entry.searchTerms, entry.productId ?? null, answerSha256, profile?.id ?? null, lexiconSha256(lexicon), actor])).rows[0];
    const approved = persistentEntry((await client.query<PersistentEntryRow>(`update knowledge_entries set status = 'approved', approved_approval_id = $2, updated_at = now() where id = $1 returning ${columns}`, [entryId, approval.id])).rows[0]);
    await recordAuditEventInTransaction(client, context, approvalAudit(approved, { id: approval.id, entryId, revision: entry.revision, question: entry.question, aliasQuestions: entry.aliasQuestions, answer: entry.answer, keywords: entry.keywords, searchTerms: entry.searchTerms, productId: entry.productId, answerSha256, policyProfileId: profile?.id ?? null, lexiconSha256: lexiconSha256(lexicon), approvedBy: actor, approvedAt: new Date(approval.approved_at).toISOString() }));
    return approved;
  });
}

export function parseKnowledgeSearchInput(value: unknown): KnowledgeSearchInput | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["question", "productId", "minScorePermille"].includes(key)) || typeof value.question !== "string" || length(value.question.trim()) < 1 || length(value.question) > 500) return null;
  if (value.productId !== undefined && (typeof value.productId !== "string" || value.productId.trim() === "")) return null;
  if (value.minScorePermille !== undefined && (!Number.isInteger(value.minScorePermille) || (value.minScorePermille as number) < 300 || (value.minScorePermille as number) > 1000)) return null;
  return { question: value.question.trim(), ...(typeof value.productId === "string" ? { productId: value.productId } : {}), ...(typeof value.minScorePermille === "number" ? { minScorePermille: value.minScorePermille } : {}) };
}

export async function searchKnowledgeEntries(context: RequestContext, input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
  requireTenantWideAccess(context);
  const terms = knowledgeQueryTerms(input.question);
  const minScorePermille = input.minScorePermille ?? 600;
  if (input.productId) {
    if (!databasePool()) await assertDemoProduct(context, input.productId);
    else if (!isUuid(input.productId)) throw new Response("Product does not belong to this tenant", { status: 400, statusText: "knowledge_search_product_invalid" });
  }
  let candidates: KnowledgeCandidate[];
  if (!databasePool()) {
    const entries = [...store().entries.values()].filter((entry) => entry.tenantId === context.tenantId && entry.status === "approved" && (!input.productId || !entry.productId || entry.productId === input.productId) && entry.searchTerms.some((term) => terms.includes(term)));
    candidates = entries.flatMap((entry) => {
      const approval = entry.approvedApprovalId ? store().approvals.get(entry.approvedApprovalId) : undefined;
      return approval ? [{ approval_id: approval.id, entry_id: entry.id, revision: approval.revision, question: approval.question, alias_questions: approval.aliasQuestions, answer: approval.answer, keywords: approval.keywords, search_terms: approval.searchTerms, answer_sha256: approval.answerSha256, product_id: approval.productId ?? null }] : [];
    }).sort((a, b) => a.entry_id.localeCompare(b.entry_id)).slice(0, 50);
  } else {
    candidates = await withTenantTransaction(context.tenantId, async (client) => {
      if (input.productId && !(await client.query("select 1 from products where tenant_id = $1 and id = $2", [context.tenantId, input.productId])).rowCount) throw new Response("Product does not belong to this tenant", { status: 400, statusText: "knowledge_search_product_invalid" });
      return (await client.query<KnowledgeCandidate>(`select a.id as approval_id, a.entry_id, a.revision, a.question, a.alias_questions, a.answer, a.keywords, a.search_terms, a.answer_sha256::text as answer_sha256, a.product_id
        from knowledge_entries e join knowledge_entry_approvals a on a.tenant_id = e.tenant_id and a.id = e.approved_approval_id
        where e.status = 'approved' and a.search_terms && $1::text[] and ($2::uuid is null or a.product_id is null or a.product_id = $2::uuid)
        order by a.id limit 50`, [terms, input.productId ?? null])).rows;
    });
  }
  const ranked = candidates.map((candidate) => {
    const aliasQuestions = asStringArray(jsonValue(candidate.alias_questions));
    const keywords = asStringArray(jsonValue(candidate.keywords));
    const score = scoreKnowledgeEntry(input.question, { question: candidate.question, aliasQuestions, keywords });
    return { approvalId: candidate.approval_id, entryId: candidate.entry_id, revision: candidate.revision, question: candidate.question, answer: candidate.answer, answerSha256: candidate.answer_sha256.trim(), ...score, aliasQuestions, keywords };
  }).sort((a, b) => b.scorePermille - a.scorePermille || b.keywordHits - a.keywordHits || a.entryId.localeCompare(b.entryId));
  const result = rankKnowledgeHits(input.question, candidates.map((candidate) => ({ entryId: candidate.entry_id, question: candidate.question, aliasQuestions: asStringArray(jsonValue(candidate.alias_questions)), keywords: asStringArray(jsonValue(candidate.keywords)), approvalId: candidate.approval_id, revision: candidate.revision, answer: candidate.answer, answerSha256: candidate.answer_sha256.trim() })), { minScorePermille });
  const toHit = (candidate: (typeof ranked)[number]): KnowledgeHit => ({ approvalId: candidate.approvalId, entryId: candidate.entryId, revision: candidate.revision, question: candidate.question, answer: candidate.answer, answerSha256: candidate.answerSha256, scorePermille: candidate.scorePermille, keywordHits: candidate.keywordHits });
  const hit = result.hit ? ranked.find((candidate) => candidate.entryId === result.hit!.entryId) : undefined;
  return { hit: hit ? toHit(hit) : null, reason: result.reason, candidates: ranked.map(toHit) };
}

export async function knowledgeHitsForRunInTransaction(client: PoolClient, runId: string, question: string): Promise<KnowledgeHit[]> {
  if (!isUuid(runId)) return [];
  const queryTerms = knowledgeQueryTerms(question);
  if (!queryTerms.length) return [];
  const tenantId = (await client.query<{ tenant_id: string | null }>("select current_setting('app.tenant_id', true) as tenant_id")).rows[0]?.tenant_id;
  if (!tenantId || !isUuid(tenantId)) throw new Error("Knowledge lookup requires an active tenant transaction");
  const rows = (await client.query<KnowledgeCandidate>("select approval_id, entry_id, revision, question, alias_questions, answer, keywords, search_terms, answer_sha256 from knowledge_answer_candidates($1::uuid, $2::uuid, $3::text[], 20)", [tenantId, runId, queryTerms])).rows;
  const candidates = rows.map((row) => ({ entryId: row.entry_id, question: row.question, aliasQuestions: asStringArray(jsonValue(row.alias_questions)), keywords: asStringArray(jsonValue(row.keywords)), approvalId: row.approval_id, revision: row.revision, answer: row.answer, answerSha256: row.answer_sha256.trim() }));
  const result = rankKnowledgeHits(question, candidates, { minScorePermille: 600 });
  if (result.reason !== "matched" || !result.hit) return [];
  const hit = result.hit;
  return [{ approvalId: hit.approvalId, entryId: hit.entryId, revision: hit.revision, question: hit.question, answer: hit.answer, answerSha256: hit.answerSha256, scorePermille: hit.scorePermille, keywordHits: hit.keywordHits }];
}

export async function knowledgeHitsForRun(context: RequestContext, runId: string, question: string, productId?: string): Promise<KnowledgeHit[]> {
  if (databasePool()) return withTenantTransaction(context.tenantId, (client) => knowledgeHitsForRunInTransaction(client, runId, question), { readOnly: true });
  const queryTerms = knowledgeQueryTerms(question);
  if (!queryTerms.length) return [];
  const candidates = [...store().entries.values()]
    .filter((entry) => entry.tenantId === context.tenantId && entry.status === "approved" && (!entry.productId || entry.productId === productId) && entry.searchTerms.some((term) => queryTerms.includes(term)))
    .flatMap((entry) => {
      const approval = entry.approvedApprovalId ? store().approvals.get(entry.approvedApprovalId) : undefined;
      return approval ? [{ entryId: entry.id, question: approval.question, aliasQuestions: approval.aliasQuestions, keywords: approval.keywords, approvalId: approval.id, revision: approval.revision, answer: approval.answer, answerSha256: approval.answerSha256 }] : [];
    });
  const result = rankKnowledgeHits(question, candidates, { minScorePermille: 600 });
  if (!result.hit) return [];
  const hit = result.hit;
  const score = scoreKnowledgeEntry(question, { question: hit.question, aliasQuestions: hit.aliasQuestions, keywords: hit.keywords });
  return [{ approvalId: hit.approvalId, entryId: hit.entryId, revision: hit.revision, question: hit.question, answer: hit.answer, answerSha256: hit.answerSha256, ...score }];
}

export async function knowledgeEvidenceForApproval(context: RequestContext, approvalId: string, question: string, client?: PoolClient): Promise<KnowledgeEvidence> {
  const evidence = async (transaction: PoolClient) => {
    const row = (await transaction.query<{ id: string; entry_id: string; revision: number; question: string; alias_questions: unknown; keywords: unknown; answer_sha256: string }>(
      `select approval.id, approval.entry_id, approval.revision, approval.question, approval.alias_questions, approval.keywords, approval.answer_sha256::text as answer_sha256
       from knowledge_entry_approvals approval join knowledge_entries entry on entry.tenant_id = approval.tenant_id and entry.id = approval.entry_id
       where approval.id = $1 and approval.tenant_id = $2 and entry.status = 'approved' and entry.approved_approval_id = approval.id`,
      [approvalId, context.tenantId]
    )).rows[0];
    if (!row) throw new Response("Knowledge approval is not current", { status: 409, statusText: "knowledge_approval_not_current" });
    const { scorePermille } = scoreKnowledgeEntry(question, { question: row.question, aliasQuestions: asStringArray(jsonValue(row.alias_questions)), keywords: asStringArray(jsonValue(row.keywords)) });
    return { type: "knowledge_entry" as const, approvalId: row.id, entryId: row.entry_id, revision: row.revision, answerSha256: row.answer_sha256.trim(), scorePermille };
  };
  if (client) return evidence(client);
  if (!databasePool()) {
    const approval = store().approvals.get(approvalId);
    const entry = approval ? store().entries.get(approval.entryId) : undefined;
    if (!approval || !entry || entry.tenantId !== context.tenantId || entry.status !== "approved" || entry.approvedApprovalId !== approval.id) throw new Response("Knowledge approval is not current", { status: 409, statusText: "knowledge_approval_not_current" });
    const { scorePermille } = scoreKnowledgeEntry(question, { question: approval.question, aliasQuestions: approval.aliasQuestions, keywords: approval.keywords });
    return { type: "knowledge_entry", approvalId: approval.id, entryId: entry.id, revision: approval.revision, answerSha256: approval.answerSha256, scorePermille };
  }
  return withTenantTransaction(context.tenantId, evidence, { readOnly: true });
}

export async function knowledgeEntryErrorResponse(error: unknown, fallback = "knowledge_entry_rejected") {
  if (error instanceof KnowledgePolicyError) return Response.json({ error: "knowledge_entry_policy_blocked", failures: error.failures }, { status: 422 });
  if (error instanceof Response) {
    const detail = error.status === 400 || error.status === 409 || error.status === 422 ? await error.text().catch(() => "") : "";
    let parsed: unknown = undefined;
    if (detail) { try { parsed = JSON.parse(detail) as unknown; } catch { parsed = detail; } }
    return Response.json({ error: error.statusText || fallback, ...(parsed === undefined ? {} : { detail: parsed }) }, { status: error.status });
  }
  throw error;
}

class KnowledgePolicyError extends Error { constructor(readonly failures: KnowledgePolicyFailure[]) { super("knowledge_entry_policy_blocked"); } }

function policyFailures(entry: KnowledgeEntry, policyRules: PolicyRule[], lexicon: readonly LexiconTerm[]): KnowledgePolicyFailure[] {
  const checks: { field: KnowledgePolicyFailure["field"]; aliasIndex?: number; text: string; maxLength: number }[] = [
    { field: "question", text: entry.question, maxLength: 200 },
    ...entry.aliasQuestions.map((text, aliasIndex) => ({ field: "aliasQuestions" as const, aliasIndex, text, maxLength: 200 })),
    { field: "answer", text: entry.answer, maxLength: 300 }
  ];
  return checks.flatMap(({ field, aliasIndex, text, maxLength }) => {
    const result = guardBroadcastText(text, { policyRules, lexicon, maxLength });
    return result.allowed ? [] : [{ field, ...(aliasIndex === undefined ? {} : { aliasIndex }), text, decision: result.decision.action, reasons: result.reasons, findings: result.findings }];
  });
}

function makeApproval(entry: KnowledgeEntry, approvedBy: string, policyProfileId: string | null, lexicon: readonly LexiconTerm[]): KnowledgeEntryApproval {
  return { id: `knowledge_approval_${randomUUID()}`, entryId: entry.id, revision: entry.revision, question: entry.question, aliasQuestions: [...entry.aliasQuestions], answer: entry.answer, keywords: [...entry.keywords], searchTerms: [...entry.searchTerms], ...(entry.productId ? { productId: entry.productId } : {}), answerSha256: sha256(entry.answer), policyProfileId, lexiconSha256: lexiconSha256(lexicon), approvedBy, approvedAt: new Date().toISOString() };
}

function approvalAudit(entry: KnowledgeEntry, approval: KnowledgeEntryApproval): AuditEventInput {
  return { type: "knowledge_entry.approved", resource: "knowledge_entry", resourceId: entry.id, detail: { approvalId: approval.id, revision: approval.revision, answerSha256: approval.answerSha256, policyProfileId: approval.policyProfileId, lexiconSha256: approval.lexiconSha256 } };
}

function entryAudit(type: string, entry: KnowledgeEntry, extra: Record<string, string | number | boolean | null> = {}): AuditEventInput {
  return { type, resource: "knowledge_entry", resourceId: entry.id, detail: { revision: entry.revision, status: entry.status, ...extra } };
}

function assertValidEntry(input: KnowledgeEntryInput) {
  const issues = knowledgeEntryInputIssues(input);
  if (issues.some((issue) => issue.field === "searchTerms" && issue.reason.includes("required"))) throw new Response("search_terms_empty", { status: 400, statusText: "knowledge_entry_search_terms_empty" });
  if (issues.length) throw new Response(JSON.stringify({ issues }), { status: issues.some((issue) => issue.reason === "keyword must produce at least one search term" || issue.field === "searchTerms" && !issue.reason.includes("required")) ? 422 : 400, statusText: "invalid_knowledge_entry" });
}

function normalizedInput(input: KnowledgeEntryInput): KnowledgeEntryInput {
  return { kind: "faq", question: input.question.trim(), aliasQuestions: input.aliasQuestions.map((item) => item.trim()), answer: input.answer.trim(), keywords: input.keywords.map((item) => item.trim()), ...(input.productId ? { productId: input.productId } : {}) };
}

function contentChanged(entry: KnowledgeEntry, input: KnowledgeEntryInput) {
  return entry.question !== input.question || JSON.stringify(entry.aliasQuestions) !== JSON.stringify(input.aliasQuestions) || entry.answer !== input.answer || JSON.stringify(entry.keywords) !== JSON.stringify(input.keywords) || (entry.productId ?? null) !== (input.productId ?? null);
}

function rawSearchTermCount(input: KnowledgeEntryInput) {
  return new Set([input.question, ...input.aliasQuestions, ...input.keywords].flatMap((text) => knowledgeQueryTerms(text))).size;
}

function persistentEntry(row: PersistentEntryRow): KnowledgeEntry {
  const aliases = jsonValue(row.alias_questions);
  const keywords = jsonValue(row.keywords);
  return { id: row.id, tenantId: row.tenant_id, kind: row.kind, question: row.question, aliasQuestions: asStringArray(aliases), answer: row.answer, keywords: asStringArray(keywords), ...(row.product_id ? { productId: row.product_id } : {}), searchTerms: row.search_terms, revision: row.revision, status: row.status, ...(row.approved_approval_id ? { approvedApprovalId: row.approved_approval_id } : {}), createdBy: row.created_by, updatedBy: row.updated_by, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, ...(row.retired_at ? { retiredAt: iso(row.retired_at) } : {}) };
}

function persistentDocument(row: PersistentDocumentRow): KnowledgeDocument {
  return { id: row.id, tenantId: row.tenant_id, title: row.title, sourceRef: row.source_ref, bodySha256: row.body_sha256.trim(), chunkCount: row.chunk_count, createdBy: row.created_by, createdAt: iso(row.created_at)! };
}

function firstSentence(text: string) {
  const chars = Array.from(text);
  const end = chars.findIndex((char) => SENTENCE_END_CHARS.has(char));
  return chars.slice(0, end < 0 ? 200 : Math.min(end + 1, 200)).join("").trim();
}

function demoEntry(context: RequestContext, entryId: string) {
  const entry = store().entries.get(entryId);
  if (!entry || entry.tenantId !== context.tenantId) throw entryNotFound();
  return entry;
}

function entryNotFound() { return new Response("Knowledge entry not found", { status: 404, statusText: "knowledge_entry_not_found" }); }
function secondApproverRequired() { return new Response("A different admin or reviewer must approve the last editor's entry", { status: 409, statusText: "knowledge_entry_second_approver_required" }); }
function policyBlocked(failures: KnowledgePolicyFailure[]) { return new KnowledgePolicyError(failures); }
function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
const SENTENCE_END_CHARS = new Set(["。", "！", "？", "!", "?", ".", "；", ";"]);
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

async function assertDemoProduct(context: RequestContext, productId?: string) {
  if (productId && !await findProduct(context, productId)) throw new Response("Product does not belong to this tenant", { status: 422, statusText: "knowledge_entry_product_not_found" });
}

async function assertProductInTransaction(client: PoolClient, context: RequestContext, productId?: string) {
  if (!productId) return;
  if (!isUuid(productId) || !(await client.query("select 1 from products where tenant_id = $1 and id = $2", [context.tenantId, productId])).rowCount) throw new Response("Product does not belong to this tenant", { status: 422, statusText: "knowledge_entry_product_not_found" });
}

async function syncActor(client: PoolClient, context: RequestContext) {
  return (await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role])).rows[0].id;
}

async function mapDatabaseErrors<T>(operation: () => Promise<T>) {
  try { return await operation(); }
  catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "23503") throw new Response("Knowledge entry references a missing tenant resource", { status: 422, statusText: "knowledge_entry_reference_invalid" });
    if (code === "23514" || code === "P0001") throw new Response("Knowledge entry violates a database governance rule", { status: 409, statusText: "knowledge_entry_rejected" });
    throw error;
  }
}
