import type { PoolClient } from "pg";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess } from "@/lib/control-plane/run-access";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { assertProgramScriptsAllowed, boundPolicyProfileIdInTransaction, currentLexiconInTransaction, freezeRevisionLexiconInTransaction, frozenLexiconAuditDetail, policyRulesForRevisionInTransaction, programScriptCount, programScriptPolicyAuditDetail } from "@/lib/prohibited-terms";
import { createReleaseManifestSnapshotInTransaction } from "@/lib/release-manifest";
import { lexiconSha256 } from "@/lib/shared/prohibited-terms.mjs";
import { normalizeScriptVariants } from "@/lib/shared/script-rotation.mjs";
import { normalizeProgramSegments, programHash, type ProgramSegment, type ProgramSegmentInput, type ShowProgram } from "@/lib/show-program";

export type ProgramRevisionRequestStatus = "draft" | "pending_approval" | "approved" | "rejected" | "applied";
export type ProgramRevisionRequest = {
  id: string; runId: string; sourceRevisionId: string; candidateRevisionId: string; status: ProgramRevisionRequestStatus;
  sourceProgramSha256: string; proposedProgramSha256?: string; program: ShowProgram; createdBy: string;
  approvedBy?: string; rejectionReason?: string; createdAt: string; updatedAt: string;
};
type RequestRow = { id: string; live_run_id: string; source_revision_id: string; candidate_revision_id: string; status: ProgramRevisionRequestStatus; source_program_sha256: string; proposed_program_sha256: string | null; created_by_subject: string; approved_by_subject: string | null; rejection_reason: string | null; created_at: Date | string; updated_at: Date | string; };
type LockedRequest = RequestRow & { created_by_id: string };
type RunRow = { id: string; tenant_id: string; state: string; source_revision_id: string; show_id: string; source_revision: number; product_version_id: string | null; source_approval: "draft" | "approved" | "rejected" };
const requestColumns = `request.id, request.live_run_id, request.source_revision_id, request.candidate_revision_id, request.status, request.source_program_sha256, request.proposed_program_sha256, creator.external_subject as created_by_subject, approver.external_subject as approved_by_subject, request.rejection_reason, request.created_at, request.updated_at`;

export async function listProgramRevisionRequests(context: RequestContext, runId: string) {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) return [];
  return withTenantTransaction(context.tenantId, async (client) => {
    const rows = await client.query<RequestRow>(`select ${requestColumns} from show_program_change_requests request join users creator on creator.id = request.created_by left join users approver on approver.id = request.approved_by where request.live_run_id = $1 order by request.created_at desc`, [runId]);
    return Promise.all(rows.rows.map((row) => persistentRequest(client, context.tenantId, row)));
  });
}

export async function createProgramRevisionRequest(context: RequestContext, runId: string) {
  await assertLiveRunAccess(context, runId);
  requirePostgres();
  return withTenantTransaction(context.tenantId, async (client) => {
    const run = await loadRun(client, runId, true);
    if (!run) throw new Response("Live run not found", { status: 404 });
    if (!canRevise(run.state) || run.source_approval !== "approved" || !run.product_version_id) throw new Response("Approved program revisions are allowed only before arming", { status: 409 });
    const active = await client.query<{ id: string }>("select id from show_program_change_requests where live_run_id = $1 and status in ('draft', 'pending_approval', 'approved')", [runId]);
    if (active.rows[0]) throw new Response("An active program revision request already exists", { status: 409 });
    await client.query("select id from shows where id = $1 for update", [run.show_id]);
    const sourceSegments = await loadSegments(client, run.source_revision_id);
    assertStoredProgram(sourceSegments, run.product_version_id, false);
    const nextRevision = await client.query<{ revision: number }>("select coalesce(max(revision), 0) + 1 as revision from show_revisions where show_id = $1", [run.show_id]);
    const candidate = await client.query<{ id: string }>("insert into show_revisions (tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, jsonb_build_object('derivedFromRevisionId', $4::text, 'createdBy', 'governed-program-revision'), 'draft') returning id", [context.tenantId, run.show_id, nextRevision.rows[0].revision, run.source_revision_id]);
    await cloneRevisionBindings(client, context.tenantId, run.source_revision_id, candidate.rows[0].id);
    await client.query("insert into show_revision_segments (tenant_id, show_revision_id, position, kind, title, duration_seconds, product_version_id, purpose, runtime_script, runtime_script_variants, is_fallback) select tenant_id, $2, position, kind, title, duration_seconds, product_version_id, purpose, runtime_script, runtime_script_variants, is_fallback from show_revision_segments where show_revision_id = $1 order by position", [run.source_revision_id, candidate.rows[0].id]);
    const actorId = await actorDatabaseId(client, context);
    const inserted = await client.query<RequestRow>(`insert into show_program_change_requests (tenant_id, live_run_id, source_revision_id, candidate_revision_id, source_program_sha256, created_by) values ($1, $2, $3, $4, $5, $6) returning id, live_run_id, source_revision_id, candidate_revision_id, status, source_program_sha256, proposed_program_sha256, $7::text as created_by_subject, null::text as approved_by_subject, rejection_reason, created_at, updated_at`, [context.tenantId, run.id, run.source_revision_id, candidate.rows[0].id, programHash(sourceSegments), actorId, context.actorId]);
    await recordAuditEventInTransaction(client, context, { type: "show_program_revision.requested", resource: "show_program_change_request", resourceId: inserted.rows[0].id, detail: { runId, sourceRevisionId: run.source_revision_id, candidateRevisionId: candidate.rows[0].id, sourceProgramSha256: programHash(sourceSegments) } });
    return persistentRequest(client, context.tenantId, inserted.rows[0]);
  });
}

export async function replaceProgramRevisionRequest(context: RequestContext, runId: string, requestId: string, input: ProgramSegmentInput[]) {
  await assertLiveRunAccess(context, runId);
  requirePostgres();
  return withTenantTransaction(context.tenantId, async (client) => {
    const request = await loadRequest(client, requestId, true);
    const run = await loadRun(client, runId, true);
    if (!request || !run || request.live_run_id !== run.id) throw new Response("Program revision request not found", { status: 404 });
    const actorId = await actorDatabaseId(client, context);
    if (request.status !== "draft" || request.created_by_id !== actorId || !canRevise(run.state) || !run.product_version_id) throw new Response("Program revision draft is not editable", { status: 409 });
    const before = await loadSegments(client, request.candidate_revision_id);
    const segments = normalizeProgramSegments(input, run.product_version_id);
    await client.query("delete from show_revision_segments where show_revision_id = $1", [request.candidate_revision_id]);
    await insertSegments(client, context.tenantId, request.candidate_revision_id, segments);
    await recordAuditEventInTransaction(client, context, { type: "show_program_revision.updated", resource: "show_program_change_request", resourceId: request.id, detail: { runId, candidateRevisionId: request.candidate_revision_id, beforeSha256: programHash(before), afterSha256: programHash(segments), segmentCount: segments.length, variantCount: segments.reduce((total, segment) => total + (segment.runtimeScriptVariants?.length ?? 0), 0) } });
    return persistentRequest(client, context.tenantId, await loadRequestRow(client, request.id));
  });
}

export async function submitProgramRevisionRequest(context: RequestContext, runId: string, requestId: string) {
  await assertLiveRunAccess(context, runId);
  requirePostgres();
  let candidateRevisionId: string | null = null;
  try {
    return await withTenantTransaction(context.tenantId, async (client) => {
    const request = await loadRequest(client, requestId, true);
    const run = await loadRun(client, runId, true);
    if (!request || !run || request.live_run_id !== run.id) throw new Response("Program revision request not found", { status: 404 });
    candidateRevisionId = request.candidate_revision_id;
    const actorId = await actorDatabaseId(client, context);
    if (request.status !== "draft" || request.created_by_id !== actorId || !canRevise(run.state) || !run.product_version_id) throw new Response("Program revision draft is not submittable", { status: 409 });
    const segments = await loadSegments(client, request.candidate_revision_id);
    assertStoredProgram(segments, run.product_version_id);
    const scripts = await checkProgramScripts(client, request.candidate_revision_id, segments);
    const submitted = await client.query("update show_program_change_requests set status = 'pending_approval', proposed_program = $2::jsonb, proposed_program_sha256 = $3, submitted_at = now() where id = $1 and status = 'draft' returning id", [request.id, JSON.stringify(segments), programHash(segments)]);
    if (!submitted.rows[0]) throw new Response("Program revision draft changed before submission", { status: 409 });
    await recordAuditEventInTransaction(client, context, { type: "show_program_revision.submitted", resource: "show_program_change_request", resourceId: request.id, detail: { runId, candidateRevisionId: request.candidate_revision_id, proposedProgramSha256: programHash(segments), segmentCount: segments.length, scriptCount: scripts.scriptCount, policyProfileId: scripts.policyProfileId, lexiconSha256: scripts.lexiconSha256 } });
    return persistentRequest(client, context.tenantId, await loadRequestRow(client, request.id));
    });
  } catch (error) {
    if (error instanceof Response && error.statusText === "program_script_policy_blocked" && candidateRevisionId) {
      await recordAuditEvent(context, { type: "show_program.script_policy_blocked", resource: "show_revision", resourceId: candidateRevisionId, detail: await programScriptPolicyAuditDetail(runId, error) });
    }
    throw error;
  }
}

export async function approveProgramRevisionRequest(context: RequestContext, runId: string, requestId: string) {
  await assertLiveRunAccess(context, runId);
  requirePostgres();
  let candidateRevisionId: string | null = null;
  try {
    return await withTenantTransaction(context.tenantId, async (client) => {
    const request = await loadRequest(client, requestId, true);
    const run = await loadRun(client, runId, true);
    if (!request || !run || request.live_run_id !== run.id) throw new Response("Program revision request not found", { status: 404 });
    candidateRevisionId = request.candidate_revision_id;
    const actorId = await actorDatabaseId(client, context);
    if (request.status !== "pending_approval" || request.created_by_id === actorId || !canRevise(run.state) || !run.product_version_id) throw new Response("Program revision request is not approvable", { status: 409 });
    const segments = await loadSegments(client, request.candidate_revision_id);
    assertStoredProgram(segments, run.product_version_id);
    // The scripts are checked first, then the lexicon they passed against is frozen into the candidate, and only then is it approved.
    const scripts = await checkProgramScripts(client, request.candidate_revision_id, segments);
    const frozen = await freezeRevisionLexiconInTransaction(client, request.candidate_revision_id, scripts.lexicon);
    await recordAuditEventInTransaction(client, context, { type: "show_revision.prohibited_terms_frozen", resource: "show_revision", resourceId: request.candidate_revision_id, detail: frozenLexiconAuditDetail(frozen, { scriptCount: scripts.scriptCount, policyProfileId: scripts.policyProfileId }) });
    const candidate = await client.query<{ id: string }>("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1 and approval_status = 'draft' returning id", [request.candidate_revision_id, actorId]);
    if (!candidate.rows[0]) throw new Response("Candidate program revision is not a draft", { status: 409 });
    await client.query("update show_program_change_requests set status = 'approved', approved_by = $2, approved_at = now() where id = $1 and status = 'pending_approval'", [request.id, actorId]);
    const rebound = await client.query("update live_runs set show_revision_id = $2, state = 'APPROVED', updated_at = now() where id = $1 returning id", [run.id, request.candidate_revision_id]);
    if (!rebound.rows[0]) throw new Response("Live run changed before revision apply", { status: 409 });
    await createReleaseManifestSnapshotInTransaction(client, { tenantId: context.tenantId, revisionId: request.candidate_revision_id, runId: run.id });
    await client.query("update show_program_change_requests set status = 'applied', applied_at = now() where id = $1 and status = 'approved'", [request.id]);
    await recordAuditEventInTransaction(client, context, { type: "show_program_revision.applied", resource: "show_program_change_request", resourceId: request.id, detail: { runId, sourceRevisionId: request.source_revision_id, candidateRevisionId: request.candidate_revision_id, proposedProgramSha256: programHash(segments), previousState: run.state, state: "APPROVED", scriptCount: scripts.scriptCount, policyProfileId: scripts.policyProfileId, lexiconSha256: frozen.lexiconSha256 } });
    return persistentRequest(client, context.tenantId, await loadRequestRow(client, request.id));
    });
  } catch (error) {
    if (error instanceof Response && error.statusText === "program_script_policy_blocked" && candidateRevisionId) {
      await recordAuditEvent(context, { type: "show_program.script_policy_blocked", resource: "show_revision", resourceId: candidateRevisionId, detail: await programScriptPolicyAuditDetail(runId, error) });
    }
    throw error;
  }
}

export async function rejectProgramRevisionRequest(context: RequestContext, runId: string, requestId: string, reason: string) {
  await assertLiveRunAccess(context, runId);
  requirePostgres();
  return withTenantTransaction(context.tenantId, async (client) => {
    const request = await loadRequest(client, requestId, true);
    const run = await loadRun(client, runId, true);
    if (!request || !run || request.live_run_id !== run.id) throw new Response("Program revision request not found", { status: 404 });
    const actorId = await actorDatabaseId(client, context);
    if (request.status !== "pending_approval" || request.created_by_id === actorId || !canRevise(run.state)) throw new Response("Program revision request is not rejectable", { status: 409 });
    const rejected = await client.query("update show_program_change_requests set status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = $3 where id = $1 and status = 'pending_approval' returning id", [request.id, actorId, reason.trim()]);
    if (!rejected.rows[0]) throw new Response("Program revision request changed before rejection", { status: 409 });
    await recordAuditEventInTransaction(client, context, { type: "show_program_revision.rejected", resource: "show_program_change_request", resourceId: request.id, detail: { runId, candidateRevisionId: request.candidate_revision_id, reason: reason.trim() } });
    return persistentRequest(client, context.tenantId, await loadRequestRow(client, request.id));
  });
}

/** Every version of every runnable script of the candidate against the broadcast guard (its bound policy rules and the lexicon in force now); throws 422 program_script_policy_blocked. */
async function checkProgramScripts(client: PoolClient, revisionId: string, segments: ProgramSegment[]) {
  const lexicon = await currentLexiconInTransaction(client);
  assertProgramScriptsAllowed(segments, { policyRules: await policyRulesForRevisionInTransaction(client, revisionId), lexicon });
  return { lexicon, scriptCount: programScriptCount(segments), policyProfileId: await boundPolicyProfileIdInTransaction(client, revisionId), lexiconSha256: lexiconSha256(lexicon) };
}
function requirePostgres() { if (!databasePool()) throw new Response("Governed program revisions require PostgreSQL", { status: 409 }); }
function canRevise(state: string) { return state === "APPROVED" || state === "PREFLIGHT"; }

async function loadRun(client: PoolClient, runId: string, lock = false): Promise<RunRow | null> {
  const result = await client.query<RunRow>(`select r.id, r.tenant_id, r.state, r.show_revision_id as source_revision_id, sr.show_id, sr.revision as source_revision, r.product_version_id, sr.approval_status as source_approval from live_runs r join show_revisions sr on sr.id = r.show_revision_id where r.id = $1 ${lock ? "for update of r, sr" : ""}`, [runId]);
  return result.rows[0] ?? null;
}

async function loadRequest(client: PoolClient, requestId: string, lock = false): Promise<LockedRequest | null> {
  const result = await client.query<LockedRequest>(`select ${requestColumns}, request.created_by as created_by_id from show_program_change_requests request join users creator on creator.id = request.created_by left join users approver on approver.id = request.approved_by where request.id = $1 ${lock ? "for update of request" : ""}`, [requestId]);
  return result.rows[0] ?? null;
}
async function loadRequestRow(client: PoolClient, requestId: string) {
  const request = await loadRequest(client, requestId);
  if (!request) throw new Error("Program revision request disappeared");
  return request;
}
async function loadSegments(client: PoolClient, revisionId: string): Promise<ProgramSegment[]> {
  const result = await client.query<{ id: string; position: number; kind: ProgramSegment["kind"]; title: string; duration_seconds: number; product_version_id: string | null; purpose: string; runtime_script: string | null; runtime_script_variants: unknown; is_fallback: boolean }>("select id, position, kind, title, duration_seconds, product_version_id, purpose, runtime_script, runtime_script_variants, is_fallback from show_revision_segments where show_revision_id = $1 order by position", [revisionId]);
  return result.rows.map((row) => ({ id: row.id, position: row.position, kind: row.kind, title: row.title, durationSeconds: row.duration_seconds, productVersionId: row.product_version_id ?? undefined, purpose: row.purpose, runtimeScript: row.runtime_script ?? undefined, ...storedVariants(row.runtime_script_variants), fallback: row.is_fallback }));
}
function storedVariants(value: unknown): { runtimeScriptVariants?: string[] } {
  const variants = normalizeScriptVariants(value) as string[];
  return variants.length > 0 ? { runtimeScriptVariants: variants } : {};
}
function assertStoredProgram(segments: ProgramSegment[], productVersionId: string, requireRuntimeScripts = true) {
  const normalized = normalizeProgramSegments(segments.map(({ kind, title, durationSeconds, purpose, runtimeScript, runtimeScriptVariants }) => ({
    kind,
    title,
    durationSeconds,
    purpose,
    runtimeScript: !requireRuntimeScripts && !runtimeScript && (kind === "prepared_product" || kind === "interactive") ? "legacy-script-pending-revision" : runtimeScript,
    runtimeScriptVariants
  })), productVersionId);
  const source = requireRuntimeScripts ? segments : segments.map((segment) => ({ ...segment, runtimeScript: segment.runtimeScript ?? ((segment.kind === "prepared_product" || segment.kind === "interactive") ? "legacy-script-pending-revision" : undefined) }));
  if (programHash(source) !== programHash(normalized)) throw new Response("Program revision bindings are invalid", { status: 409 });
}
async function actorDatabaseId(client: PoolClient, context: RequestContext) {
  const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
  return actor.rows[0].id;
}
async function cloneRevisionBindings(client: PoolClient, tenantId: string, sourceRevisionId: string, candidateRevisionId: string) {
  await client.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) select $1, $3, product_version_id, slot_key from show_revision_product_versions where show_revision_id = $2", [tenantId, sourceRevisionId, candidateRevisionId]);
  await client.query("insert into show_revision_model_releases (tenant_id, show_revision_id, model_release_id, component) select $1, $3, model_release_id, component from show_revision_model_releases where show_revision_id = $2", [tenantId, sourceRevisionId, candidateRevisionId]);
  await client.query("insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) select $1, $3, policy_profile_id from show_revision_policy_profiles where show_revision_id = $2", [tenantId, sourceRevisionId, candidateRevisionId]);
  await client.query("insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) select $1, $3, media_asset_id, kind from show_revision_media_assets where show_revision_id = $2", [tenantId, sourceRevisionId, candidateRevisionId]);
}
async function insertSegments(client: PoolClient, tenantId: string, revisionId: string, segments: ProgramSegment[]) {
  for (const segment of segments) await client.query("insert into show_revision_segments (tenant_id, show_revision_id, position, kind, title, duration_seconds, product_version_id, purpose, runtime_script, runtime_script_variants, is_fallback) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)", [tenantId, revisionId, segment.position, segment.kind, segment.title, segment.durationSeconds, segment.productVersionId ?? null, segment.purpose, segment.runtimeScript ?? null, JSON.stringify(segment.runtimeScriptVariants ?? []), segment.fallback]);
}
async function persistentRequest(client: PoolClient, tenantId: string, row: RequestRow): Promise<ProgramRevisionRequest> {
  const segments = await loadSegments(client, row.candidate_revision_id);
  const programStatus = row.status === "approved" || row.status === "applied" ? "approved" : row.status === "rejected" ? "rejected" : "draft";
  return { id: row.id, runId: row.live_run_id, sourceRevisionId: row.source_revision_id, candidateRevisionId: row.candidate_revision_id, status: row.status, sourceProgramSha256: row.source_program_sha256, proposedProgramSha256: row.proposed_program_sha256 ?? undefined, program: { runId: row.live_run_id, tenantId, revisionId: row.candidate_revision_id, status: programStatus, editable: row.status === "draft", segments }, createdBy: row.created_by_subject, approvedBy: row.approved_by_subject ?? undefined, rejectionReason: row.rejection_reason ?? undefined, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
