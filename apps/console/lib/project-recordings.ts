import type { PoolClient } from "pg";
import { recordAuditEventInTransaction } from "@/lib/audit";
import { requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { creationProjectScriptReviewSha256 } from "@/lib/creation-project-review";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { createMediaDownloadGrant, verifyMediaAssetContent } from "@/lib/media-evidence";
import { isSafeObjectKey, isSha256Digest } from "@/lib/governance-input";

export type ProjectRecordingInput = {
  projectRevision: number;
  productVersionId: string;
  scriptSnapshot: string;
  photoAssetId: string;
  voiceAssetId?: string;
  fileName: string;
  objectKey: string;
  checksum: string;
  bytes: number;
};

export type ProjectRecording = Omit<ProjectRecordingInput, "checksum"> & {
  id: string;
  projectId: string;
  tenantId: string;
  scriptSha256: string;
  checksum: string;
  contentType: "video/webm";
  verifiedObjectVersion: string;
  verificationEvidenceRef: string;
  verifiedAt: string;
  createdBy: string;
  createdAt: string;
};

type ProjectRow = { revision: number; product_version_id: string; script: string; script_review_sha256: string | null; script_review_product_version_id: string | null };
type RecordingRow = { id: string; tenant_id: string; project_id: string; project_revision: number; product_version_id: string; script_snapshot: string; script_sha256: string; photo_asset_id: string; voice_asset_id: string | null; file_name: string; object_key: string; checksum_sha256: string; bytes: string | number; content_type: "video/webm"; verified_object_version: string; verification_evidence_ref: string; verified_at: Date | string; created_by: string; created_at: Date | string };

export function isProjectRecordingInput(value: unknown): value is ProjectRecordingInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return Number.isSafeInteger(input.projectRevision) && Number(input.projectRevision) > 0
    && typeof input.productVersionId === "string" && isUuid(input.productVersionId)
    && typeof input.scriptSnapshot === "string" && input.scriptSnapshot.trim().length > 0 && input.scriptSnapshot.length <= 12000
    && typeof input.photoAssetId === "string" && isUuid(input.photoAssetId)
    && (input.voiceAssetId === undefined || (typeof input.voiceAssetId === "string" && isUuid(input.voiceAssetId)))
    && typeof input.fileName === "string" && input.fileName.trim().length > 0 && input.fileName.length <= 160 && !/[\\/:*?"<>|\u0000-\u001f]/.test(input.fileName)
    && isSafeObjectKey(input.objectKey) && isSha256Digest(input.checksum)
    && Number.isSafeInteger(input.bytes) && Number(input.bytes) >= 1 && Number(input.bytes) <= 100 * 1024 * 1024;
}

export async function listProjectRecordings(context: RequestContext, projectId: string) {
  requireTenantWideAccess(context);
  if (!isUuid(projectId)) throw new Response("Content project was not found", { status: 404 });
  if (!databasePool()) throw new Response("Server-side recording archive requires PostgreSQL", { status: 503, statusText: "recording_archive_unavailable" });
  return withTenantTransaction(context.tenantId, async (client) => {
    const project = await client.query("select id from creation_projects where tenant_id = $1 and id = $2", [context.tenantId, projectId]);
    if (!project.rowCount) throw new Response("Content project was not found", { status: 404, statusText: "creation_project_not_found" });
    const rows = await client.query<RecordingRow>(`select id, tenant_id, project_id, project_revision, product_version_id, script_snapshot, script_sha256, photo_asset_id, voice_asset_id, file_name, object_key, checksum_sha256, bytes, content_type, verified_object_version, verification_evidence_ref, verified_at, created_by, created_at from creation_project_recordings where tenant_id = $1 and project_id = $2 order by created_at desc, id desc limit 100`, [context.tenantId, projectId]);
    return rows.rows.map(mapRecording);
  }, { readOnly: true });
}

export async function registerProjectRecording(context: RequestContext, projectId: string, input: ProjectRecordingInput) {
  requireTenantWideAccess(context);
  if (!isUuid(projectId)) throw new Response("Content project was not found", { status: 404 });
  if (!databasePool()) throw new Response("Server-side recording archive requires PostgreSQL", { status: 503, statusText: "recording_archive_unavailable" });
  const checksum = input.checksum.toLowerCase().replace(/^sha256:/, "");
  const proof = await verifyMediaAssetContent(context, { kind: "product_clip", objectKey: input.objectKey, checksum: `sha256:${checksum}` });
  if (proof.bytes !== input.bytes || proof.contentType !== "video/webm") throw new Response("Uploaded recording does not match the verified WebM content", { status: 422, statusText: "project_recording_content_mismatch" });
  const scriptSha256 = creationProjectScriptReviewSha256(input.productVersionId, input.scriptSnapshot);
  return withTenantTransaction(context.tenantId, async (client) => {
    const project = (await client.query<ProjectRow>(`select revision, product_version_id, script, script_review_sha256, script_review_product_version_id from creation_projects where tenant_id = $1 and id = $2 for update`, [context.tenantId, projectId])).rows[0];
    if (!project) throw new Response("Content project was not found", { status: 404, statusText: "creation_project_not_found" });
    if (project.product_version_id !== input.productVersionId || project.script !== input.scriptSnapshot
      || project.script_review_product_version_id !== input.productVersionId || project.script_review_sha256 !== scriptSha256) {
      throw new Response("Current project content must remain reviewed before recording archive", { status: 409, statusText: "creation_project_script_not_reviewed" });
    }
    await assertAttachedApprovedAsset(client, context.tenantId, projectId, input.photoAssetId, "portrait_photo");
    if (input.voiceAssetId) await assertAttachedApprovedAsset(client, context.tenantId, projectId, input.voiceAssetId, "voice");
    const result = await client.query<RecordingRow>(`insert into creation_project_recordings (tenant_id, project_id, project_revision, product_version_id, script_snapshot, script_sha256, photo_asset_id, voice_asset_id, file_name, object_key, checksum_sha256, bytes, content_type, verified_object_version, verification_evidence_ref, verified_at, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'video/webm', $13, $14, $15::timestamptz, $16)
      returning id, tenant_id, project_id, project_revision, product_version_id, script_snapshot, script_sha256, photo_asset_id, voice_asset_id, file_name, object_key, checksum_sha256, bytes, content_type, verified_object_version, verification_evidence_ref, verified_at, created_by, created_at`,
    [context.tenantId, projectId, input.projectRevision, input.productVersionId, input.scriptSnapshot, scriptSha256, input.photoAssetId, input.voiceAssetId ?? null, input.fileName, input.objectKey, checksum, input.bytes, proof.objectVersion, proof.evidenceRef, proof.verifiedAt, context.actorId]);
    const recording = mapRecording(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "creation_project.recording_archived", resource: "creation_project_recording", resourceId: recording.id, detail: { projectId, projectRevision: recording.projectRevision, productVersionId: recording.productVersionId, scriptSha256, photoAssetId: recording.photoAssetId, bytes: recording.bytes, checksumSha256: checksum, objectVersion: proof.objectVersion, evidenceRef: proof.evidenceRef } });
    return recording;
  });
}

export async function createProjectRecordingDownloadGrant(context: RequestContext, projectId: string, recordingId: string) {
  requireTenantWideAccess(context);
  if (!isUuid(projectId) || !isUuid(recordingId)) throw new Response("Project recording was not found", { status: 404 });
  if (!databasePool()) throw new Response("Server-side recording archive requires PostgreSQL", { status: 503, statusText: "recording_archive_unavailable" });
  const recording = await withTenantTransaction(context.tenantId, async (client) => {
    const row = await client.query<{ object_key: string; verified_object_version: string; checksum_sha256: string; file_name: string }>(
      "select object_key, verified_object_version, checksum_sha256, file_name from creation_project_recordings where tenant_id = $1 and project_id = $2 and id = $3",
      [context.tenantId, projectId, recordingId]
    );
    return row.rows[0] ?? null;
  }, { readOnly: true });
  if (!recording) throw new Response("Project recording was not found", { status: 404, statusText: "project_recording_not_found" });
  return createMediaDownloadGrant(context, { objectKey: recording.object_key, objectVersion: recording.verified_object_version, checksum: `sha256:${recording.checksum_sha256}`, fileName: recording.file_name });
}

async function assertAttachedApprovedAsset(client: PoolClient, tenantId: string, projectId: string, assetId: string, kind: "portrait_photo" | "voice") {
  const result = await client.query(`select asset.id from creation_project_assets binding join media_assets asset on asset.tenant_id = binding.tenant_id and asset.id = binding.media_asset_id where binding.tenant_id = $1 and binding.project_id = $2 and asset.id = $3 and asset.kind = $4::media_asset_kind and asset.approval_status = 'approved' and (asset.expires_at is null or asset.expires_at >= current_date)`, [tenantId, projectId, assetId, kind]);
  if (!result.rowCount) throw new Response(`An attached, approved ${kind} asset is required`, { status: 409, statusText: "project_recording_asset_not_approved" });
}

function mapRecording(row: RecordingRow): ProjectRecording {
  return { id: row.id, tenantId: row.tenant_id, projectId: row.project_id, projectRevision: row.project_revision, productVersionId: row.product_version_id, scriptSnapshot: row.script_snapshot, scriptSha256: row.script_sha256, photoAssetId: row.photo_asset_id, ...(row.voice_asset_id ? { voiceAssetId: row.voice_asset_id } : {}), fileName: row.file_name, objectKey: row.object_key, checksum: `sha256:${row.checksum_sha256}`, bytes: Number(row.bytes), contentType: row.content_type, verifiedObjectVersion: row.verified_object_version, verificationEvidenceRef: row.verification_evidence_ref, verifiedAt: new Date(row.verified_at).toISOString(), createdBy: row.created_by, createdAt: new Date(row.created_at).toISOString() };
}

function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
