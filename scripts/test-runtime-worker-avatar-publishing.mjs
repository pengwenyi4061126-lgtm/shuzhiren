import assert from "node:assert/strict";
import test from "node:test";
import { createAvatarPublishProcessor } from "../apps/runtime-worker/avatar-publishing.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const checksum = `sha256:${"a".repeat(64)}`;

function fixture({ includeJob = true, publisherPayload, publishCheckStatus = 200 } = {}) {
  const calls = { queries: [], requests: [], audits: 0 };
  const job = { id: jobId, tenant_id: tenantId, project_id: "33333333-3333-4333-8333-333333333333", project_revision: 7, source_checksum: checksum };
  const inTenantTransaction = async (_tenantId, callback) => callback({
    async query(sql, params = []) {
      calls.queries.push({ sql, params });
      if (sql.includes("returning job.id, job.tenant_id")) return { rows: includeJob ? [job] : [], rowCount: includeJob ? 1 : 0 };
      if (sql.includes("update avatar_build_jobs set publish_status = 'published'") || sql.includes("update avatar_build_jobs set publish_status = 'failed'")) return { rows: [{ id: jobId }], rowCount: 1 };
      if (sql.includes("runtime_worker_actor")) return { rows: [{ id: "worker-actor" }], rowCount: 1 };
      if (sql.includes("insert into audit_events")) { calls.audits++; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
  });
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/healthz")) return new Response(null, { status: 200 });
    if (String(url).includes("/publish-check")) {
      calls.requests.push({ url: String(url), init });
      return Response.json(publishCheckStatus === 200 ? { data: { source_checksum: checksum, project_revision: 7 } } : { error: "avatar_source_stale" }, { status: publishCheckStatus });
    }
    calls.requests.push({ url: String(url), init });
    return Response.json({ data: publisherPayload ?? { avatarId: `sr_${jobId.replaceAll("-", "")}`, status: "published" } });
  };
  const processor = createAvatarPublishProcessor({ tenantIds: async () => [tenantId], inTenantTransaction, controlPlaneUrl: "http://control-plane:3000", runtimeToken: "r".repeat(48), publisherUrl: "http://avatar-publisher:8021", publisherToken: "p".repeat(48), log() {}, fetchImpl });
  return { processor, calls };
}

test("publisher claims only reviewer-approved current candidates and records the runtime artifact", async () => {
  const { processor, calls } = fixture();
  assert.equal(await processor.runOnce(), true);
  assert.equal(calls.requests.length, 2);
  assert.match(calls.requests[0].url, /\/publish-check$/);
  assert.equal(calls.requests[0].init.headers.authorization, `Bearer ${"r".repeat(48)}`);
  assert.equal(calls.requests[1].url, "http://avatar-publisher:8021/v1/publish");
  assert.equal(calls.requests[1].init.headers.authorization, `Bearer ${"p".repeat(48)}`);
  assert.deepEqual(JSON.parse(calls.requests[1].init.body), { tenantId, candidateId: jobId, sourceChecksum: checksum });
  assert.match(calls.queries[0].sql, /publish_status = 'publishing'.*updated_at < now\(\) - interval '2 minutes'/s);
  assert.match(calls.queries[1].sql, /review_status = 'approved'/);
  assert.match(calls.queries[1].sql, /updated_at < now\(\) - interval '1 minute'/);
  assert.equal(calls.audits, 1);
});

test("publisher leaves the queue idle when no approved candidate is available", async () => {
  const { processor, calls } = fixture({ includeJob: false });
  assert.equal(await processor.runOnce(), false);
  assert.equal(calls.requests.length, 0);
});

test("publisher does not claim approved jobs while the isolated publisher is unhealthy", async () => {
  let claims = 0;
  const processor = createAvatarPublishProcessor({
    tenantIds: async () => [tenantId],
    inTenantTransaction: async (_tenantId, callback) => callback({ async query(sql) { if (sql.includes("returning job.id, job.tenant_id")) claims++; return { rows: [], rowCount: 0 }; } }),
    controlPlaneUrl: "http://control-plane:3000", runtimeToken: "r".repeat(48), publisherUrl: "http://avatar-publisher:8021", publisherToken: "p".repeat(48), log() {},
    fetchImpl: async () => new Response(null, { status: 503 })
  });
  assert.equal(await processor.runOnce(), false);
  assert.equal(claims, 0);
});

test("publisher checks current project revision through the control plane and marks stale candidates without publishing", async () => {
  const { processor, calls } = fixture({ publishCheckStatus: 409 });
  assert.equal(await processor.runOnce(), true);
  assert.equal(calls.requests.length, 1);
  assert.match(calls.requests[0].url, /\/publish-check$/);
  assert.equal(calls.requests[0].init.headers.authorization, `Bearer ${"r".repeat(48)}`);
  assert.ok(calls.queries.some(({ sql, params }) => sql.includes("publish_status = 'failed'") && params[2] === "avatar_source_stale"));
});

test("publisher rejects a receipt for a different runtime avatar id", async () => {
  const { processor, calls } = fixture({ publisherPayload: { data: { avatarId: "sr_wrong", status: "published" } } });
  assert.equal(await processor.runOnce(), true);
  assert.ok(calls.queries.some(({ sql }) => sql.includes("publish_status = 'failed'")));
  assert.equal(calls.audits, 1);
});
