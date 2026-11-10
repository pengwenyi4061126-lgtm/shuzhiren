export function createAvatarPublishProcessor({ tenantIds, inTenantTransaction, controlPlaneUrl, runtimeToken, publisherUrl, publisherToken, log, fetchImpl = fetch }) {
  if (!controlPlaneUrl || !runtimeToken || !publisherUrl || !publisherToken) return null;
  return { runOnce: () => runOnce({ tenantIds, inTenantTransaction, controlPlaneUrl, runtimeToken, publisherUrl, publisherToken, log, fetchImpl }) };
}

async function runOnce(options) {
  const { tenantIds, inTenantTransaction, controlPlaneUrl, runtimeToken, publisherUrl, publisherToken, log, fetchImpl } = options;
  try {
    const health = await fetchImpl(`${publisherUrl}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(2_000) });
    if (!health.ok) return false;
  } catch { return false; }
  for (const tenantId of await tenantIds()) {
    const job = await inTenantTransaction(tenantId, async (client) => {
      await client.query(`update avatar_build_jobs set publish_status = 'queued', updated_at = now()
        where tenant_id = $1 and review_status = 'approved' and publish_status = 'publishing' and updated_at < now() - interval '2 minutes'`, [tenantId]);
      const result = await client.query(`with candidate as (
          select id from avatar_build_jobs where tenant_id = $1 and review_status = 'approved'
            and publish_status in ('queued', 'failed') and publish_attempts < 3
            and (publish_status = 'queued' or publish_error_code is distinct from 'avatar_source_stale')
            and (publish_status = 'queued' or updated_at < now() - interval '1 minute')
          order by updated_at, created_at, id for update skip locked limit 1
        )
        update avatar_build_jobs job set publish_status = 'publishing', publish_attempts = job.publish_attempts + 1,
          publish_error_code = null, updated_at = now()
        from candidate where job.id = candidate.id and job.tenant_id = $1
        returning job.id, job.tenant_id, job.project_id, job.project_revision, job.source_checksum`, [tenantId]);
      return result.rows[0] ?? null;
    });
    if (!job) continue;
    const avatarId = `sr_${job.id.replaceAll("-", "").toLowerCase()}`;
    try {
      const checkResponse = await fetchImpl(`${controlPlaneUrl}/api/v1/runtime/avatar-build-jobs/${encodeURIComponent(job.id)}/publish-check`, {
        method: "POST",
        headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ tenantId: job.tenant_id }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000)
      });
      if (checkResponse.status === 409) {
        await failPublish(job, "avatar_source_stale", options);
        log("avatar_build.publish_rejected_stale_source", { jobId: job.id, tenantId: job.tenant_id });
        return true;
      }
      if (!checkResponse.ok) throw new Error("avatar_publish_check_failed");
      const check = await checkResponse.json();
      if (check?.data?.source_checksum !== job.source_checksum || check?.data?.project_revision !== job.project_revision) throw new Error("avatar_publish_check_receipt_invalid");
      const response = await fetchImpl(`${publisherUrl}/v1/publish`, {
        method: "POST",
        headers: { authorization: `Bearer ${publisherToken}`, "content-type": "application/json" },
        body: JSON.stringify({ tenantId: job.tenant_id, candidateId: job.id, sourceChecksum: job.source_checksum }),
        cache: "no-store",
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) throw new Error("avatar_publisher_rejected_candidate");
      const payload = await response.json();
      if (payload?.data?.status !== "published" || payload?.data?.avatarId !== avatarId) throw new Error("avatar_publisher_receipt_invalid");
      await inTenantTransaction(job.tenant_id, async (client) => {
        const completed = await client.query(`update avatar_build_jobs set publish_status = 'published', runtime_avatar_id = $4,
            publish_error_code = null, updated_at = now()
          where tenant_id = $1 and id = $2 and publish_status = 'publishing' and source_checksum = $3 returning id`,
        [job.tenant_id, job.id, job.source_checksum, avatarId]);
        if (completed.rowCount) await auditPublish(client, job, "avatar_build.published", { avatarId, projectRevision: job.project_revision, sourceChecksum: job.source_checksum });
      });
      log("avatar_build.published", { jobId: job.id, tenantId: job.tenant_id, avatarId });
    } catch (error) {
      await failPublish(job, "avatar_publish_failed", options);
      log("avatar_build.publish_failed", { jobId: job.id, tenantId: job.tenant_id, error: error instanceof Error ? error.message : "avatar_publish_failed" });
    }
    return true;
  }
  return false;
}

async function failPublish(job, code, { inTenantTransaction }) {
  await inTenantTransaction(job.tenant_id, async (client) => {
    const failed = await client.query(`update avatar_build_jobs set publish_status = 'failed', publish_error_code = $3, updated_at = now()
      where tenant_id = $1 and id = $2 and publish_status = 'publishing' returning id`, [job.tenant_id, job.id, code]);
    if (failed.rowCount) await auditPublish(client, job, code === "avatar_source_stale" ? "avatar_build.publish_rejected_stale_source" : "avatar_build.publish_failed", { projectRevision: job.project_revision, sourceChecksum: job.source_checksum, failureCode: code });
  });
}

async function auditPublish(client, job, eventType, detail) {
  const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [job.tenant_id]);
  await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
    values ($1, $2, $3, 'avatar_build_job', $4::uuid, $4, $5::jsonb)`, [job.tenant_id, actor.rows[0].id, eventType, job.id, JSON.stringify(detail)]);
}
