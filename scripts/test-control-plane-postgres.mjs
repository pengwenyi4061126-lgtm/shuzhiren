import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
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
const channelAdapter = path.join(root, "apps", "channel-adapter", "index.mjs");
const alertNotifier = path.join(root, "apps", "alert-notifier", "index.mjs");
const tenantId = randomUUID();
const isolatedTenantId = randomUUID();
const gatewayToken = "control-plane-integration-gateway-token";
const commerceToken = "control-plane-integration-commerce-token";
const recordingToken = "control-plane-integration-recording-token";
const pimToken = "control-plane-integration-pim-token";
const isolatedPimToken = "control-plane-integration-isolated-pim-token";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "integration-key", alg: "RS256", use: "sig" };
const client = new Client({ connectionString: databaseUrl });
let mock;
let next;
let workerProcess;
let adapterProcess;
let notifierProcess;

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
  const operatorToken = await new SignJWT({ tenant_id: tenantId, role: "operator", name: "Integration Operator" })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key" })
    .setSubject("integration-second-operator")
    .setIssuer(issuer)
    .setAudience("shuzhiren-integration")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const isolatedToken = await new SignJWT({ tenant_id: isolatedTenantId, role: "admin", name: "Isolated Tenant Admin" })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key" })
    .setSubject("isolated-operator")
    .setIssuer(issuer)
    .setAudience("shuzhiren-integration")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const recoverRun = await seedRun("DEGRADED", "session_recover", new Date());
  const staleRun = await seedRun("LIVE", "session_stale", new Date(Date.now() - 120_000));
  await client.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [isolatedTenantId, `isolated-${isolatedTenantId}`, "Isolated integration tenant"]);
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
      CHANNEL_COMMERCE_TENANT_TOKENS: JSON.stringify({ [tenantId]: commerceToken }),
      RUNTIME_RECORDING_TENANT_TOKENS: JSON.stringify({ [tenantId]: recordingToken }),
      PIM_INGEST_TENANT_TOKENS: JSON.stringify({ [tenantId]: pimToken, [isolatedTenantId]: isolatedPimToken })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${consolePort}/api/health`)).ok, 20_000, "control plane startup");

  const requestHeaders = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const isolatedRequestHeaders = { authorization: `Bearer ${isolatedToken}` };
  const foreignRunRead = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}`, { headers: isolatedRequestHeaders });
  assert.equal(foreignRunRead.status, 404, "one tenant must not read another tenant's live run");
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
  const freshFacts = { ...staleFacts, unitCostCent: 3500, sourceRef: "pim://integration/fresh", sourceSyncedAt: new Date().toISOString(), validFrom: new Date().toISOString() };
  const freshVersionResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/products/${product.data.id}/versions`, { method: "POST", headers: requestHeaders, body: JSON.stringify(freshFacts) });
  assert.equal(freshVersionResponse.status, 201);
  const freshVersion = await freshVersionResponse.json();
  const freshApproval = await fetch(`http://127.0.0.1:${consolePort}/api/v1/products/${product.data.id}/versions/${freshVersion.data.id}/approve`, { method: "POST", headers: requestHeaders });
  assert.equal(freshApproval.status, 200, "fresh product source facts should be approvable");
  await client.query("update live_runs set product_version_id = $2 where id = $1", [recoverRunId, freshVersion.data.id]);
  const createdRunResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ showName: "Integration frozen rights run", channelConnectionId: recoverRun.channelId, productVersionId: freshVersion.data.id, runtimeSessionId: "session_frozen_rights", aiDisclosureEnabled: true }) });
  assert.equal(createdRunResponse.status, 201, "creating a production run should freeze currently approved media rights");
  const createdRun = await createdRunResponse.json();
  const frozenRights = await client.query("select kind from show_revision_media_assets where show_revision_id = (select show_revision_id from live_runs where id = $1) order by kind", [createdRun.data.id]);
  assert.deepEqual(frozenRights.rows.map((row) => row.kind), ["music", "portrait", "product_clip", "voice"]);
  const policyEvaluation = await fetch(`http://127.0.0.1:${consolePort}/api/v1/policy/evaluate`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ question: "这款敏感肌可以用吗？", evidenceIds: ["product_version"] }) });
  assert.equal(policyEvaluation.status, 200);
  const policyDecision = await policyEvaluation.json();
  assert.equal(policyDecision.data.action, "handoff");
  const profileCreated = await fetch(`http://127.0.0.1:${consolePort}/api/v1/policy/profiles`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ name: "Integration candidate policy", version: "1.0.0", rules: [], evidenceRef: "evidence://policy/integration-candidate", validationSummary: "Integration approval workflow validation." })
  });
  assert.equal(profileCreated.status, 201, "operator should register a reviewable policy profile");
  const profile = await profileCreated.json();
  assert.equal(profile.data.approval, "pending");
  const profileApproved = await fetch(`http://127.0.0.1:${consolePort}/api/v1/policy/profiles/${profile.data.id}/approve`, { method: "POST", headers: requestHeaders });
  assert.equal(profileApproved.status, 200, "reviewer workflow should approve a policy profile with evidence");
  const profileList = await fetch(`http://127.0.0.1:${consolePort}/api/v1/policy/profiles`, { headers: requestHeaders });
  assert.equal(profileList.status, 200);
  assert.equal((await profileList.json()).data.some((item) => item.id === profile.data.id && item.approval === "approved"), true);
  const governedInteraction = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/interactions`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ question: "这是一条集成策略禁播词", source: "integration", evidenceIds: ["product_version"] })
  });
  assert.equal(governedInteraction.status, 201, "a live run should evaluate its frozen policy profile");
  assert.equal((await governedInteraction.json()).data.decision, "refuse", "a bound policy profile rule must block its configured term");
  const policyAudit = await client.query("select detail from audit_events where event_type = 'policy.evaluated'");
  assert.equal(policyAudit.rows.length, 1);
  assert.equal(policyAudit.rows[0].detail.questionSha256.length, 64, "policy audit must retain a hash rather than the raw question");
  assert.equal(JSON.stringify(policyAudit.rows[0].detail).includes("敏感肌"), false, "policy audit must not retain the raw question text");

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
  await client.query("insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, fallback_ready, sampled_at) values ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, now() - interval '30 seconds'), ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, now() - interval '15 seconds')", [tenantId, recoverRunId]);
  const samplingSloResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/slo`, { headers: requestHeaders });
  assert.equal(samplingSloResponse.status, 200, "operators should read a run's sampling quality SLO");
  const samplingSlo = await samplingSloResponse.json();
  assert.equal(samplingSlo.data.status, "met");
  assert.equal(samplingSlo.data.sampleCount, 3);
  assert.equal(samplingSlo.data.healthRate, 1);

  const recordingInput = {
    tenantId,
    runId: recoverRunId,
    objectKey: `recordings/${tenantId}/${recoverRunId}/program.mp4`,
    checksumSha256: "a".repeat(64),
    bytes: 125_000_000,
    durationSeconds: 3720,
    startedAt: new Date(Date.now() - 3_720_000).toISOString(),
    endedAt: new Date().toISOString(),
    retentionUntil: "2027-11-02",
    idempotencyKey: "recording-program-v1"
  };
  const recordingHeaders = { "content-type": "application/json", authorization: `Bearer ${recordingToken}` };
  const recordingRegistered = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/recordings`, { method: "POST", headers: recordingHeaders, body: JSON.stringify(recordingInput) });
  assert.equal(recordingRegistered.status, 201, "verified recording evidence should be accepted once");
  const recordingRetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/recordings`, { method: "POST", headers: recordingHeaders, body: JSON.stringify(recordingInput) });
  assert.equal(recordingRetry.status, 200, "recording evidence retries must be idempotent");
  const recordings = await fetch(`http://127.0.0.1:${consolePort}/api/v1/recordings`, { headers: requestHeaders });
  assert.equal(recordings.status, 200);
  const recordingsBody = await recordings.json();
  assert.equal(recordingsBody.data.length, 1);
  assert.equal(recordingsBody.data[0].objectKey, recordingInput.objectKey);
  const recordingAudit = await client.query("select event_type from audit_events where resource_type = 'recording_evidence'");
  assert.deepEqual(recordingAudit.rows.map((row) => row.event_type), ["recording_evidence.registered"]);

  const productFactInput = { tenantId, eventId: "pim-product-fact-1", externalSku: `pim-${tenantId}`, name: "PIM managed product", facts: { priceCent: 12900, stock: 18, highlights: ["PIM evidence"], faq: ["PIM FAQ"], sourceRef: "pim://integration/product-fact-1", sourceSyncedAt: new Date().toISOString(), validFrom: new Date(Date.now() - 60_000).toISOString() } };
  const productFactHeaders = { "content-type": "application/json", authorization: `Bearer ${pimToken}` };
  const productFactCreated = await fetch(`http://127.0.0.1:${consolePort}/api/v1/integrations/product-facts`, { method: "POST", headers: productFactHeaders, body: JSON.stringify(productFactInput) });
  assert.equal(productFactCreated.status, 202, "PIM product facts should create a reviewable draft version");
  const productFactPayload = await productFactCreated.json();
  assert.equal(productFactPayload.data.version.status, "draft", "PIM ingestion must not self-approve product facts");
  const productFactRetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/integrations/product-facts`, { method: "POST", headers: productFactHeaders, body: JSON.stringify(productFactInput) });
  assert.equal(productFactRetry.status, 200, "PIM product fact retries must return the existing draft");
  const conflictingProductFact = await fetch(`http://127.0.0.1:${consolePort}/api/v1/integrations/product-facts`, { method: "POST", headers: productFactHeaders, body: JSON.stringify({ ...productFactInput, facts: { ...productFactInput.facts, stock: 19 } }) });
  assert.equal(conflictingProductFact.status, 409, "reusing a PIM event ID with different facts must be rejected");
  const productFactRows = await client.query("select count(*) as count from product_fact_ingest_events where external_event_id = $1", [productFactInput.eventId]);
  assert.equal(Number(productFactRows.rows[0].count), 1);
  const productFactAudit = await client.query("select event_type from audit_events where resource_type = 'product_version' and event_type = 'product_facts.ingested'");
  assert.equal(productFactAudit.rows.length, 1);
  const crossTenantPimAttempt = await fetch(`http://127.0.0.1:${consolePort}/api/v1/integrations/product-facts`, { method: "POST", headers: productFactHeaders, body: JSON.stringify({ ...productFactInput, tenantId: isolatedTenantId }) });
  assert.equal(crossTenantPimAttempt.status, 401, "a PIM credential must not write another tenant's product facts");
  const isolatedProductFact = await fetch(`http://127.0.0.1:${consolePort}/api/v1/integrations/product-facts`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${isolatedPimToken}` }, body: JSON.stringify({ ...productFactInput, tenantId: isolatedTenantId }) });
  assert.equal(isolatedProductFact.status, 202, "the same external PIM event ID may be used independently by another tenant");

  const entitlementUpdate = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements/max_concurrent_live_runs`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ limitValue: 1 }) });
  assert.equal(entitlementUpdate.status, 200, "admin should configure tenant concurrency entitlement");
  const minuteEntitlementUpdate = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements/monthly_live_minutes`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ limitValue: 1000 }) });
  assert.equal(minuteEntitlementUpdate.status, 200, "admin should configure tenant live-minute entitlement");
  const entitlementList = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements`, { headers: requestHeaders });
  assert.equal(entitlementList.status, 200);
  const entitlementBody = await entitlementList.json();
  assert.equal(entitlementBody.data.find((item) => item.code === "max_concurrent_live_runs")?.used, 1);
  assert.equal(entitlementBody.data.find((item) => item.code === "monthly_live_minutes")?.limitValue, 1000);
  const limitedRun = await seedRun("DEGRADED", "session_entitlement_limit", new Date());
  const blockedRecovery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${limitedRun.runId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: randomUUID() }) });
  assert.equal(blockedRecovery.status, 409, "configured concurrency entitlement must block a second live activation");

  const adapterPort = await availablePort();
  const adapterSigningSecret = "control-plane-integration-adapter-signing-secret";
  adapterProcess = spawn(process.execPath, [channelAdapter], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      CONTROL_PLANE_URL: `http://127.0.0.1:${consolePort}`,
      CHANNEL_ADAPTER_PORT: String(adapterPort),
      CHANNEL_ADAPTER_TARGETS: JSON.stringify([{ tenantId, channelConnectionId: recoverRun.channelId, signingSecret: adapterSigningSecret, interactionToken: "control-plane-integration-interaction-token", commerceToken }])
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${adapterPort}/healthz`)).ok, 10_000, "channel adapter startup");
  const adapterEventId = "adapter-paid-1";
  const adapterPayload = JSON.stringify({ kind: "commerce", runId: recoverRunId, eventType: "order_paid", orderReference: "adapter-order-1", amountCents: 9900, quantity: 1 });
  const adapterTimestamp = String(Date.now());
  const adapterSignature = `sha256=${createHmac("sha256", adapterSigningSecret).update(`${adapterTimestamp}.${adapterPayload}`).digest("hex")}`;
  const adapterHeaders = { "content-type": "application/json", "x-shuzhiren-event-id": adapterEventId, "x-shuzhiren-timestamp": adapterTimestamp, "x-shuzhiren-signature": adapterSignature };
  const adapterDelivery = await fetch(`http://127.0.0.1:${adapterPort}/v1/webhooks/${recoverRun.channelId}`, { method: "POST", headers: adapterHeaders, body: adapterPayload });
  assert.equal(adapterDelivery.status, 202, "signed adapter commerce event should be forwarded");
  const adapterDuplicate = await fetch(`http://127.0.0.1:${adapterPort}/v1/webhooks/${recoverRun.channelId}`, { method: "POST", headers: adapterHeaders, body: adapterPayload });
  assert.equal(adapterDuplicate.status, 200, "delivered adapter event should be deduplicated before forwarding");
  const adapterReplay = await client.query("select state from channel_webhook_replays where channel_connection_id = $1 and external_event_id = $2", [recoverRun.channelId, adapterEventId]);
  assert.deepEqual(adapterReplay.rows[0], { state: "delivered" });

  const commerceHeaders = { "content-type": "application/json", authorization: `Bearer ${commerceToken}` };
  for (const event of [
    { eventId: "view-1", eventType: "view" },
    { eventId: "cart-1", eventType: "add_to_cart" },
    { eventId: "paid-1", eventType: "order_paid", orderReference: "order-1", amountCents: 19900, quantity: 2 },
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
    body: JSON.stringify({ tenantId, runId: recoverRunId, channelConnectionId: recoverRun.channelId, eventId: "paid-1", eventType: "order_paid", orderReference: "order-1", amountCents: 19900, quantity: 2 })
  });
  assert.equal(duplicateCommerce.status, 200, "identical commerce retries must be idempotent");
  const summaryResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/commerce-summary`, { headers: requestHeaders });
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.deepEqual(summary.data, { runId: recoverRunId, views: 1, productClicks: 0, addToCart: 1, paidOrders: 2, paidUnits: 3, refunds: 1, grossPaidCents: 29800, refundedCents: 5000, netPaidCents: 24800, unitCostCents: 3500, productCostCents: 10500, contributionMarginCents: 14300, viewToCartRate: 1, viewToPaidRate: 2, refundRate: 0.5 });
  const commerceAudit = await client.query("select event_type from audit_events where resource_type = 'commerce_event' order by occurred_at");
  assert.deepEqual(commerceAudit.rows.map((row) => row.event_type), ["commerce_event.order_paid", "commerce_event.order_paid", "commerce_event.refund"]);

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
      RUNTIME_TELEMETRY_MAX_AGE_SECONDS: "60",
      USAGE_METER_POLL_MS: "10"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => (await client.query("select state from live_runs where id = $1", [staleRunId])).rows[0]?.state === "DEGRADED", 10_000, "stale telemetry watchdog");
  await waitFor(async () => Number((await client.query("select count(*) as count from usage_records where live_run_id = $1 and code = 'monthly_live_minutes'", [recoverRunId])).rows[0]?.count) >= 1, 10_000, "live-minute metering");
  const alert = await client.query("select code, status from runtime_alerts where live_run_id = $1 and code = 'runtime_telemetry_stale'", [staleRunId]);
  assert.deepEqual(alert.rows[0], { code: "runtime_telemetry_stale", status: "open" });
  const alertId = (await client.query("select id from runtime_alerts where live_run_id = $1 and code = 'runtime_telemetry_stale'", [staleRunId])).rows[0].id;
  const notifierPort = await availablePort();
  const notifierSigningSecret = "control-plane-integration-notifier-signing-secret";
  notifierProcess = spawn(process.execPath, [alertNotifier], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ALERT_NOTIFIER_PORT: String(notifierPort),
      ALERT_NOTIFIER_POLL_MS: "20",
      ALERT_NOTIFIER_ALLOW_INSECURE_HTTP: "true",
      ALERT_NOTIFIER_TARGETS: JSON.stringify([{ id: "integration-critical", tenantId, webhookUrl: `${mock.baseUrl}/alert-webhook`, signingSecret: notifierSigningSecret, minimumSeverity: "critical" }])
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${notifierPort}/healthz`)).ok, 10_000, "alert notifier startup");
  await waitFor(() => mock.alertNotifications.length === 1, 10_000, "runtime alert webhook delivery");
  assert.equal(mock.alertNotifications[0].payload.alert.id, alertId);
  assert.equal(mock.alertNotifications[0].payload.alert.code, "runtime_telemetry_stale");
  const notificationDelivery = await client.query("select state, attempts from alert_notification_deliveries where runtime_alert_id = $1", [alertId]);
  assert.deepEqual(notificationDelivery.rows[0], { state: "delivered", attempts: 1 });
  const incidentOpen = await fetch(`http://127.0.0.1:${consolePort}/api/v1/incidents`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ alertId }) });
  assert.equal(incidentOpen.status, 201, "operator should be able to create an incident from a runtime alert");
  const incidentPayload = await incidentOpen.json();
  const incidentId = incidentPayload.data.incident.id;
  const duplicateIncident = await fetch(`http://127.0.0.1:${consolePort}/api/v1/incidents`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ alertId }) });
  assert.equal(duplicateIncident.status, 200, "one runtime alert must map to a single incident");
  const foreignResolve = await fetch(`http://127.0.0.1:${consolePort}/api/v1/incidents/${incidentId}/resolve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${operatorToken}` }, body: JSON.stringify({ resolution: "非责任人不应当能够关闭其他场控的事故单。" }) });
  assert.equal(foreignResolve.status, 403, "a non-owner operator must not resolve another operator's incident");
  const incidentResolve = await fetch(`http://127.0.0.1:${consolePort}/api/v1/incidents/${incidentId}/resolve`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ resolution: "切换备用节目后，已核验输出恢复并完成值班复核。" }) });
  assert.equal(incidentResolve.status, 200, "operator should record a resolution before closing an incident");
  const incidentRow = await client.query("select status, resolution, resolved_by from incidents where id = $1", [incidentId]);
  assert.equal(incidentRow.rows[0].status, "resolved");
  assert.ok(incidentRow.rows[0].resolution);
  assert.ok(incidentRow.rows[0].resolved_by);
  const incidentAudit = await client.query("select event_type from audit_events where resource_key = $1 order by occurred_at", [incidentId]);
  assert.deepEqual(incidentAudit.rows.map((row) => row.event_type), ["incident.opened", "incident.resolved"]);
  const acknowledgement = await fetch(`http://127.0.0.1:${consolePort}/api/v1/alerts/${alertId}/acknowledge`, { method: "POST", headers: requestHeaders });
  assert.equal(acknowledgement.status, 200, "operator should be able to acknowledge an open runtime alert");
  const acknowledgedAlert = await client.query("select acknowledged_at, acknowledged_by from runtime_alerts where id = $1", [alertId]);
  assert.ok(acknowledgedAlert.rows[0].acknowledged_at);
  assert.ok(acknowledgedAlert.rows[0].acknowledged_by);
  const acknowledgementAudit = await client.query("select event_type from audit_events where resource_key = $1 and event_type = 'runtime_alert.acknowledged'", [alertId]);
  assert.equal(acknowledgementAudit.rows.length, 1);
  const revokedProfile = await fetch(`http://127.0.0.1:${consolePort}/api/v1/policy/profiles/${recoverRun.policyProfileId}/revoke`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ reason: "Integration revocation must fail closed for a bound live run." }) });
  assert.equal(revokedProfile.status, 200, "an approved policy profile should be revocable with a recorded reason");
  const revokedProfileBody = await revokedProfile.json();
  assert.ok(revokedProfileBody.data.approvedAt, "revocation must retain the original approval timestamp");
  assert.ok(revokedProfileBody.data.revokedAt, "revocation must record when the profile was withdrawn");
  const revokedPreflight = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/preflight`, { headers: requestHeaders });
  assert.equal(revokedPreflight.status, 200);
  const revokedPreflightBody = await revokedPreflight.json();
  assert.equal(revokedPreflightBody.data.checks.find((check) => check.id === "policy_profile")?.status, "blocked", "a revoked frozen policy profile must block preflight");
  const interactionAfterRevocation = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/interactions`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ question: "撤销后不应继续自动问答", evidenceIds: ["product_version"] }) });
  assert.equal(interactionAfterRevocation.status, 409, "a revoked frozen policy profile must fail closed for new interactions");
  const revokedRelease = await fetch(`http://127.0.0.1:${consolePort}/api/v1/releases/${recoverRun.modelReleaseIds.voice}/revoke`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ reason: "Integration test withdraws a frozen voice release after a safety finding." }) });
  assert.equal(revokedRelease.status, 200, "an approved model release should be revocable with a recorded reason");
  const revokedReleaseBody = await revokedRelease.json();
  assert.ok(revokedReleaseBody.data.approvedAt, "model release revocation must retain the original approval timestamp");
  assert.ok(revokedReleaseBody.data.revokedAt, "model release revocation must record when the release was withdrawn");
  const modelRevokedPreflight = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/preflight`, { headers: requestHeaders });
  assert.equal(modelRevokedPreflight.status, 200);
  const modelRevokedPreflightBody = await modelRevokedPreflight.json();
  assert.equal(modelRevokedPreflightBody.data.checks.find((check) => check.id === "model_release")?.status, "blocked", "a revoked frozen model release must block preflight");
  await client.query("update live_runs set state = 'DEGRADED' where id = $1", [recoverRunId]);
  const recoveryAfterReleaseRevocation = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: randomUUID() }) });
  assert.equal(recoveryAfterReleaseRevocation.status, 409, "a revoked frozen model release must block recovery");
  const modelReleaseAudit = await client.query("select event_type from audit_events where resource_key = $1 and event_type = 'model_release.revoked'", [recoverRun.modelReleaseIds.voice]);
  assert.equal(modelReleaseAudit.rows.length, 1, "model release revocation must be audited");
  const revokedAsset = await fetch(`http://127.0.0.1:${consolePort}/api/v1/assets/${recoverRun.mediaAssetIds.voice}/revoke`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ reason: "Integration test withdraws the frozen voice authorization." }) });
  assert.equal(revokedAsset.status, 200, "an approved media asset should be revocable with a recorded reason");
  const revokedAssetBody = await revokedAsset.json();
  assert.ok(revokedAssetBody.data.approvedAt, "media asset revocation must retain the original approval timestamp");
  assert.ok(revokedAssetBody.data.revokedAt, "media asset revocation must record when the asset was withdrawn");
  const assetRevokedPreflight = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/preflight`, { headers: requestHeaders });
  assert.equal(assetRevokedPreflight.status, 200);
  const assetRevokedPreflightBody = await assetRevokedPreflight.json();
  assert.equal(assetRevokedPreflightBody.data.checks.find((check) => check.id === "rights")?.status, "blocked", "a revoked frozen media asset must block preflight");
  const mediaAssetAudit = await client.query("select event_type from audit_events where resource_key = $1 and event_type = 'media_asset.revoked'", [recoverRun.mediaAssetIds.voice]);
  assert.equal(mediaAssetAudit.rows.length, 1, "media asset revocation must be audited");
  const auditExport = await fetch(`http://127.0.0.1:${consolePort}/api/v1/audit-events/export`, { headers: requestHeaders });
  assert.equal(auditExport.status, 200, "authorized reviewers should export tenant audit evidence");
  assert.match(auditExport.headers.get("content-disposition") ?? "", /attachment; filename="shuzhiren-audit-evidence-/);
  const auditExportBody = await auditExport.json();
  assert.equal(auditExportBody.chain.verified, true, "export must include a verified audit chain result");
  assert.equal(auditExportBody.events.some((event) => event.type === "audit.exported" && typeof event.eventHash === "string" && event.eventHash.length === 64), true, "audit evidence export must record and include its own sealed access event");
  const auditChain = await client.query("select verified, sealed_events, legacy_events from verify_audit_chain($1::uuid)", [tenantId]);
  assert.equal(auditChain.rows[0].verified, true, "new audit events must form a valid tenant hash chain");
  assert.ok(Number(auditChain.rows[0].sealed_events) > 0);
  assert.equal(Number(auditChain.rows[0].legacy_events), 0);
  const audit = await client.query("select event_type from audit_events where resource_key = $1 and event_type = 'runtime_guard.degraded'", [staleRunId]);
  assert.equal(audit.rows.length, 1);
  const fallback = await client.query("select state, payload #>> '{command,type}' as action from outbox_events where aggregate_id = $1 order by created_at desc limit 1", [staleRunId]);
  assert.deepEqual(fallback.rows[0], { state: "delivered", action: "switch_to_fallback" });
  console.log("PASS  PostgreSQL control plane isolates tenant reads and service credentials, rejects stale product facts, evaluates sampling quality SLOs, revokes frozen model releases and media rights fail-closed, ingests idempotent reviewable PIM facts, enforces entitlements, meters live minutes, gates recovery, records idempotent commerce facts, durably notifies, tracks incidents, acknowledges runtime alerts, and degrades stale LIVE telemetry");
} finally {
  await stop(notifierProcess);
  await stop(workerProcess);
  await stop(adapterProcess);
  await stop(next);
  if (mock) await new Promise((resolve) => mock.server.close(resolve));
  await client.end();
}

async function seedRun(state, sessionId, sampledAt) {
  const showId = randomUUID();
  const revisionId = randomUUID();
  const policyProfileId = randomUUID();
  const runId = randomUUID();
  const channelId = randomUUID();
  const modelReleaseIds = { runtime: randomUUID(), lip_sync: randomUUID(), voice: randomUUID() };
  const mediaAssetIds = { portrait: randomUUID(), voice: randomUUID(), product_clip: randomUUID(), music: randomUUID() };
  await client.query("insert into tenants (id, slug, name) values ($1, $2, $3) on conflict (id) do nothing", [tenantId, `integration-${tenantId}`, "Control plane integration"]);
  await client.query("insert into shows (id, tenant_id, name) values ($1, $2, $3)", [showId, tenantId, `Integration show ${runId}`]);
  await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 1, '{}'::jsonb, 'approved')", [revisionId, tenantId, showId]);
  for (const [component, releaseId] of Object.entries(modelReleaseIds)) {
    await client.query("insert into model_releases (id, tenant_id, name, version, component, source_commit, image_digest, artifact_hash, driver_version, license, rights_scope, evidence_ref, validation_summary, approval_status, approved_at) values ($1, $2, $3, 'integration', $4::model_release_component, 'integration-commit', 'sha256:integration-image', 'sha256:integration-artifact', 'NVIDIA integration', 'Apache-2.0', 'Integration validation only', 'evidence://integration/model-release', 'Integration-bound approved release.', 'approved', now())", [releaseId, tenantId, `Integration ${component}`, component]);
    await client.query("insert into show_revision_model_releases (tenant_id, show_revision_id, model_release_id, component) values ($1, $2, $3, $4::model_release_component)", [tenantId, revisionId, releaseId, component]);
  }
  for (const [kind, assetId] of Object.entries(mediaAssetIds)) {
    await client.query("insert into media_assets (id, tenant_id, kind, name, object_key, checksum, rights_scope, source_ref, approval_status, approved_at) values ($1, $2, $3::media_asset_kind, $4, $5, $6, 'Integration approved rights', 'evidence://integration/media-asset', 'approved', now())", [assetId, tenantId, kind, `Integration ${kind}`, `assets/${tenantId}/${kind}`, `sha256:${kind}`]);
    await client.query("insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) values ($1, $2, $3, $4::media_asset_kind)", [tenantId, revisionId, assetId, kind]);
  }
  const profileRules = [{ id: "integration_block_term", terms: ["集成策略禁播词"], reason: "集成策略包禁止该类提问", action: "refuse", riskLevel: "high", requiredEvidence: [] }];
  await client.query("insert into policy_profiles (id, tenant_id, name, version, rules, evidence_ref, validation_summary, approval_status, approved_at) values ($1, $2, $3, '1.0.0', $4::jsonb, 'evidence://integration/seed', 'Seeded binding for integration validation.', 'approved', now())", [policyProfileId, tenantId, `Integration policy ${runId}`, JSON.stringify(profileRules)]);
  await client.query("insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) values ($1, $2, $3)", [tenantId, revisionId, policyProfileId]);
  const capabilities = { channel: "integration-webhook", supportsRtmp: true, supportsSrt: false, supportsComments: true, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: true };
  await client.query("insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at) values ($1, $2, $3, 'normalized-webhook-rtmp', 'connected', 'rtmp', 'secret://integration/channel', $4::jsonb, now())", [channelId, tenantId, `Integration channel ${runId}`, JSON.stringify(capabilities)]);
  await client.query("insert into live_runs (id, tenant_id, show_revision_id, state, trace_id, runtime_session_id, channel_connection_id) values ($1, $2, $3, $4::live_run_state, $5, $6, $7)", [runId, tenantId, revisionId, state, `trace_${runId}`, sessionId, channelId]);
  await client.query("insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, fallback_ready, sampled_at) values ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, $3)", [tenantId, runId, sampledAt]);
  return { runId, channelId, policyProfileId, modelReleaseIds, mediaAssetIds };
}

async function startMockServer() {
  const mediaCommands = [];
  const alertNotifications = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/jwks") return json(response, 200, { keys: [jwk] });
    if (url.pathname === "/v1/media" && request.method === "POST") {
      assert.equal(request.headers.authorization, `Bearer ${gatewayToken}`);
      mediaCommands.push(await requestBody(request));
      return json(response, 200, { accepted: true });
    }
    if (url.pathname === "/alert-webhook" && request.method === "POST") {
      const raw = await requestRawBody(request);
      const timestamp = request.headers["x-shuzhiren-timestamp"];
      const signature = request.headers["x-shuzhiren-signature"];
      const expected = `sha256=${createHmac("sha256", "control-plane-integration-notifier-signing-secret").update(`${timestamp}.${raw}`).digest("hex")}`;
      assert.equal(signature, expected);
      alertNotifications.push({ payload: JSON.parse(raw), eventId: request.headers["x-shuzhiren-event-id"] });
      return json(response, 204, {});
    }
    return json(response, 404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind a TCP port");
  return { server, mediaCommands, alertNotifications, baseUrl: `http://127.0.0.1:${address.port}` };
}

function json(response, status, value) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
async function requestRawBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }
async function requestBody(request) { return JSON.parse(await requestRawBody(request)); }
async function availablePort() { const server = http.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); await new Promise((resolve) => server.close(resolve)); if (!address || typeof address === "string") throw new Error("could not reserve a TCP port"); return address.port; }
async function waitFor(predicate, timeoutMs, label) { const deadline = Date.now() + timeoutMs; let lastError; while (Date.now() < deadline) { try { if (await predicate()) return; } catch (error) { lastError = error; } await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`); }
async function stop(child) { if (!child || child.exitCode !== null) return; child.kill("SIGTERM"); await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
