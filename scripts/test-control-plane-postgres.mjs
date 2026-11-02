import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

if (process.env.RUN_CONTROL_PLANE_INTEGRATION_TESTS !== "true") throw new Error("Set RUN_CONTROL_PLANE_INTEGRATION_TESTS=true to run database integration tests");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consoleRoot = path.join(root, "apps", "console");
const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const worker = path.join(root, "apps", "runtime-worker", "index.mjs");
const tenantId = randomUUID();
const gatewayToken = "control-plane-integration-gateway-token";
const commerceToken = "control-plane-integration-commerce-token";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "integration-key", alg: "RS256", use: "sig" };
const client = new Client({ connectionString: databaseUrl });
let mock;
let next;
let workerProcess;

try {
  await client.connect();
  mock = await startMockServer();
  const consolePort = await availablePort();
  const issuer = `${mock.baseUrl}/issuer`;
  const token = await new SignJWT({ tenant_id: tenantId, role: "admin", name: "Integration Admin" })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key" })
    .setSubject("integration-operator")
    .setIssuer(issuer)
    .setAudience("shuzhiren-integration")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const recoverRun = await seedRun("DEGRADED", "session_recover", new Date());
  const staleRun = await seedRun("LIVE", "session_stale", new Date(Date.now() - 120_000));
  const recoverRunId = recoverRun.runId;
  const staleRunId = staleRun.runId;
  next = spawn(process.execPath, [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(consolePort)], {
    cwd: consoleRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      CONTROL_PLANE_DEMO_MODE: "false",
      RUNTIME_GATEWAY_URL: mock.baseUrl,
      RUNTIME_SHARED_TOKEN: gatewayToken,
      RUNTIME_GATEWAY_DEMO_MODE: "false",
      OIDC_ISSUER_URL: issuer,
      OIDC_AUDIENCE: "shuzhiren-integration",
      OIDC_JWKS_URL: `${mock.baseUrl}/jwks`,
      CHANNEL_COMMERCE_TENANT_TOKENS: JSON.stringify({ [tenantId]: commerceToken })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${consolePort}/api/health`)).ok, 20_000, "control plane startup");

  const requestHeaders = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const productResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/products`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ externalSku: `integration-sku-${tenantId}`, name: "Integration product" })
  });
  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();
  const staleFacts = { priceCent: 9900, stock: 20, highlights: ["事实卖点"], faq: ["事实 FAQ"], sourceRef: "pim://integration/stale", sourceSyncedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), validFrom: new Date(Date.now() - 26 * 60 * 60_000).toISOString() };
  const staleVersionResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/products/${product.data.id}/versions`, { method: "POST", headers: requestHeaders, body: JSON.stringify(staleFacts) });
  assert.equal(staleVersionResponse.status, 201);
  const staleVersion = await staleVersionResponse.json();
  const staleApproval = await fetch(`http://127.0.0.1:${consolePort}/api/v1/products/${product.data.id}/versions/${staleVersion.data.id}/approve`, { method: "POST", headers: requestHeaders });
  assert.equal(staleApproval.status, 409, "stale product source facts must not be approved");
  const freshFacts = { ...staleFacts, sourceRef: "pim://integration/fresh", sourceSyncedAt: new Date().toISOString(), validFrom: new Date().toISOString() };
  const freshVersionResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/products/${product.data.id}/versions`, { method: "POST", headers: requestHeaders, body: JSON.stringify(freshFacts) });
  assert.equal(freshVersionResponse.status, 201);
  const freshVersion = await freshVersionResponse.json();
  const freshApproval = await fetch(`http://127.0.0.1:${consolePort}/api/v1/products/${product.data.id}/versions/${freshVersion.data.id}/approve`, { method: "POST", headers: requestHeaders });
  assert.equal(freshApproval.status, 200, "fresh product source facts should be approvable");

  const commandResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/commands`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: randomUUID() })
  });
  assert.equal(commandResponse.status, 202);
  const commandBody = await commandResponse.json();
  assert.equal(commandBody.data.run.state, "DEGRADED", "recovery must wait for runtime acknowledgement");
  const eventId = commandBody.data.mediaEvent.id;
  const pending = await client.query("select state, scheduled_start_event_id from live_runs where id = $1", [recoverRunId]);
  assert.equal(pending.rows[0].state, "DEGRADED");
  assert.equal(pending.rows[0].scheduled_start_event_id, eventId);

  const duplicateResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/commands`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: randomUUID() })
  });
  assert.equal(duplicateResponse.status, 409, "a second recovery must not race the pending acknowledgement");

  const deliveryResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${eventId}/deliver`, { method: "POST", headers: requestHeaders });
  assert.equal(deliveryResponse.status, 202);
  await waitFor(async () => (await client.query("select state from live_runs where id = $1", [recoverRunId])).rows[0]?.state === "LIVE", 5_000, "recovery acknowledgement");
  assert.equal(mock.mediaCommands.length, 1);
  assert.equal(mock.mediaCommands[0].action, "start_program");

  const commerceHeaders = { "content-type": "application/json", authorization: `Bearer ${commerceToken}` };
  for (const event of [
    { eventId: "view-1", eventType: "view" },
    { eventId: "cart-1", eventType: "add_to_cart" },
    { eventId: "paid-1", eventType: "order_paid", orderReference: "order-1", amountCents: 19900 },
    { eventId: "refund-1", eventType: "refund", orderReference: "order-1", amountCents: 5000 }
  ]) {
    const response = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/channel-commerce`, {
      method: "POST",
      headers: commerceHeaders,
      body: JSON.stringify({ tenantId, runId: recoverRunId, channelConnectionId: recoverRun.channelId, ...event })
    });
    assert.equal(response.status, 202, `commerce event ${event.eventId} should be accepted`);
  }
  const duplicateCommerce = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/channel-commerce`, {
    method: "POST",
    headers: commerceHeaders,
    body: JSON.stringify({ tenantId, runId: recoverRunId, channelConnectionId: recoverRun.channelId, eventId: "paid-1", eventType: "order_paid", orderReference: "order-1", amountCents: 19900 })
  });
  assert.equal(duplicateCommerce.status, 200, "identical commerce retries must be idempotent");
  const summaryResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/commerce-summary`, { headers: requestHeaders });
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.deepEqual(summary.data, { runId: recoverRunId, views: 1, productClicks: 0, addToCart: 1, paidOrders: 1, refunds: 1, grossPaidCents: 19900, refundedCents: 5000, netPaidCents: 14900, viewToCartRate: 1, viewToPaidRate: 1, refundRate: 1 });
  const commerceAudit = await client.query("select event_type from audit_events where resource_type = 'commerce_event' order by occurred_at");
  assert.deepEqual(commerceAudit.rows.map((row) => row.event_type), ["commerce_event.order_paid", "commerce_event.refund"]);

  workerProcess = spawn(process.execPath, [worker], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      RUNTIME_GATEWAY_URL: mock.baseUrl,
      RUNTIME_SHARED_TOKEN: gatewayToken,
      OUTBOX_POLL_MS: "20",
      SCHEDULER_POLL_MS: "1000",
      SCHEDULER_BATCH_SIZE: "1",
      RUNTIME_WATCHDOG_POLL_MS: "10",
      RUNTIME_WATCHDOG_BATCH_SIZE: "1",
      RUNTIME_TELEMETRY_MAX_AGE_SECONDS: "60"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => (await client.query("select state from live_runs where id = $1", [staleRunId])).rows[0]?.state === "DEGRADED", 10_000, "stale telemetry watchdog");
  const alert = await client.query("select code, status from runtime_alerts where live_run_id = $1 and code = 'runtime_telemetry_stale'", [staleRunId]);
  assert.deepEqual(alert.rows[0], { code: "runtime_telemetry_stale", status: "open" });
  const audit = await client.query("select event_type from audit_events where resource_key = $1 and event_type = 'runtime_guard.degraded'", [staleRunId]);
  assert.equal(audit.rows.length, 1);
  const fallback = await client.query("select state, payload #>> '{command,type}' as action from outbox_events where aggregate_id = $1 order by created_at desc limit 1", [staleRunId]);
  assert.deepEqual(fallback.rows[0], { state: "delivered", action: "switch_to_fallback" });
  console.log("PASS  PostgreSQL control plane rejects stale product facts, gates recovery, records idempotent commerce facts, and degrades stale LIVE telemetry");
} finally {
  await stop(workerProcess);
  await stop(next);
  if (mock) await new Promise((resolve) => mock.server.close(resolve));
  await client.end();
}

async function seedRun(state, sessionId, sampledAt) {
  const showId = randomUUID();
  const revisionId = randomUUID();
  const runId = randomUUID();
  const channelId = randomUUID();
  await client.query("insert into tenants (id, slug, name) values ($1, $2, $3) on conflict (id) do nothing", [tenantId, `integration-${tenantId}`, "Control plane integration"]);
  await client.query("insert into shows (id, tenant_id, name) values ($1, $2, $3)", [showId, tenantId, `Integration show ${runId}`]);
  await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 1, '{}'::jsonb, 'approved')", [revisionId, tenantId, showId]);
  const capabilities = { channel: "integration-webhook", supportsRtmp: true, supportsSrt: false, supportsComments: true, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: true };
  await client.query("insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at) values ($1, $2, $3, 'normalized-webhook-rtmp', 'connected', 'rtmp', 'secret://integration/channel', $4::jsonb, now())", [channelId, tenantId, `Integration channel ${runId}`, JSON.stringify(capabilities)]);
  await client.query("insert into live_runs (id, tenant_id, show_revision_id, state, trace_id, runtime_session_id, channel_connection_id) values ($1, $2, $3, $4::live_run_state, $5, $6, $7)", [runId, tenantId, revisionId, state, `trace_${runId}`, sessionId, channelId]);
  await client.query("insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, fallback_ready, sampled_at) values ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, $3)", [tenantId, runId, sampledAt]);
  return { runId, channelId };
}

async function startMockServer() {
  const mediaCommands = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/jwks") return json(response, 200, { keys: [jwk] });
    if (url.pathname === "/v1/media" && request.method === "POST") {
      assert.equal(request.headers.authorization, `Bearer ${gatewayToken}`);
      mediaCommands.push(await requestBody(request));
      return json(response, 200, { accepted: true });
    }
    return json(response, 404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind a TCP port");
  return { server, mediaCommands, baseUrl: `http://127.0.0.1:${address.port}` };
}

function json(response, status, value) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
async function requestBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
async function availablePort() { const server = http.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); await new Promise((resolve) => server.close(resolve)); if (!address || typeof address === "string") throw new Error("could not reserve a TCP port"); return address.port; }
async function waitFor(predicate, timeoutMs, label) { const deadline = Date.now() + timeoutMs; let lastError; while (Date.now() < deadline) { try { if (await predicate()) return; } catch (error) { lastError = error; } await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`); }
async function stop(child) { if (!child || child.exitCode !== null) return; child.kill("SIGTERM"); await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
