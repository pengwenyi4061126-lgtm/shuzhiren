import { createHash } from "node:crypto";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { requireTenantWideAccess } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { createMediaDownloadGrant } from "@/lib/media-evidence";

const MAX_PHOTO_BYTES = 100 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type PhotoRow = { object_key: string; checksum: string; verified_object_version: string | null; verified_bytes: string | number | null; verified_content_type: string | null };

export async function getProjectPhotoSource(context: RequestContext, projectId: string, assetId: string) {
  requireTenantWideAccess(context);
  if (!UUID.test(projectId) || !UUID.test(assetId)) throw new Response("Project photo was not found", { status: 404, statusText: "project_photo_not_found" });
  if (!databasePool()) throw new Response("Project photo download requires PostgreSQL", { status: 503, statusText: "project_photo_source_unavailable" });
  const photo = await withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PhotoRow>(`select asset.object_key, asset.checksum, asset.verified_object_version,
        asset.verified_bytes, asset.verified_content_type
      from creation_project_assets binding
      join creation_projects project on project.tenant_id = binding.tenant_id and project.id = binding.project_id
      join media_assets asset on asset.tenant_id = binding.tenant_id and asset.id = binding.media_asset_id
      where project.tenant_id = $1 and project.id = $2 and asset.id = $3 and asset.kind = 'portrait_photo'
        and asset.approval_status = 'approved' and (asset.expires_at is null or asset.expires_at >= current_date)
        and asset.verified_object_version is not null and asset.verified_bytes between 1 and $4
        and asset.verified_content_type in ('image/jpeg', 'image/png') and asset.verified_at is not null
        and asset.verification_evidence_ref is not null`, [context.tenantId, projectId, assetId, MAX_PHOTO_BYTES]);
    return result.rows[0] ?? null;
  }, { readOnly: true });
  if (!photo || !photo.verified_object_version || !photo.verified_bytes || !photo.verified_content_type) {
    throw new Response("An attached, approved and verified project photo is required", { status: 404, statusText: "project_photo_not_available" });
  }
  const grant = await createMediaDownloadGrant(context, {
    objectKey: photo.object_key,
    objectVersion: photo.verified_object_version,
    checksum: photo.checksum,
    fileName: `project-photo.${photo.verified_content_type === "image/png" ? "png" : "jpg"}`
  });
  const source = await fetch(grant.downloadUrl, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!source.ok || source.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== photo.verified_content_type) {
    throw new Response("Verified project photo could not be retrieved", { status: 502, statusText: "project_photo_source_unavailable" });
  }
  const expectedBytes = Number(photo.verified_bytes);
  const contentLengthHeader = source.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength !== expectedBytes) throw new Response("Project photo size did not match its verification record", { status: 502, statusText: "project_photo_integrity_failed" });
  if (!source.body) throw new Response("Verified project photo body is missing", { status: 502, statusText: "project_photo_source_unavailable" });
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > expectedBytes || received > MAX_PHOTO_BYTES) {
      await reader.cancel();
      throw new Response("Project photo exceeded its verified size", { status: 502, statusText: "project_photo_integrity_failed" });
    }
    chunks.push(value);
  }
  const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received);
  if (data.length !== expectedBytes || `sha256:${createHash("sha256").update(data).digest("hex")}` !== photo.checksum) {
    throw new Response("Project photo checksum did not match its verification record", { status: 502, statusText: "project_photo_integrity_failed" });
  }
  return new Response(data, { headers: {
    "cache-control": "private, no-store",
    "content-length": String(data.length),
    "content-type": photo.verified_content_type,
    "content-disposition": `inline; filename="project-photo.${photo.verified_content_type === "image/png" ? "png" : "jpg"}"`,
    "x-content-type-options": "nosniff"
  } });
}
