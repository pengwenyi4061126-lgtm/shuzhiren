import type { PoolClient } from "pg";
import { recordAuditEventInTransaction } from "@/lib/audit";
import { requireRole, requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { createMediaDownloadGrant, verifyMediaAssetContent } from "@/lib/media-evidence";


type SourceRow = {
  revision: number;
  asset_id: string;
  object_key: string;
  checksum: string;
  verified_object_version: string;
  verified_bytes: string | number;
  verified_content_type: string;
  verification_evidence_ref: string;
};
type JobRow = {
  id: string; tenant_id: string; project_id: string; project_revision: number; source_asset_id: string;
  source_checksum: string; source_object_version: string; source_bytes: string | number; source_content_type: string;
  source_evidence_ref: string; status: "queued" | "running" | "preview_ready" | "failed" | "cancelled";
  review_status: "pending" | "approved" | "rejected"; reviewed_by: string | null; reviewed_at: Date | string | null; review_note: string | null;
  publish_status: "not_approved" | "queued" | "publishing" | "published" | "failed"; runtime_avatar_id: string | null; publish_attempts: number; publish_error_code: string | null;
  progress: number; attempts: number; available_at: Date | string; failure_code: string | null; failure_detail: string | null;
  created_by: string; created_at: Date | string; updated_at: Date | string; finished_at: Date | string | null;
};

export type AvatarBuildJob = {
  id: string; projectId: string; projectRevision: number; sourceAssetId: string; status: JobRow["status"];
  reviewStatus: JobRow["review_status"]; publishStatus: JobRow["publish_status"]; publishAttempts: number; runtimeAvatarId?: string; publishErrorCode?: string; reviewedBy?: string; reviewedAt?: string; reviewNote?: string;
  progress: number; attempts: number; availableAt: string; failureCode?: string; failureDetail?: string;
  createdBy: string; createdAt: string; updatedAt: string; finishedAt?: string;
};

export function isAvatarBuildJobInput(value: unknown): value is { sourceAssetId: string } {
  return Boolean(value && typeof value === "object" && "sourceAssetId" in value && isUuid((value as { sourceAssetId: string }).sourceAssetId)
    && Object.keys(value).length === 1);
}

export async function listAvatarBuildJobs(context: RequestContext, projectId: string) {
  requireTenantWideAccess(context);
  if (!isUuid(projectId)) throw new Response("Content project was not found", { status: 404, statusText: "creation_project_not_found" });
  if (!databasePool()) throw new Response("Avatar build queue requires PostgreSQL", { status: 503, statusText: "avatar_builder_unavailable" });
  return withTenantTransaction(context.tenantId, async (client) => {
    const project = await client.query("select id from creation_projects where tenant_id = $1 and id = $2", [context.tenantId, projectId]);
    if (!project.rowCount) throw new Response("Content project was not found", { status: 404, statusText: "creation_project_not_found" });
    const jobs = await client.query<JobRow>(`select id, tenant_id, project_id, project_revision, source_asset_id, source_checksum, source_object_version, source_bytes, source_content_type, source_evidence_ref, status, review_status, reviewed_by, reviewed_at, review_note, publish_status, runtime_avatar_id, publish_attempts, publish_error_code, progress, attempts, available_at, failure_code, failure_detail, created_by, created_at, updated_at, finished_at from avatar_build_jobs where tenant_id = $1 and project_id = $2 order by created_at desc, id desc limit 50`, [context.tenantId, projectId]);
    return jobs.rows.map(mapJob);
  }, { readOnly: true });
}

export async function getAvatarBuildJob(context: RequestContext, projectId: string, jobId: string) {
  requireTenantWideAccess(context);
  if (!isUuid(projectId) || !isUuid(jobId)) return null;
  if (!databasePool()) throw new Response("Avatar build queue requires PostgreSQL", { status: 503, statusText: "avatar_builder_unavailable" });
  return withTenantTransaction(context.tenantId, async (client) => {
    const job = await client.query<JobRow>(`select id, tenant_id, project_id, project_revision, source_asset_id, source_checksum, source_object_version, source_bytes, source_content_type, source_evidence_ref, status, review_status, reviewed_by, reviewed_at, review_note, publish_status, runtime_avatar_id, publish_attempts, publish_error_code, progress, attempts, available_at, failure_code, failure_detail, created_by, created_at, updated_at, finished_at
      from avatar_build_jobs where tenant_id = $1 and project_id = $2 and id = $3`, [context.tenantId, projectId, jobId]);
    return job.rows[0] ? mapJob(job.rows[0]) : null;
  }, { readOnly: true });
}

export async function selectAvatarBuildForProject(context: RequestContext, projectId: string, jobId: string) {
  requireTenantWideAccess(context);
  if (!isUuid(projectId) || !isUuid(jobId)) throw new Response("Avatar selection is invalid", { status: 400, statusText: "avatar_selection_invalid" });
  if (!databasePool()) throw new Response("Avatar selection requires PostgreSQL", { status: 503, statusText: "avatar_builder_unavailable" });
  return withTenantTransaction(context.tenantId, async (client) => {
    const candidate = await client.query<{ project_revision: number }>(
      `select project.revision as project_revision from avatar_build_jobs job
       join creation_projects project on project.tenant_id = job.tenant_id and project.id = job.project_id
       join creation_project_assets binding on binding.tenant_id = project.tenant_id and binding.project_id = project.id and binding.media_asset_id = job.source_asset_id
       join media_assets asset on asset.tenant_id = binding.tenant_id and asset.id = binding.media_asset_id
       where job.tenant_id = $1 and job.project_id = $2 and job.id = $3
         and job.project_revision = project.revision and job.status = 'preview_ready'
         and job.review_status = 'approved' and job.publish_status = 'published' and job.runtime_avatar_id is not null
         and asset.kind = 'portrait' and asset.approval_status = 'approved'
         and (asset.expires_at is null or asset.expires_at >= current_date)
         and asset.checksum = job.source_checksum and asset.verified_object_version = job.source_object_version
         and asset.verified_bytes = job.source_bytes and asset.verified_content_type = job.source_content_type
         and asset.verification_evidence_ref = job.source_evidence_ref and asset.verified_at is not null
       for update of project, job, asset`,
      [context.tenantId, projectId, jobId]
    );
    if (!candidate.rowCount) throw new Response("Only a current, reviewed and published Avatar can be selected", { status: 409, statusText: "avatar_selection_not_ready" });
    await client.query(`insert into creation_project_avatar_selections (tenant_id, project_id, avatar_build_job_id)
      values ($1, $2, $3) on conflict (tenant_id, project_id) do update
      set avatar_build_job_id = excluded.avatar_build_job_id, updated_at = now()`, [context.tenantId, projectId, jobId]);
    await recordAuditEventInTransaction(client, context, { type: "creation_project.avatar_selected", resource: "creation_project", resourceId: projectId, detail: { avatarBuildJobId: jobId, projectRevision: candidate.rows[0].project_revision } });
    return { projectId, avatarBuildJobId: jobId, projectRevision: candidate.rows[0].project_revision };
  });
}

export async function getAvatarBuildPreview(context: RequestContext, projectId: string, jobId: string) {
  requireTenantWideAccess(context);
  if (!isUuid(projectId) || !isUuid(jobId)) return null;
  if (!databasePool()) throw new Response("Avatar build queue requires PostgreSQL", { status: 503, statusText: "avatar_builder_unavailable" });
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<{ preview_jpeg: Buffer }>(`select preview_jpeg from avatar_build_jobs
      where tenant_id = $1 and project_id = $2 and id = $3 and status = 'preview_ready' and preview_jpeg is not null`, [context.tenantId, projectId, jobId]);
    return result.rows[0]?.preview_jpeg ?? null;
  }, { readOnly: true });
}

export async function createAvatarBuildJob(context: RequestContext, projectId: string, sourceAssetId: string) {
  requireTenantWideAccess(context);
  if (!isUuid(projectId) || !isUuid(sourceAssetId)) throw new Response("Avatar build input is invalid", { status: 400, statusText: "avatar_build_input_invalid" });
  if (!databasePool()) throw new Response("Avatar build queue requires PostgreSQL", { status: 503, statusText: "avatar_builder_unavailable" });
  const source = await withTenantTransaction(context.tenantId, (client) => loadEligibleSource(client, context.tenantId, projectId, sourceAssetId), { readOnly: true });
  if (!source) throw new Response("Attach a verified, approved portrait video to this project first", { status: 409, statusText: "avatar_source_not_approved" });
  const proof = await verifyMediaAssetContent(context, { kind: "portrait", objectKey: source.object_key, checksum: source.checksum });
  if (proof.objectVersion !== source.verified_object_version || proof.bytes !== Number(source.verified_bytes)
    || proof.contentType !== source.verified_content_type) {
    throw new Response("Portrait source evidence changed; re-approve the source asset before building", { status: 409, statusText: "avatar_source_evidence_changed" });
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const locked = await loadEligibleSource(client, context.tenantId, projectId, sourceAssetId, true);
    if (!locked || locked.revision !== source.revision || locked.object_key !== source.object_key
      || locked.checksum !== source.checksum || locked.verified_object_version !== source.verified_object_version
      || locked.verified_bytes !== source.verified_bytes || locked.verified_content_type !== source.verified_content_type
      || locked.verification_evidence_ref !== source.verification_evidence_ref) {
      throw new Response("Project or portrait source changed while the build was being queued", { status: 409, statusText: "avatar_source_changed" });
    }
    const active = await client.query("select id from avatar_build_jobs where tenant_id = $1 and project_id = $2 and source_asset_id = $3 and status in ('queued', 'running') limit 1", [context.tenantId, projectId, sourceAssetId]);
    if (active.rowCount) throw new Response("An Avatar build for this source is already queued or running", { status: 409, statusText: "avatar_build_already_active" });
    const result = await client.query<JobRow>(`insert into avatar_build_jobs (tenant_id, project_id, project_revision, source_asset_id, source_checksum, source_object_version, source_bytes, source_content_type, source_evidence_ref, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      returning id, tenant_id, project_id, project_revision, source_asset_id, source_checksum, source_object_version, source_bytes, source_content_type, source_evidence_ref, status, review_status, reviewed_by, reviewed_at, review_note, publish_status, runtime_avatar_id, publish_attempts, publish_error_code, progress, attempts, available_at, failure_code, failure_detail, created_by, created_at, updated_at, finished_at`,
    [context.tenantId, projectId, locked.revision, sourceAssetId, locked.checksum, locked.verified_object_version, locked.verified_bytes, locked.verified_content_type, proof.evidenceRef, context.actorId]);
    const job = mapJob(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "avatar_build.queued", resource: "avatar_build_job", resourceId: job.id, detail: { projectId, projectRevision: job.projectRevision, sourceAssetId, sourceChecksum: locked.checksum, sourceObjectVersion: proof.objectVersion } });
    return job;
  });
}

export async function reviewAvatarBuildJob(context: RequestContext, projectId: string, jobId: string, decision: "approved" | "rejected", note?: string) {
  requireRole(context, ["admin", "reviewer"]);
  requireTenantWideAccess(context);
  if (!isUuid(projectId) || !isUuid(jobId) || !["approved", "rejected"].includes(decision)
    || (note !== undefined && (typeof note !== "string" || note.trim().length < 1 || note.trim().length > 1000))) {
    throw new Response("Avatar review input is invalid", { status: 400, statusText: "avatar_review_input_invalid" });
  }
  if (!databasePool()) throw new Response("Avatar build review requires PostgreSQL", { status: 503, statusText: "avatar_builder_unavailable" });
  const candidate = await withTenantTransaction(context.tenantId, async (client) => loadReviewCandidate(client, context.tenantId, projectId, jobId, false), { readOnly: true });
  if (!candidate) throw new Response("Only a current preview-ready candidate can be reviewed", { status: 409, statusText: "avatar_candidate_not_reviewable" });
  const proof = await verifyMediaAssetContent(context, { kind: "portrait", objectKey: candidate.object_key, checksum: candidate.source_checksum });
  if (proof.objectVersion !== candidate.source_object_version || proof.bytes !== Number(candidate.source_bytes)
    || proof.contentType !== candidate.source_content_type || proof.evidenceRef !== candidate.source_evidence_ref) {
    throw new Response("The portrait source evidence changed; regenerate the candidate", { status: 409, statusText: "avatar_source_evidence_changed" });
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const locked = await loadReviewCandidate(client, context.tenantId, projectId, jobId, true);
    if (!locked || locked.source_checksum !== candidate.source_checksum || locked.source_object_version !== candidate.source_object_version
      || locked.project_revision !== candidate.project_revision) {
      throw new Response("The candidate or project revision changed during review", { status: 409, statusText: "avatar_candidate_changed" });
    }
    const result = await client.query<JobRow>(`update avatar_build_jobs set review_status = $4, reviewed_by = $5, reviewed_at = now(), review_note = $6, updated_at = now()
      where tenant_id = $1 and project_id = $2 and id = $3 and status = 'preview_ready' and review_status = 'pending'
      returning id, tenant_id, project_id, project_revision, source_asset_id, source_checksum, source_object_version, source_bytes, source_content_type, source_evidence_ref, status, review_status, reviewed_by, reviewed_at, review_note, publish_status, runtime_avatar_id, publish_attempts, publish_error_code, progress, attempts, available_at, failure_code, failure_detail, created_by, created_at, updated_at, finished_at`,
    [context.tenantId, projectId, jobId, decision, context.actorId, note?.trim() || null]);
    if (!result.rowCount) throw new Response("Candidate review has already been recorded", { status: 409, statusText: "avatar_candidate_already_reviewed" });
    const job = mapJob(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: `avatar_build.${decision}`, resource: "avatar_build_job", resourceId: job.id, detail: { projectId, projectRevision: job.projectRevision, sourceAssetId: job.sourceAssetId, sourceChecksum: candidate.source_checksum, sourceObjectVersion: candidate.source_object_version, ...(note?.trim() ? { note: note.trim() } : {}) } });
    return job;
  });
}

export async function createAvatarBuildSourceGrant(tenantId: string, jobId: string, leaseToken: string) {
  if (!isUuid(tenantId) || !isUuid(jobId) || !isUuid(leaseToken)) throw new Response("Avatar build lease is invalid", { status: 400, statusText: "avatar_build_lease_invalid" });
  if (!databasePool()) throw new Response("Avatar build queue requires PostgreSQL", { status: 503, statusText: "avatar_builder_unavailable" });
  const source = await withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<{ object_key: string; object_version: string; checksum: string; content_type: string }>(`select asset.object_key, job.source_object_version as object_version, job.source_checksum as checksum, job.source_content_type as content_type
      from avatar_build_jobs job
      join creation_projects project on project.tenant_id = job.tenant_id and project.id = job.project_id and project.revision = job.project_revision
      join creation_project_assets binding on binding.tenant_id = project.tenant_id and binding.project_id = project.id and binding.media_asset_id = job.source_asset_id
      join media_assets asset on asset.tenant_id = binding.tenant_id and asset.id = binding.media_asset_id
      where job.tenant_id = $1 and job.id = $2 and job.status = 'running' and job.lease_token = $3 and job.lease_expires_at > now()
        and asset.kind = 'portrait' and asset.approval_status = 'approved' and (asset.expires_at is null or asset.expires_at >= current_date)
        and asset.checksum = job.source_checksum and asset.verified_object_version = job.source_object_version
        and asset.verified_bytes = job.source_bytes and asset.verified_content_type = job.source_content_type
        and asset.verification_evidence_ref = job.source_evidence_ref and asset.verified_at is not null`, [tenantId, jobId, leaseToken]);
    return result.rows[0] ?? null;
  }, { readOnly: true });
  if (!source) throw new Response("Avatar build lease or approved source is no longer current", { status: 409, statusText: "avatar_build_source_unavailable" });
  const extension = source.content_type === "video/webm" ? "webm" : source.content_type === "video/quicktime" ? "mov" : "mp4";
  return createMediaDownloadGrant({ tenantId }, { objectKey: source.object_key, objectVersion: source.object_version, checksum: source.checksum, fileName: `avatar-source-${jobId}.${extension}` });
}

export async function verifyAvatarBuildPublishInput(tenantId: string, jobId: string) {
  if (!isUuid(tenantId) || !isUuid(jobId)) return null;
  if (!databasePool()) throw new Response("Avatar publishing requires PostgreSQL", { status: 503, statusText: "avatar_builder_unavailable" });
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<{ project_revision: number; source_checksum: string }>(`select job.project_revision, job.source_checksum
      from avatar_build_jobs job
      join creation_projects project on project.tenant_id = job.tenant_id and project.id = job.project_id
      join creation_project_assets binding on binding.tenant_id = project.tenant_id and binding.project_id = project.id and binding.media_asset_id = job.source_asset_id
      join media_assets asset on asset.tenant_id = binding.tenant_id and asset.id = binding.media_asset_id
      where job.tenant_id = $1 and job.id = $2 and job.status = 'preview_ready' and job.review_status = 'approved'
        and job.publish_status = 'publishing' and project.revision = job.project_revision
        and asset.kind = 'portrait' and asset.approval_status = 'approved'
        and (asset.expires_at is null or asset.expires_at >= current_date)
        and asset.checksum = job.source_checksum and asset.verified_object_version = job.source_object_version
        and asset.verified_bytes = job.source_bytes and asset.verified_content_type = job.source_content_type
        and asset.verification_evidence_ref = job.source_evidence_ref and asset.verified_at is not null`, [tenantId, jobId]);
    return result.rows[0] ?? null;
  }, { readOnly: true });
}

async function loadEligibleSource(client: PoolClient, tenantId: string, projectId: string, sourceAssetId: string, lock = false): Promise<SourceRow | null> {
  const result = await client.query<SourceRow>(`select project.revision, asset.id as asset_id, asset.object_key, asset.checksum, asset.verified_object_version, asset.verified_bytes, asset.verified_content_type, asset.verification_evidence_ref
    from creation_projects project
    join creation_project_assets binding on binding.tenant_id = project.tenant_id and binding.project_id = project.id
    join media_assets asset on asset.tenant_id = binding.tenant_id and asset.id = binding.media_asset_id
    where project.tenant_id = $1 and project.id = $2 and asset.id = $3 and asset.kind = 'portrait'
      and asset.approval_status = 'approved' and (asset.expires_at is null or asset.expires_at >= current_date)
      and asset.checksum ~ '^sha256:[a-f0-9]{64}$' and asset.verified_object_version is not null
      and asset.verified_bytes between 1 and 104857600 and asset.verified_content_type in ('video/mp4', 'video/webm', 'video/quicktime')
      and asset.verification_evidence_ref is not null and asset.verified_at is not null
    ${lock ? "for update of project, binding, asset" : ""}`, [tenantId, projectId, sourceAssetId]);
  const row = result.rows[0];
  return row ?? null;
}

type ReviewCandidate = {
  project_revision: number; source_asset_id: string; object_key: string; source_checksum: string;
  source_object_version: string; source_bytes: string | number; source_content_type: string; source_evidence_ref: string;
};

async function loadReviewCandidate(client: PoolClient, tenantId: string, projectId: string, jobId: string, lock: boolean) {
  const result = await client.query<ReviewCandidate>(`select project.revision as project_revision, asset.id as source_asset_id, asset.object_key,
      job.source_checksum, job.source_object_version, job.source_bytes, job.source_content_type, job.source_evidence_ref
    from avatar_build_jobs job
    join creation_projects project on project.tenant_id = job.tenant_id and project.id = job.project_id
    join creation_project_assets binding on binding.tenant_id = project.tenant_id and binding.project_id = project.id and binding.media_asset_id = job.source_asset_id
    join media_assets asset on asset.tenant_id = binding.tenant_id and asset.id = binding.media_asset_id
    where job.tenant_id = $1 and job.project_id = $2 and job.id = $3 and job.status = 'preview_ready'
      and job.review_status = 'pending' and project.revision = job.project_revision
      and asset.kind = 'portrait' and asset.approval_status = 'approved' and (asset.expires_at is null or asset.expires_at >= current_date)
      and asset.checksum = job.source_checksum and asset.verified_object_version = job.source_object_version
      and asset.verified_bytes = job.source_bytes and asset.verified_content_type = job.source_content_type
      and asset.verification_evidence_ref = job.source_evidence_ref and asset.verified_at is not null
    ${lock ? "for update of job, project, binding, asset" : ""}`, [tenantId, projectId, jobId]);
  return result.rows[0] ?? null;
}

function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

function mapJob(row: JobRow): AvatarBuildJob {
  return {
    id: row.id, projectId: row.project_id, projectRevision: row.project_revision, sourceAssetId: row.source_asset_id,
    status: row.status, reviewStatus: row.review_status, publishStatus: row.publish_status, publishAttempts: row.publish_attempts, progress: row.progress, attempts: row.attempts, availableAt: new Date(row.available_at).toISOString(),
    ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}), ...(row.reviewed_at ? { reviewedAt: new Date(row.reviewed_at).toISOString() } : {}),
    ...(row.review_note ? { reviewNote: row.review_note } : {}), ...(row.runtime_avatar_id ? { runtimeAvatarId: row.runtime_avatar_id } : {}),
    ...(row.publish_error_code ? { publishErrorCode: row.publish_error_code } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}), ...(row.failure_detail ? { failureDetail: row.failure_detail } : {}),
    createdBy: row.created_by, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).toISOString() } : {})
  };
}
