import { createHash, randomUUID } from "node:crypto";
import { RUNTIME_GPU_ADVISORY_LOCK_KEY, AVATAR_BUILD_WORKER_ADVISORY_LOCK_KEY, ACTIVE_RUNTIME_GPU_RUN_STATES } from "../console/lib/shared/runtime-gpu-lock.mjs";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 3_000;

export function createAvatarBuildProcessor({ pool, tenantIds, inTenantTransaction, controlPlaneUrl, runtimeToken, builderUrl, builderToken, log, isStopping = () => false, fetchImpl = fetch, pollIntervalMs = POLL_MS }) {
  if (!controlPlaneUrl || !runtimeToken || !builderUrl || !builderToken) return null;
  return { runOnce: () => runOnce({ pool, tenantIds, inTenantTransaction, controlPlaneUrl, runtimeToken, builderUrl, builderToken, log, isStopping, fetchImpl, pollIntervalMs }) };
}

async function runOnce(options) {
  const { pool, tenantIds, inTenantTransaction, builderUrl, builderToken, log, fetchImpl } = options;
  if (!await builderHealthy(builderUrl, fetchImpl)) return false;
  const lockClient = await pool.connect();
  let releaseError;
  let buildLockAcquired = false;
  let gpuLockAcquired = false;
  try {
    const buildLock = await lockClient.query("select pg_try_advisory_lock($1::bigint) as acquired", [AVATAR_BUILD_WORKER_ADVISORY_LOCK_KEY]);
    buildLockAcquired = Boolean(buildLock.rows[0]?.acquired);
    if (!buildLockAcquired) return false;
    const gpuLock = await lockClient.query("select pg_try_advisory_lock_shared($1::bigint) as acquired", [RUNTIME_GPU_ADVISORY_LOCK_KEY]);
    gpuLockAcquired = Boolean(gpuLock.rows[0]?.acquired);
    if (!gpuLockAcquired) return false;
    const ids = await tenantIds();
    for (const tenantId of ids) {
      const active = await inTenantTransaction(tenantId, async (client) => client.query(
        "select id from live_runs where state::text = any($1::text[]) limit 1", [ACTIVE_RUNTIME_GPU_RUN_STATES]
      ));
      if (active.rowCount) return false;
    }
    const job = await claimJob(ids, options);
    if (!job) return false;
    try {
      await executeBuild(job, options);
      log("avatar_build.preview_ready", { jobId: job.id, tenantId: job.tenant_id, attempts: job.attempts });
    } catch (error) {
      await failJob(job, options);
      log("avatar_build.failed", { jobId: job.id, tenantId: job.tenant_id, error: error instanceof Error ? error.message : "avatar_build_failed" });
    }
    return true;
  } catch (error) {
    releaseError = error instanceof Error ? error : new Error("avatar_build_worker_failed");
    throw error;
  } finally {
    if (gpuLockAcquired) {
      try { await lockClient.query("select pg_advisory_unlock_shared($1::bigint)", [RUNTIME_GPU_ADVISORY_LOCK_KEY]); }
      catch (error) { releaseError ??= error instanceof Error ? error : new Error("avatar_build_gpu_lock_release_failed"); }
    }
    if (buildLockAcquired) {
      try { await lockClient.query("select pg_advisory_unlock($1::bigint)", [AVATAR_BUILD_WORKER_ADVISORY_LOCK_KEY]); }
      catch (error) { releaseError ??= error instanceof Error ? error : new Error("avatar_build_worker_lock_release_failed"); }
    }
    lockClient.release(releaseError);
  }
}

async function claimJob(ids, { inTenantTransaction, log }) {
  const workerId = `runtime-worker-${process.pid}`;
  for (const tenantId of ids) {
    const leaseToken = randomUUID();
    const job = await inTenantTransaction(tenantId, async (client) => {
      await client.query(`update avatar_build_jobs set status = 'failed', progress = 0, lease_token = null, lease_expires_at = null,
        worker_id = null, failure_code = 'build_attempts_exhausted', failure_detail = 'The build lease expired after the final attempt', finished_at = now(), updated_at = now()
        where tenant_id = $1 and status = 'running' and lease_expires_at <= now() and attempts >= 3`, [tenantId]);
      const result = await client.query(`with candidate as (
          select id from avatar_build_jobs where tenant_id = $1 and attempts < 3 and available_at <= now()
            and (status = 'queued' or (status = 'running' and lease_expires_at <= now()))
          order by created_at, id for update skip locked limit 1
        )
        update avatar_build_jobs job set status = 'running', progress = 0, attempts = job.attempts + 1, lease_token = $2,
          lease_expires_at = now() + interval '2 minutes', worker_id = $3, failure_code = null, failure_detail = null,
          finished_at = null, updated_at = now()
        from candidate where job.id = candidate.id and job.tenant_id = $1
        returning job.id, job.tenant_id, job.project_id, job.project_revision, job.source_asset_id, job.source_checksum, job.source_object_version, job.source_bytes, job.source_content_type, job.attempts, job.lease_token`,
      [tenantId, leaseToken, workerId]);
      return result.rows[0] ?? null;
    });
    if (job) return job;
  }
  return null;
}

async function executeBuild(job, options) {
  const { controlPlaneUrl, runtimeToken, builderUrl, builderToken, inTenantTransaction, log, isStopping, fetchImpl } = options;
  const grantResponse = await fetchImpl(`${controlPlaneUrl}/api/v1/runtime/avatar-build-jobs/${job.id}/source`, {
    method: "POST", headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ tenantId: job.tenant_id, leaseToken: job.lease_token }), cache: "no-store", signal: AbortSignal.timeout(10_000)
  });
  if (!grantResponse.ok) throw new Error("avatar_source_grant_failed");
  const grantPayload = await grantResponse.json();
  const downloadUrl = grantPayload?.data?.downloadUrl;
  let sourceUrl;
  try { sourceUrl = new URL(String(downloadUrl)); } catch { throw new Error("avatar_source_grant_invalid"); }
  if ((sourceUrl.protocol !== "https:" && !(sourceUrl.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(sourceUrl.hostname))) || sourceUrl.username || sourceUrl.password || sourceUrl.hash) throw new Error("avatar_source_grant_invalid");
  const source = await fetchImpl(sourceUrl, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5 * 60_000) });
  if (!source.ok) throw new Error("avatar_source_download_failed");
  const declaredBytes = Number(source.headers.get("content-length"));
  if ((Number.isFinite(declaredBytes) && declaredBytes > MAX_SOURCE_BYTES) || job.source_bytes > MAX_SOURCE_BYTES) throw new Error("avatar_source_too_large");
  const sourceBytes = Buffer.from(await source.arrayBuffer());
  if (!sourceBytes.length || sourceBytes.length > MAX_SOURCE_BYTES || sourceBytes.length !== Number(job.source_bytes)
    || `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}` !== job.source_checksum) throw new Error("avatar_source_integrity_failed");
  const form = new FormData();
  const fileName = `source.${job.source_content_type === "video/webm" ? "webm" : job.source_content_type === "video/quicktime" ? "mov" : "mp4"}`;
  form.append("tenant_id", job.tenant_id);
  form.append("candidate_id", job.id);
  form.append("source_checksum", job.source_checksum);
  form.append("video_file", new Blob([sourceBytes], { type: job.source_content_type }), fileName);
  const buildResponse = await fetchImpl(`${builderUrl}/v1/builds`, {
    method: "POST", headers: { authorization: `Bearer ${builderToken}` }, body: form, cache: "no-store", signal: AbortSignal.timeout(30_000)
  });
  if (buildResponse.status !== 202) throw new Error("avatar_builder_rejected_source");
  const buildPayload = await buildResponse.json();
  const taskId = buildPayload?.data?.taskId;
  if (typeof taskId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) throw new Error("avatar_builder_task_invalid");
  const startedAt = Date.now();
  let lastRenewAt = 0;
  while (Date.now() - startedAt < BUILD_TIMEOUT_MS) {
    if (isStopping()) throw new Error("avatar_worker_stopping");
    const statusResponse = await fetchImpl(`${builderUrl}/v1/builds/${taskId}`, { headers: { authorization: `Bearer ${builderToken}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!statusResponse.ok) throw new Error("avatar_builder_status_failed");
    const statusPayload = await statusResponse.json();
    const build = statusPayload?.data;
    if (build?.status === "failed") throw new Error("avatar_builder_failed");
    if (build?.status === "completed") break;
    if (build?.status !== "queued" && build?.status !== "running") throw new Error("avatar_builder_status_invalid");
    if (Date.now() - lastRenewAt >= 30_000) {
      const progress = Number.isInteger(build.progress) ? Math.max(0, Math.min(99, build.progress)) : 0;
      const renewed = await inTenantTransaction(job.tenant_id, (client) => client.query(`update avatar_build_jobs set progress = $4,
        lease_expires_at = now() + interval '2 minutes', updated_at = now() where tenant_id = $1 and id = $2 and status = 'running' and lease_token = $3 returning id`, [job.tenant_id, job.id, job.lease_token, progress]));
      if (!renewed.rowCount) throw new Error("avatar_build_lease_lost");
      lastRenewAt = Date.now();
    }
    await delay(options.pollIntervalMs);
  }
  if (Date.now() - startedAt >= BUILD_TIMEOUT_MS) throw new Error("avatar_build_timeout");
  const previewResponse = await fetchImpl(`${builderUrl}/v1/candidates/${job.tenant_id}/${job.id}/preview`, { headers: { authorization: `Bearer ${builderToken}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!previewResponse.ok) throw new Error("avatar_preview_missing");
  const preview = Buffer.from(await previewResponse.arrayBuffer());
  if (preview.length < 4 || preview.length > MAX_PREVIEW_BYTES || !preview.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) throw new Error("avatar_preview_invalid");
  const completed = await inTenantTransaction(job.tenant_id, async (client) => {
    const result = await client.query(`update avatar_build_jobs set status = 'preview_ready', progress = 100,
      preview_jpeg = $4, lease_token = null, lease_expires_at = null, worker_id = null, finished_at = now(), updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'running' and lease_token = $3 returning id`, [job.tenant_id, job.id, job.lease_token, preview]);
    if (!result.rowCount) return false;
    await auditBuild(client, job, "avatar_build.preview_ready", { projectRevision: job.project_revision, sourceAssetId: job.source_asset_id, sourceChecksum: job.source_checksum });
    return true;
  });
  if (!completed) throw new Error("avatar_build_lease_lost");
  log("avatar_build.finished", { jobId: job.id, tenantId: job.tenant_id, previewBytes: preview.length });
}

async function failJob(job, { inTenantTransaction }) {
  await inTenantTransaction(job.tenant_id, async (client) => {
    const result = await client.query(`update avatar_build_jobs set status = 'failed', progress = 0,
      lease_token = null, lease_expires_at = null, worker_id = null, failure_code = 'avatar_build_failed',
      failure_detail = 'Avatar preprocessing failed; review the source and retry', finished_at = now(), updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'running' and lease_token = $3 returning id`, [job.tenant_id, job.id, job.lease_token]);
    if (result.rowCount) await auditBuild(client, job, "avatar_build.failed", { projectRevision: job.project_revision, sourceAssetId: job.source_asset_id, failureCode: "avatar_build_failed" });
  });
}

async function auditBuild(client, job, eventType, detail) {
  const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [job.tenant_id]);
  await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
    values ($1, $2, $3, 'avatar_build_job', $4::uuid, $4, $5::jsonb)`, [job.tenant_id, actor.rows[0].id, eventType, job.id, JSON.stringify(detail)]);
}

async function builderHealthy(builderUrl, fetchImpl) {
  try {
    const response = await fetchImpl(`${builderUrl}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch { return false; }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
