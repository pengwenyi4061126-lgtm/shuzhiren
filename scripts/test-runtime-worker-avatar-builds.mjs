import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createAvatarBuildProcessor } from "../apps/runtime-worker/avatar-builds.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const leaseToken = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const sourceBytes = Buffer.from("verified portrait source");
const previewBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function fixture({ activeLiveRun = false, healthy = true, includeJob = true } = {}) {
  const calls = { claimed: 0, source: 0, build: 0, poll: 0, preview: 0, complete: 0, unlocked: 0, released: 0 };
  const job = { id: jobId, tenant_id: tenantId, project_id: "55555555-5555-4555-8555-555555555555", project_revision: 4, source_asset_id: "66666666-6666-4666-8666-666666666666", source_checksum: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`, source_object_version: "version-3", source_bytes: sourceBytes.length, source_content_type: "video/mp4", attempts: 1, lease_token: leaseToken };
  const pool = { async connect() { return { async query(sql) { if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] }; calls.unlocked++; return { rows: [{ pg_advisory_unlock: true }] }; }, release(error) { assert.equal(error, undefined); calls.released++; } }; } };
  const inTenantTransaction = async (_tenant, operation) => operation({ async query(sql, params) {
    if (sql.includes("from live_runs")) return { rows: activeLiveRun ? [{ id: "live-run" }] : [], rowCount: activeLiveRun ? 1 : 0 };
    if (sql.includes("set status = 'failed'")) return { rows: [], rowCount: 0 };
    if (sql.includes("with candidate as")) { calls.claimed++; return { rows: includeJob ? [{ ...job, lease_token: params[1] }] : [], rowCount: includeJob ? 1 : 0 }; }
    if (sql.includes("set progress = $4")) return { rows: [{ id: jobId }], rowCount: 1 };
    if (sql.includes("set status = 'preview_ready'")) { calls.complete++; assert.deepEqual(params[3], previewBytes); return { rows: [{ id: jobId }], rowCount: 1 }; }
    if (sql.includes("runtime_worker_actor")) return { rows: [{ id: "actor-runtime-worker" }], rowCount: 1 };
    if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  } });
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/healthz")) return new Response(null, { status: healthy ? 200 : 503 });
    if (url.endsWith(`/api/v1/runtime/avatar-build-jobs/${jobId}/source`)) { calls.source++; return Response.json({ data: { downloadUrl: "https://storage.example.test/source?signature=fixture" } }); }
    if (url.startsWith("https://storage.example.test/")) return new Response(sourceBytes, { headers: { "content-length": String(sourceBytes.length) } });
    if (url.endsWith("/v1/builds")) {
      calls.build++;
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("source_checksum"), job.source_checksum, "builder receives the verified source checksum for idempotent recovery");
      return Response.json({ data: { taskId } }, { status: 202 });
    }
    if (url.endsWith(`/v1/builds/${taskId}`)) { calls.poll++; return Response.json({ data: calls.poll === 1 ? { status: "running", progress: 45 } : { status: "completed", progress: 100 } }); }
    if (url.endsWith(`/v1/candidates/${tenantId}/${jobId}/preview`)) { calls.preview++; return new Response(previewBytes, { headers: { "content-type": "image/jpeg" } }); }
    throw new Error(`Unexpected request: ${url}`);
  };
  const processor = createAvatarBuildProcessor({ pool, tenantIds: async () => [tenantId], inTenantTransaction, controlPlaneUrl: "https://control.example.test", runtimeToken: "runtime-token-fixture", builderUrl: "http://avatar-builder:8020", builderToken: "b".repeat(48), log() {}, fetchImpl, pollIntervalMs: 0 });
  return { processor, calls };
}

test("Avatar worker claims only while GPU is free, verifies source bytes, and persists a tenant-scoped review preview", async () => {
  const { processor, calls } = fixture();
  assert.equal(await processor.runOnce(), true);
  assert.equal(calls.claimed, 1);
  assert.equal(calls.source, 1);
  assert.equal(calls.build, 1);
  assert.equal(calls.preview, 1);
  assert.equal(calls.complete, 1);
  assert.equal(calls.unlocked, 2);
  assert.equal(calls.released, 1);
});

test("Avatar worker leaves queued work untouched while a live run reserves the single GPU", async () => {
  const { processor, calls } = fixture({ activeLiveRun: true });
  assert.equal(await processor.runOnce(), false);
  assert.equal(calls.claimed, 0);
  assert.equal(calls.source, 0);
  assert.equal(calls.unlocked, 2);
});

test("Avatar worker waits for the optional builder profile instead of claiming jobs while it is offline", async () => {
  const { processor, calls } = fixture({ healthy: false });
  assert.equal(await processor.runOnce(), false);
  assert.equal(calls.claimed, 0);
  assert.equal(calls.released, 0);
});
