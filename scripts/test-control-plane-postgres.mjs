import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
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
const mediaEvidenceToken = "control-plane-integration-media-evidence-token";
const recordingEvidenceToken = "control-plane-integration-recording-evidence-token";
const channelEvidenceToken = "control-plane-integration-channel-evidence-token";
const telemetryToken = "control-plane-integration-telemetry-token";
const programOutputToken = "control-plane-integration-program-output-token";
const interactionToken = "control-plane-integration-interaction-token";
const commerceToken = "control-plane-integration-commerce-token";
const settlementToken = "control-plane-integration-settlement-token";
const recordingToken = "control-plane-integration-recording-token";
const pimToken = "control-plane-integration-pim-token";
const isolatedPimToken = "control-plane-integration-isolated-pim-token";
const outputVerifier = generateKeyPairSync("ed25519");
const outputVerifierPublicKey = outputVerifier.publicKey.export({ type: "spki", format: "pem" });
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
  // The seeding client above may be a superuser, and superusers bypass RLS.
  // Production application accounts must not bypass RLS (DEPLOYMENT_RUNBOOK),
  // so the console and runtime services under test connect as a login role
  // that has ordinary DML privileges but no SUPERUSER or BYPASSRLS.
  const appDatabaseUrl = await provisionApplicationRole();
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
  const analystToken = await new SignJWT({ tenant_id: tenantId, role: "analyst", name: "Integration Analyst" })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key" })
    .setSubject("integration-analyst")
    .setIssuer(issuer)
    .setAudience("shuzhiren-integration")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const forgedRoleToken = await new SignJWT({ tenant_id: tenantId, role: "admin", name: "Integration Analyst" })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key" })
    .setSubject("integration-analyst")
    .setIssuer(issuer)
    .setAudience("shuzhiren-integration")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const suspendedToken = await new SignJWT({ tenant_id: tenantId, role: "operator", name: "Suspended Integration Operator" })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key" })
    .setSubject("integration-suspended-operator")
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
  const archivableRun = await seedRun("ENDED", "session_archivable", new Date());
  await client.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [isolatedTenantId, `isolated-${isolatedTenantId}`, "Isolated integration tenant"]);
  await seedMembership(tenantId, "integration-operator", "Integration Admin", "admin");
  await seedMembership(tenantId, "integration-second-operator", "Integration Operator", "operator");
  await seedMembership(tenantId, "integration-analyst", "Integration Analyst", "analyst");
  await seedMembership(isolatedTenantId, "isolated-operator", "Isolated Tenant Admin", "admin");
  const programTransitionRun = await seedProgramTransitionRun();
  const scheduledProgramRun = await seedProgramTransitionRun({ state: "ARMED", scheduledAt: new Date(Date.now() - 60_000) });
  const recoverRunId = recoverRun.runId;
  const staleRunId = staleRun.runId;
  next = spawn(process.execPath, [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(consolePort)], {
    cwd: consoleRoot,
    env: {
      ...process.env,
      DATABASE_URL: appDatabaseUrl,
      CONTROL_PLANE_DEMO_MODE: "false",
      RELEASE_REVISION: "abc1234",
      RUNTIME_GATEWAY_URL: mock.baseUrl,
      RUNTIME_SHARED_TOKEN: gatewayToken,
      RUNTIME_GATEWAY_DEMO_MODE: "false",
      RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS: "20000",
      MEDIA_EVIDENCE_VERIFIER_URL: mock.baseUrl,
      MEDIA_EVIDENCE_VERIFIER_TOKEN: mediaEvidenceToken,
      MEDIA_EVIDENCE_VERIFIER_TIMEOUT_MS: "5000",
      RECORDING_EVIDENCE_VERIFIER_URL: mock.baseUrl,
      RECORDING_EVIDENCE_VERIFIER_TOKEN: recordingEvidenceToken,
      RECORDING_EVIDENCE_VERIFIER_TIMEOUT_MS: "5000",
      CHANNEL_EVIDENCE_VERIFIER_URL: mock.baseUrl,
      CHANNEL_EVIDENCE_VERIFIER_TOKEN: channelEvidenceToken,
      CHANNEL_EVIDENCE_VERIFIER_TIMEOUT_MS: "5000",
      OUTBOX_MAX_ATTEMPTS: "1",
      OIDC_ISSUER_URL: issuer,
      OIDC_AUDIENCE: "shuzhiren-integration",
      OIDC_JWKS_URL: `${mock.baseUrl}/jwks`,
      RUNTIME_TELEMETRY_TENANT_TOKENS: JSON.stringify({ [tenantId]: telemetryToken }),
      PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS: JSON.stringify({ [tenantId]: programOutputToken }),
      PROGRAM_OUTPUT_VERIFIER_TRUST: JSON.stringify({ [tenantId]: { issuer: "watermark_verifier", keys: { "integration-2026": outputVerifierPublicKey } } }),
      CHANNEL_INGEST_TENANT_TOKENS: JSON.stringify({ [tenantId]: interactionToken }),
      CHANNEL_COMMERCE_TENANT_TOKENS: JSON.stringify({ [tenantId]: commerceToken }),
      SETTLEMENT_INGEST_TENANT_TOKENS: JSON.stringify({ [tenantId]: settlementToken }),
      RUNTIME_RECORDING_TENANT_TOKENS: JSON.stringify({ [tenantId]: recordingToken }),
      PIM_INGEST_TENANT_TOKENS: JSON.stringify({ [tenantId]: pimToken, [isolatedTenantId]: isolatedPimToken })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${consolePort}/api/health`)).ok, 20_000, "control plane startup");
  const consoleHealth = await fetch(`http://127.0.0.1:${consolePort}/api/health`);
  assert.equal(consoleHealth.status, 200, "a configured production control plane must report ready");
  assert.match(consoleHealth.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, "control plane responses must prevent framing");
  assert.equal(consoleHealth.headers.get("x-frame-options"), "DENY", "control plane responses must deny framing");
  assert.equal(consoleHealth.headers.get("x-content-type-options"), "nosniff", "control plane responses must disable MIME sniffing");
  assert.equal(consoleHealth.headers.get("referrer-policy"), "no-referrer", "control plane responses must not disclose referrers");
  const consoleHealthBody = await consoleHealth.json();
  assert.equal(consoleHealthBody.dependencies.controlPlane, "ok", "the control-plane health endpoint must verify PostgreSQL instead of returning a static success response");
  assert.equal(consoleHealthBody.dependencies.authentication, "oidc", "the control-plane health endpoint must verify production OIDC configuration");
  assert.equal(consoleHealthBody.releaseRevision, "abc1234", "the control-plane health endpoint must expose the immutable deployed source revision");
  const anonymousPage = await fetch(`http://127.0.0.1:${consolePort}/`);
  assert.equal(anonymousPage.status, 401, "production console pages must reject anonymous requests before server rendering");
  const authenticatedPage = await fetch(`http://127.0.0.1:${consolePort}/`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(authenticatedPage.status, 200, "a valid production operator token must render the console page");

  const requestHeaders = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const operatorRequestHeaders = { "content-type": "application/json", authorization: `Bearer ${operatorToken}` };
  const analystRequestHeaders = { "content-type": "application/json", authorization: `Bearer ${analystToken}` };
  const isolatedRequestHeaders = { authorization: `Bearer ${isolatedToken}` };
  const forgedRoleRequestHeaders = { "content-type": "application/json", authorization: `Bearer ${forgedRoleToken}` };
  const suspendedRequestHeaders = { authorization: `Bearer ${suspendedToken}` };
  const programInsert = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${programTransitionRun.runId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "INSERT_PROGRAM", expectedState: "LIVE", programSegmentId: programTransitionRun.insertSegmentId, idempotencyKey: randomUUID() }) });
  assert.equal(programInsert.status, 202, "a frozen approved program segment should enter the media outbox");
  const programInsertBody = await programInsert.json();
  assert.equal(programInsertBody.data.command.programSegmentId, programTransitionRun.insertSegmentId, "the accepted command must retain its frozen insertion segment");
  const pendingProgramInsert = await client.query("select active_program_segment_id, active_insert_source_segment_id, active_insert_program_segment_id, pending_program_transition_event_id from live_runs where id = $1", [programTransitionRun.runId]);
  assert.deepEqual(pendingProgramInsert.rows[0], { active_program_segment_id: programTransitionRun.primarySegmentId, active_insert_source_segment_id: null, active_insert_program_segment_id: null, pending_program_transition_event_id: programInsertBody.data.mediaEvent.id }, "program cursor must not move before a bound gateway receipt");
  const concurrentProgramInsert = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${programTransitionRun.runId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "INSERT_PROGRAM", expectedState: "LIVE", programSegmentId: programTransitionRun.insertSegmentId, idempotencyKey: randomUUID() }) });
  assert.equal(concurrentProgramInsert.status, 409, "a pending program transition must reject a concurrent insertion");
  const unsafeChannelVerification = await fetch(`http://127.0.0.1:${consolePort}/api/v1/channels/connections/${recoverRun.channelId}/verify`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ status: "connected", evidenceRef: "https://operator:secret@evidence.internal/report" }) });
  assert.equal(unsafeChannelVerification.status, 400, "channel verification must reject credential-bearing or non-opaque evidence references");
  const governedChannelVerification = await fetch(`http://127.0.0.1:${consolePort}/api/v1/channels/connections/${recoverRun.channelId}/verify`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ status: "connected" }) });
  assert.equal(governedChannelVerification.status, 200, "channel verification must require a private verifier attestation rather than operator-provided evidence");
  const governedChannelAudit = await client.query("select detail from audit_events where event_type = 'channel_connection.verified' and resource_key = $1 order by chain_sequence desc limit 1", [recoverRun.channelId]);
  assert.match(governedChannelAudit.rows[0].detail.evidenceRef, /^evidence:\/\/integration\/channel\//, "channel verification and its immutable audit event must share verifier-issued evidence");
  const scopeArtifacts = await seedRunScopeArtifacts(recoverRunId, staleRunId);
  const verifiedAssetCreate = await fetch(`http://127.0.0.1:${consolePort}/api/v1/assets`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ kind: "music", name: "Integration verified music", rightsScope: "Integration test only", source: "evidence://integration/new-media", objectKey: `assets/${tenantId}/verified-music.mp3`, checksum: `sha256:${"c".repeat(64)}` }) });
  assert.equal(verifiedAssetCreate.status, 201, "a media asset must be registered only after private content verification");
  const verifiedAsset = await verifiedAssetCreate.json();
  assert.equal(verifiedAsset.data.contentVerification.contentType, "audio/mpeg", "media asset registration must retain the verifier content type");
  const verifiedAssetApproval = await fetch(`http://127.0.0.1:${consolePort}/api/v1/assets/${verifiedAsset.data.id}/approve`, { method: "POST", headers: requestHeaders });
  assert.equal(verifiedAssetApproval.status, 200, "media asset approval must repeat private content verification");
  assert.equal((await verifiedAssetApproval.json()).data.contentVerification.objectVersion, "integration-version-1", "media asset approval must retain the version-bound verification evidence");
  const forgedRoleEntitlement = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements/max_concurrent_live_runs`, { method: "PUT", headers: forgedRoleRequestHeaders, body: JSON.stringify({ limitValue: 1 }) });
  assert.equal(forgedRoleEntitlement.status, 403, "a JWT role claim must not elevate an analyst database membership");
  const memberDirectory = await fetch(`http://127.0.0.1:${consolePort}/api/v1/memberships`, { headers: requestHeaders });
  assert.equal(memberDirectory.status, 200, "an admin should list tenant memberships");
  const memberDirectoryPayload = await memberDirectory.json();
  assert.equal(memberDirectoryPayload.data.length, 4, "the membership directory must expose seeded tenant members only");
  const operatorMembership = memberDirectoryPayload.data.find((member) => member.externalSubject === "integration-second-operator");
  assert.ok(operatorMembership, "the seeded operator membership must be available for resource-scope tests");
  const restrictOperator = await fetch(`http://127.0.0.1:${consolePort}/api/v1/memberships/${operatorMembership.id}`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ accessScope: "restricted", resourceScopes: [{ resourceType: "live_run", resourceId: recoverRunId }] }) });
  assert.equal(restrictOperator.status, 200, "an admin should restrict an operator to an explicit live run");
  const scopedRuns = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs`, { headers: operatorRequestHeaders });
  assert.deepEqual((await scopedRuns.json()).data.map((run) => run.id), [recoverRunId], "a restricted operator must list only assigned live runs");
  const scopedForeignRun = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${staleRunId}`, { headers: operatorRequestHeaders });
  assert.equal(scopedForeignRun.status, 404, "a restricted operator must not read an unassigned live run");
  const scopedChannels = await fetch(`http://127.0.0.1:${consolePort}/api/v1/channels/connections`, { headers: operatorRequestHeaders });
  assert.deepEqual((await scopedChannels.json()).data, [], "a direct live-run scope must not grant tenant channel administration");
  const scopedAlerts = await fetch(`http://127.0.0.1:${consolePort}/api/v1/alerts`, { headers: operatorRequestHeaders });
  assert.deepEqual((await scopedAlerts.json()).data.map((alert) => alert.id), [scopeArtifacts.recoverAlertId], "a restricted operator must list alerts only for assigned live runs");
  const scopedIncidents = await fetch(`http://127.0.0.1:${consolePort}/api/v1/incidents`, { headers: operatorRequestHeaders });
  assert.deepEqual((await scopedIncidents.json()).data.map((incident) => incident.id), [scopeArtifacts.recoverIncidentId], "a restricted operator must list incidents only for assigned live runs");
  const scopedRecordings = await fetch(`http://127.0.0.1:${consolePort}/api/v1/recordings`, { headers: operatorRequestHeaders });
  assert.deepEqual((await scopedRecordings.json()).data.map((recording) => recording.id), [scopeArtifacts.recoverRecordingId], "a restricted operator must list recording evidence only for assigned live runs");
  const scopedOutbox = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox`, { headers: operatorRequestHeaders });
  assert.deepEqual((await scopedOutbox.json()).data.map((event) => event.id), [scopeArtifacts.recoverOutboxEventId], "a restricted operator must list runtime outbox events only for assigned live runs");
  const scopedPreview = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/preview`, { headers: operatorRequestHeaders });
  assert.equal(scopedPreview.status, 200, "a restricted operator must request a controlled preview for an assigned live run");
  const scopedPreviewPayload = await scopedPreview.json();
  assert.equal(scopedPreviewPayload.data.available, true, "an assigned live run preview must return an authorized short-lived grant");
  const scopedForeignPreview = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${staleRunId}/preview`, { headers: operatorRequestHeaders });
  assert.equal(scopedForeignPreview.status, 404, "a restricted operator must not request a preview for an unassigned live run");
  const previewAudit = await client.query("select detail from audit_events where event_type = 'runtime_preview.requested' and resource_key = $1 order by occurred_at desc limit 1", [recoverRunId]);
  assert.equal(previewAudit.rows[0].detail.url, undefined, "preview audit evidence must never retain the temporary viewer URL");
  const scopedForeignAlertAcknowledgement = await fetch(`http://127.0.0.1:${consolePort}/api/v1/alerts/${scopeArtifacts.staleAlertId}/acknowledge`, { method: "POST", headers: operatorRequestHeaders });
  assert.equal(scopedForeignAlertAcknowledgement.status, 404, "a restricted operator must not acknowledge an unassigned live-run alert");
  const scopedForeignIncidentCreation = await fetch(`http://127.0.0.1:${consolePort}/api/v1/incidents`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ alertId: scopeArtifacts.staleAlertId }) });
  assert.equal(scopedForeignIncidentCreation.status, 404, "a restricted operator must not create an incident from an unassigned live-run alert");
  const scopedForeignIncidentResolution = await fetch(`http://127.0.0.1:${consolePort}/api/v1/incidents/${scopeArtifacts.staleIncidentId}/resolve`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ resolution: "This resolution must not reach an unassigned incident." }) });
  assert.equal(scopedForeignIncidentResolution.status, 404, "a restricted operator must not resolve an unassigned live-run incident");
  const scopedForeignOutboxRead = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${scopeArtifacts.staleOutboxEventId}`, { headers: operatorRequestHeaders });
  assert.equal(scopedForeignOutboxRead.status, 404, "a restricted operator must not read an unassigned live-run outbox event");
  const scopedForeignOutboxDelivery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${scopeArtifacts.staleOutboxEventId}/deliver`, { method: "POST", headers: operatorRequestHeaders });
  assert.equal(scopedForeignOutboxDelivery.status, 404, "a restricted operator must not deliver an unassigned live-run command");
  const scopedRunEvents = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/events`, { headers: operatorRequestHeaders });
  assert.equal(scopedRunEvents.status, 200, "a restricted operator must retain the evidence timeline for an assigned live run");
  const scopedProducts = await fetch(`http://127.0.0.1:${consolePort}/api/v1/products`, { headers: operatorRequestHeaders });
  assert.equal(scopedProducts.status, 403, "a restricted operator must not read the tenant product catalog");
  const scopedAssets = await fetch(`http://127.0.0.1:${consolePort}/api/v1/assets`, { headers: operatorRequestHeaders });
  assert.equal(scopedAssets.status, 403, "a restricted operator must not read the tenant media inventory");
  const scopedAudit = await fetch(`http://127.0.0.1:${consolePort}/api/v1/audit-events`, { headers: operatorRequestHeaders });
  assert.equal(scopedAudit.status, 403, "a restricted operator must not read the tenant audit ledger");
  const scopedRunCreation = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ showName: "Restricted creation must fail", channelConnectionId: recoverRun.channelId, productVersionId: randomUUID(), aiDisclosureEnabled: true }) });
  assert.equal(scopedRunCreation.status, 403, "a restricted operator must not create a tenant-wide live run");
  const restoreOperator = await fetch(`http://127.0.0.1:${consolePort}/api/v1/memberships/${operatorMembership.id}`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ accessScope: "tenant" }) });
  assert.equal(restoreOperator.status, 200, "an admin should restore tenant-wide access for later integration checks");
  const analystMemberDirectory = await fetch(`http://127.0.0.1:${consolePort}/api/v1/memberships`, { headers: analystRequestHeaders });
  assert.equal(analystMemberDirectory.status, 403, "only tenant admins may list memberships");
  const createdMembershipResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/memberships`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ externalSubject: "integration-suspended-operator", displayName: "Suspended Integration Operator", role: "operator" }) });
  assert.equal(createdMembershipResponse.status, 201, "an admin should provision an explicit tenant membership");
  const createdMembership = await createdMembershipResponse.json();
  const suspendMembershipResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/memberships/${createdMembership.data.id}`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ status: "suspended" }) });
  assert.equal(suspendMembershipResponse.status, 200, "an admin should suspend an operator membership");
  const suspendedRead = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs`, { headers: suspendedRequestHeaders });
  assert.equal(suspendedRead.status, 403, "a suspended membership must reject its otherwise valid JWT immediately");
  await assert.rejects(
    client.query("update memberships set status = 'suspended' where tenant_id = $1 and role = 'admin'", [tenantId]),
    /last active tenant admin/i,
    "the database must reject removal of the final active tenant admin"
  );
  const forgedMediaSession = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/media`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ runId: recoverRunId, sessionId: "another_livetalking_session", type: "switch_to_human" }) });
  assert.equal(forgedMediaSession.status, 400, "runtime media commands must reject caller-provided session IDs");
  const lifecycleBypass = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/media`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ runId: recoverRunId, type: "start_program" }) });
  assert.equal(lifecycleBypass.status, 400, "runtime media commands must reject start actions that bypass lifecycle gates");
  const foreignRunRead = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}`, { headers: isolatedRequestHeaders });
  assert.equal(foreignRunRead.status, 404, "one tenant must not read another tenant's live run");
  const analystArchive = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${archivableRun.runId}/lifecycle`, { method: "POST", headers: analystRequestHeaders, body: JSON.stringify({ action: "archive" }) });
  assert.equal(analystArchive.status, 403, "an analyst must not archive a completed live run");
  const archiveRun = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${archivableRun.runId}/lifecycle`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ action: "archive" }) });
  assert.equal(archiveRun.status, 200, "an operator should archive a completed live run");
  assert.equal((await archiveRun.json()).data.state, "ARCHIVED", "archiving must move an ended run to the terminal archived state");
  assert.equal((await client.query("select count(*) as count from audit_events where resource_id = $1 and event_type = 'live_run.archive'", [archivableRun.runId])).rows[0].count, "1", "archiving must be recorded in the audit chain");
  const archivedInteraction = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/channel-interactions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${interactionToken}` }, body: JSON.stringify({ tenantId, runId: archivableRun.runId, channelConnectionId: archivableRun.channelId, eventId: "archived-interaction", question: "归档场次不能接受评论" }) });
  assert.equal(archivedInteraction.status, 409, "archived runs must reject new channel interactions");
  const archivedCommerce = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/channel-commerce`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${commerceToken}` }, body: JSON.stringify({ tenantId, runId: archivableRun.runId, channelConnectionId: archivableRun.channelId, eventId: "archived-commerce", eventType: "view" }) });
  assert.equal(archivedCommerce.status, 409, "archived runs must reject new commerce events");
  const archivedTelemetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/telemetry`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${telemetryToken}` }, body: JSON.stringify({ tenantId, runId: archivableRun.runId, outputConnected: true, inferenceFps: 30, outputFps: 25, avSyncMs: 20, bitrateMbps: 4, gpuUtilization: 70, gpuMemoryMiB: 12000, audioActive: true, fallbackReady: true }) });
  assert.equal(archivedTelemetry.status, 409, "archived runs must reject fresh runtime telemetry that could reopen alerts");
  const invalidAsset = await fetch(`http://127.0.0.1:${consolePort}/api/v1/assets`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ kind: "voice", name: "Invalid asset", rightsScope: "test", source: "test", objectKey: "../outside.wav", checksum: "not-a-digest" }) });
  assert.equal(invalidAsset.status, 400, "media assets must reject unsafe object keys and invalid checksums");
  const invalidRelease = await fetch(`http://127.0.0.1:${consolePort}/api/v1/releases`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ component: "voice", name: "Invalid release", version: "1", sourceCommit: "not-a-commit", imageDigest: "sha256:bad", artifactHash: "sha256:bad", driverVersion: "570", license: "Apache-2.0", rightsScope: "test", evidenceRef: "evidence://integration/invalid", validationSummary: "should not be stored" }) });
  assert.equal(invalidRelease.status, 400, "model releases must reject invalid source and artifact digests");
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
  const inactiveRuntimeRun = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ showName: "Integration inactive runtime run", channelConnectionId: recoverRun.channelId, productVersionId: freshVersion.data.id, runtimeSessionId: "missing_session", aiDisclosureEnabled: true }) });
  assert.equal(inactiveRuntimeRun.status, 409, "creating a run must reject an inactive runtime session");
  const createdRunResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ showName: "Integration frozen rights run", channelConnectionId: recoverRun.channelId, productVersionId: freshVersion.data.id, runtimeSessionId: "session_frozen_rights", aiDisclosureEnabled: true }) });
  assert.equal(createdRunResponse.status, 201, "creating a production run should freeze currently approved media rights");
  const createdRun = await createdRunResponse.json();
  const initialProgramResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program`, { headers: requestHeaders });
  assert.equal(initialProgramResponse.status, 200, "operators should read a new draft program");
  const initialProgram = await initialProgramResponse.json();
  assert.equal(initialProgram.data.status, "draft", "a newly planned live run must start with a draft program revision");
  const invalidProgram = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ segments: initialProgram.data.segments.slice(0, 1).map(({ kind, title, durationSeconds, purpose }) => ({ kind, title, durationSeconds, purpose })) }) });
  assert.equal(invalidProgram.status, 409, "a program without fallback and human handoff must be rejected");
  const analystProgramWrite = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program`, { method: "PUT", headers: analystRequestHeaders, body: JSON.stringify({ segments: [] }) });
  assert.equal(analystProgramWrite.status, 403, "an analyst must not edit a draft program");
  const editedSegments = initialProgram.data.segments.map(({ kind, title, durationSeconds, purpose, runtimeScript }, index) => ({ kind, title: index === 0 ? "Integration edited opening" : title, durationSeconds, purpose, runtimeScript }));
  const savedProgram = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ segments: editedSegments }) });
  assert.equal(savedProgram.status, 200, "an operator should edit a draft program through the controlled API");
  assert.equal((await savedProgram.json()).data.segments[0].title, "Integration edited opening");
  const programSubmitReview = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/lifecycle`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "submit_review" }) });
  assert.equal(programSubmitReview.status, 200, "a valid draft program should enter review");
  const lockedProgramWrite = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ segments: editedSegments }) });
  assert.equal(lockedProgramWrite.status, 409, "reviewed program edits must be rejected by the API");
  await assert.rejects(client.query("update show_revision_segments set title = 'illegal mutation' where show_revision_id = (select show_revision_id from live_runs where id = $1) and position = 1", [createdRun.data.id]), /editable only in an attached DRAFT run/i, "reviewed program edits must be rejected by the database");
  const liveSessionRebind = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${staleRunId}/runtime-session`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ runtimeSessionId: "0" }) });
  assert.equal(liveSessionRebind.status, 409, "operators must not redirect a live run to another runtime session");
  const runtimeSessionBinding = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/runtime-session`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ runtimeSessionId: "0" }) });
  assert.equal(runtimeSessionBinding.status, 200, "a preflight-eligible runtime session binding must be verified against the gateway");
  assert.equal((await runtimeSessionBinding.json()).data.runtimeSessionId, "0");
  await client.query("insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, audio_active, fallback_ready, sampled_at) values ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, true, now())", [tenantId, createdRun.data.id]);
  const frozenRights = await client.query("select kind from show_revision_media_assets where show_revision_id = (select show_revision_id from live_runs where id = $1) order by kind", [createdRun.data.id]);
  assert.deepEqual(frozenRights.rows.map((row) => row.kind), ["portrait", "voice", "product_clip", "music"]);
  await assert.rejects(client.query("delete from show_revision_media_assets where show_revision_id = (select show_revision_id from live_runs where id = $1) and kind = 'voice'", [createdRun.data.id]), /Frozen show revision bindings are immutable/, "frozen revision bindings must reject direct mutation");
  await assert.rejects(client.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, (select show_revision_id from live_runs where id = $2), $3, 'secondary')", [tenantId, createdRun.data.id, staleVersion.data.id]), /Frozen show revision bindings are immutable/, "a live run's revision must reject added product bindings");
  const manifestResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/release-manifest`, { headers: requestHeaders });
  assert.equal(manifestResponse.status, 200, "operators should read a run's frozen release manifest");
  const manifest = await manifestResponse.json();
  assert.equal(manifest.data.product.id, freshVersion.data.id);
  assert.equal(manifest.data.product.facts.sourceRef, freshFacts.sourceRef, "release manifest must include the frozen product fact provenance");
  assert.equal(manifest.data.models.length, 3);
  assert.deepEqual(manifest.data.assets.map((asset) => asset.kind), ["portrait", "voice", "product_clip", "music"]);
  assert.match(manifest.data.sha256, /^[a-f0-9]{64}$/, "release manifest must include a reproducible SHA-256 evidence hash");
  assert.equal(manifest.data.frozenSha256, manifest.data.sha256, "new runs must seal their creation manifest hash");
  assert.equal(manifest.data.frozenSnapshotVerified, true, "the stored release manifest snapshot must verify against its hash");
  await assert.rejects(client.query("update show_revision_release_manifest_snapshots set manifest = '{}'::jsonb where show_revision_id = (select show_revision_id from live_runs where id = $1)", [createdRun.data.id]), /append-only/, "release manifest snapshots must reject direct mutation");
  const approveInitialProgram = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/lifecycle`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "approve" }) });
  assert.equal(approveInitialProgram.status, 200, "an approved program should advance its run to APPROVED");
  const revisionAnalystCreate = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program-revisions`, { method: "POST", headers: analystRequestHeaders });
  assert.equal(revisionAnalystCreate.status, 403, "an analyst must not create a candidate program revision");
  const revisionCreate = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program-revisions`, { method: "POST", headers: operatorRequestHeaders });
  assert.equal(revisionCreate.status, 201, "an operator should create a governed candidate program revision before arming");
  const revisionRequest = await revisionCreate.json();
  const sourceRevisionId = (await client.query("select show_revision_id from live_runs where id = $1", [createdRun.data.id])).rows[0].show_revision_id;
  await assert.rejects(client.query("update live_runs set show_revision_id = $2 where id = $1", [createdRun.data.id, revisionRequest.data.candidateRevisionId]), /must be an approved revision of the same show/i, "the database must reject an unapproved direct show revision rebind");
  const revisedSegments = revisionRequest.data.program.segments.map((segment, index) => ({ kind: segment.kind, title: index === 0 ? "Approved revision opening" : segment.title, durationSeconds: segment.durationSeconds, purpose: segment.purpose, runtimeScript: segment.runtimeScript }));
  const revisionEdit = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program-revisions/${revisionRequest.data.id}`, { method: "PUT", headers: operatorRequestHeaders, body: JSON.stringify({ segments: revisedSegments }) });
  assert.equal(revisionEdit.status, 200, "the requesting operator should edit its candidate program revision");
  const revisionSubmit = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program-revisions/${revisionRequest.data.id}/submit`, { method: "POST", headers: operatorRequestHeaders });
  assert.equal(revisionSubmit.status, 200, "the candidate program revision should enter reviewer approval");
  await assert.rejects(client.query("update show_revision_segments set title = 'illegal candidate mutation' where show_revision_id = $1", [revisionRequest.data.candidateRevisionId]), /editable only.*draft revision request/i, "submitted candidate program segments must be frozen by the database");
  await assert.rejects(client.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'illegal-candidate-binding')", [tenantId, revisionRequest.data.candidateRevisionId, staleVersion.data.id]), /Candidate show revision bindings are immutable/i, "candidate dependency bindings must be sealed after cloning");
  await assert.rejects(client.query("update show_program_change_requests set status = 'approved', approved_by = (select id from users where external_subject = 'integration-second-operator'), approved_at = now() where id = $1", [revisionRequest.data.id]), /transition is not permitted/i, "the database must reject a candidate creator approving its own request");
  const selfApproveRevision = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program-revisions/${revisionRequest.data.id}/approve`, { method: "POST", headers: operatorRequestHeaders });
  assert.equal(selfApproveRevision.status, 403, "an operator must not approve a candidate program revision");
  const revisionApprove = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program-revisions/${revisionRequest.data.id}/approve`, { method: "POST", headers: requestHeaders });
  assert.equal(revisionApprove.status, 200, "an independent reviewer should approve and apply a candidate program revision");
  assert.equal((await revisionApprove.json()).data.status, "applied", "approved candidate revision must be recorded as applied");
  const reboundRun = await client.query("select show_revision_id, state from live_runs where id = $1", [createdRun.data.id]);
  assert.equal(reboundRun.rows[0].show_revision_id, revisionRequest.data.candidateRevisionId, "approval must atomically rebind the live run to the candidate revision");
  assert.equal(reboundRun.rows[0].state, "APPROVED", "applying a program revision must return the run to approval before preflight");
  assert.notEqual(reboundRun.rows[0].show_revision_id, sourceRevisionId, "the original approved revision remains intact after rebind");
  const reboundManifest = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/release-manifest`, { headers: requestHeaders });
  assert.equal((await reboundManifest.json()).data.frozenSnapshotVerified, true, "the replacement revision must receive a sealed release manifest snapshot");
  for (const [action, expectedState] of [["begin_preflight", "PREFLIGHT"], ["arm", "ARMED"]]) {
    const lifecycleResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/lifecycle`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action }) });
    assert.equal(lifecycleResponse.status, 200, `lifecycle action ${action} should advance a fully governed run`);
    assert.equal((await lifecycleResponse.json()).data.state, expectedState, `lifecycle action ${action} should reach ${expectedState}`);
  }
  const revisionAfterArm = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${createdRun.data.id}/program-revisions`, { method: "POST", headers: operatorRequestHeaders });
  assert.equal(revisionAfterArm.status, 409, "armed runs must reject candidate program revision creation");
  const approvedProgram = await client.query("select approval_status, approved_by, approved_at from show_revisions where id = (select show_revision_id from live_runs where id = $1)", [createdRun.data.id]);
  assert.equal(approvedProgram.rows[0]?.approval_status, "approved", "approving a live run must approve its frozen program revision");
  assert.ok(approvedProgram.rows[0]?.approved_by && approvedProgram.rows[0]?.approved_at, "program approval must retain the approver identity and timestamp");
  const armAudit = await client.query("select event_type from audit_events where resource_id = $1 and event_type = 'live_run.arm'", [createdRun.data.id]);
  assert.equal(armAudit.rows.length, 1, "arming a preflight-ready run must leave an audit record");
  const competingRunResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ showName: "Integration competing runtime session run", channelConnectionId: recoverRun.channelId, productVersionId: freshVersion.data.id, runtimeSessionId: "0", aiDisclosureEnabled: true }) });
  assert.equal(competingRunResponse.status, 201, "a future draft may reference the same single-session runtime");
  const competingRun = await competingRunResponse.json();
  for (const action of ["submit_review", "approve"]) {
    const lifecycleResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${competingRun.data.id}/lifecycle`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action }) });
    assert.equal(lifecycleResponse.status, 200, `competing run action ${action} should remain valid before reserving the runtime session`);
  }
  const competingPreflight = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${competingRun.data.id}/lifecycle`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "begin_preflight" }) });
  assert.equal(competingPreflight.status, 409, "only one active run may reserve the same runtime session");
  const policyEvaluation = await fetch(`http://127.0.0.1:${consolePort}/api/v1/policy/evaluate`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ question: "这款敏感肌可以用吗？", evidenceIds: ["product_version"] }) });
  assert.equal(policyEvaluation.status, 200);
  const policyDecision = await policyEvaluation.json();
  assert.equal(policyDecision.data.action, "handoff");
  const oversizedPolicyEvaluation = await fetch(`http://127.0.0.1:${consolePort}/api/v1/policy/evaluate`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ question: "普通商品咨询".repeat(200), evidenceIds: ["product_version"] }) });
  assert.equal(oversizedPolicyEvaluation.status, 400, "policy evaluation must reject oversized input before it reaches an evaluator");
  const excessivePolicyBody = await fetch(`http://127.0.0.1:${consolePort}/api/v1/policy/evaluate`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ question: "普通商品咨询".repeat(4000), evidenceIds: ["product_version"] }) });
  assert.equal(excessivePolicyBody.status, 413, "policy evaluation must reject oversized request bodies before JSON parsing");
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
  const oversizedInteraction = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/interactions`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ question: "普通商品咨询".repeat(200), source: "integration", evidenceIds: ["product_version"] })
  });
  assert.equal(oversizedInteraction.status, 400, "live interaction intake must reject oversized content before persistence");
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

  const recoveryIdempotencyKey = randomUUID();
  const commandResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/commands`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: recoveryIdempotencyKey })
  });
  assert.equal(commandResponse.status, 202);
  const commandBody = await commandResponse.json();
  assert.equal(commandBody.data.run.state, "DEGRADED", "recovery must wait for runtime acknowledgement");
  const malformedRun = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/not-a-uuid`, { headers: requestHeaders });
  assert.equal(malformedRun.status, 404, "malformed live run IDs must not surface PostgreSQL UUID cast errors");
  const malformedAlertFilter = await fetch(`http://127.0.0.1:${consolePort}/api/v1/alerts?runId=not-a-uuid`, { headers: requestHeaders });
  assert.equal(malformedAlertFilter.status, 400, "malformed alert run filters must be rejected before PostgreSQL UUID casting");
  const eventId = commandBody.data.mediaEvent.id;
  const pending = await client.query("select state, scheduled_start_event_id from live_runs where id = $1", [recoverRunId]);
  assert.equal(pending.rows[0].state, "DEGRADED");
  assert.equal(pending.rows[0].scheduled_start_event_id, eventId);
  const pendingOutbox = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${eventId}`, { headers: requestHeaders });
  assert.equal(pendingOutbox.status, 200, "operators should read one pending outbox event without polling the whole queue");
  assert.equal((await pendingOutbox.json()).data.state, "pending");
  const sameCommandRetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: recoveryIdempotencyKey }) });
  assert.equal(sameCommandRetry.status, 200, "a command retry with identical content must return the original command");
  const conflictingCommandRetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "END", expectedState: "DEGRADED", idempotencyKey: recoveryIdempotencyKey }) });
  assert.equal(conflictingCommandRetry.status, 409, "a command idempotency key must reject a different action");
  const isolatedOutbox = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${eventId}`, { headers: isolatedRequestHeaders });
  assert.equal(isolatedOutbox.status, 404, "one tenant must not read another tenant's outbox event");
  const malformedOutbox = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/not-a-uuid`, { headers: requestHeaders });
  assert.equal(malformedOutbox.status, 404, "malformed outbox IDs must not surface PostgreSQL UUID cast errors");
  const malformedOutboxDelivery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/not-a-uuid/deliver`, { method: "POST", headers: requestHeaders });
  assert.equal(malformedOutboxDelivery.status, 404, "manual delivery must reject malformed outbox IDs without PostgreSQL UUID cast errors");

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
  const deliveredRecovery = await client.query("select state, scheduled_start_event_id from live_runs where id = $1", [recoverRunId]);
  assert.deepEqual(deliveredRecovery.rows[0], { state: "LIVE", scheduled_start_event_id: null }, "a confirmed activation must clear its temporary acknowledgement reservation");
  await client.query("update live_runs set state = 'DEGRADED', updated_at = now() where id = $1", [recoverRunId]);
  const secondRecovery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/commands`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: randomUUID() })
  });
  assert.equal(secondRecovery.status, 202, "a run that later degrades must be able to request a new recovery after its prior acknowledgement completed");
  const secondRecoveryBody = await secondRecovery.json();
  const secondDelivery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${secondRecoveryBody.data.mediaEvent.id}/deliver`, { method: "POST", headers: requestHeaders });
  assert.equal(secondDelivery.status, 202);
  await waitFor(async () => (await client.query("select state, scheduled_start_event_id from live_runs where id = $1", [recoverRunId])).rows[0]?.state === "LIVE" && (await client.query("select scheduled_start_event_id from live_runs where id = $1", [recoverRunId])).rows[0]?.scheduled_start_event_id === null, 5_000, "second recovery acknowledgement");
  assert.equal(mock.mediaCommands.length, 2, "a later recovery should dispatch one additional media command");
  const speechDispatch = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/speech-dispatches`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ question: "这款商品价格是多少？", idempotencyKey: randomUUID() }) });
  assert.equal(speechDispatch.status, 202, "a grounded speech request should be accepted for a live run");
  const speechBody = await speechDispatch.json();
  assert.equal(speechBody.data.status, "queued");
  assert.equal(speechBody.data.event.command.voice, "integration_approved_voice", "speech must use the runtime voice frozen with the run's approved voice asset");
  await client.query("insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, audio_active, fallback_ready, sampled_at) values ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, true, now() - interval '30 seconds'), ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, true, now() - interval '15 seconds')", [tenantId, recoverRunId]);
  const samplingSloResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/slo`, { headers: requestHeaders });
  assert.equal(samplingSloResponse.status, 200, "operators should read a run's sampling quality SLO");
  const samplingSlo = await samplingSloResponse.json();
  assert.equal(samplingSlo.data.status, "met");
  assert.equal(samplingSlo.data.sampleCount, 3);
  assert.equal(samplingSlo.data.healthRate, 1);

  const audioRun = await seedRun("LIVE", "session_audio_silence", new Date());
  const oversizedRuntimeTelemetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${telemetryToken}` },
    body: JSON.stringify({ tenantId, runId: audioRun.runId, padding: "x".repeat(20_000) })
  });
  assert.equal(oversizedRuntimeTelemetry.status, 413, "runtime telemetry must reject oversized request bodies before JSON parsing");
  const malformedRuntimeTelemetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${telemetryToken}` },
    body: JSON.stringify({ tenantId, runId: "not-a-uuid", outputConnected: true, inferenceFps: 30, outputFps: 25, avSyncMs: 20, bitrateMbps: 4, gpuUtilization: 70, gpuMemoryMiB: 12000, audioActive: true, fallbackReady: true })
  });
  assert.equal(malformedRuntimeTelemetry.status, 400, "runtime telemetry must reject malformed run IDs before PostgreSQL UUID casting");
  const malformedTimestampTelemetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${telemetryToken}` },
    body: JSON.stringify({ tenantId, runId: audioRun.runId, sampledAt: "not-a-timestamp", outputConnected: true, inferenceFps: 30, outputFps: 25, avSyncMs: 20, bitrateMbps: 4, gpuUtilization: 70, gpuMemoryMiB: 12000, audioActive: true, fallbackReady: true })
  });
  assert.equal(malformedTimestampTelemetry.status, 400, "runtime telemetry must reject invalid sample timestamps instead of rewriting them");
  const audioTelemetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${telemetryToken}` },
    body: JSON.stringify({ tenantId, runId: audioRun.runId, outputConnected: true, inferenceFps: 30, outputFps: 25, avSyncMs: 20, bitrateMbps: 4, gpuUtilization: 70, gpuMemoryMiB: 12000, audioActive: false, fallbackReady: true })
  });
  assert.equal(audioTelemetry.status, 202, "runtime telemetry should accept a verified silent-output sample");
  assert.equal((await audioTelemetry.json()).data.alerts.some((alert) => alert.code === "audio_silence" && alert.severity === "critical"), true, "silent output must open a critical alert");
  assert.equal((await client.query("select state from live_runs where id = $1", [audioRun.runId])).rows[0].state, "DEGRADED", "silent output must degrade the live run");
  assert.equal((await client.query("select status from runtime_alerts where live_run_id = $1 and code = 'audio_silence'", [audioRun.runId])).rows[0].status, "open");

  const endRun = await seedRun("LIVE", "session_confirmed_end", new Date());
  const endCommand = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${endRun.runId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "END", expectedState: "LIVE", idempotencyKey: randomUUID() }) });
  assert.equal(endCommand.status, 202, "end command should enter the outbox before changing the visible lifecycle state");
  const endBody = await endCommand.json();
  assert.equal(endBody.data.run.state, "LIVE", "the run must remain live until the runtime confirms stop");
  const pendingEnd = await client.query("select state, pending_media_event_id from live_runs where id = $1", [endRun.runId]);
  assert.deepEqual(pendingEnd.rows[0], { state: "LIVE", pending_media_event_id: endBody.data.mediaEvent.id });
  const duplicateEnd = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${endRun.runId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "END", expectedState: "LIVE", idempotencyKey: randomUUID() }) });
  assert.equal(duplicateEnd.status, 409, "a second end command must not race the pending stop acknowledgement");
  const endDelivery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${endBody.data.mediaEvent.id}/deliver`, { method: "POST", headers: requestHeaders });
  assert.equal(endDelivery.status, 202);
  await waitFor(async () => (await client.query("select state, pending_media_event_id from live_runs where id = $1", [endRun.runId])).rows[0]?.state === "ENDED", 5_000, "stop acknowledgement");
  const deliveredEnd = await client.query("select state, pending_media_event_id from live_runs where id = $1", [endRun.runId]);
  assert.deepEqual(deliveredEnd.rows[0], { state: "ENDED", pending_media_event_id: null }, "runtime stop acknowledgement must atomically end the run and release its pending reservation");
  assert.equal(mock.mediaCommands.at(-1)?.action, "stop_program");

  const manualFailureRun = await seedRun("LIVE", "session_manual_delivery_failure", new Date());
  const manualFailureEvent = await client.query(`insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
    values ($1, 'media.dispatch', 'live_run', $2, $3::jsonb) returning id`, [tenantId, manualFailureRun.runId, JSON.stringify({
      sessionId: "session_manual_delivery_failure",
      command: { id: `fail_media_${randomUUID()}`, runId: manualFailureRun.runId, type: "switch_to_human", issuedAt: new Date().toISOString(), traceId: `trace_${manualFailureRun.runId}`, payload: { controlAction: "MANUAL_OUTBOX_FAILURE_TEST" } }
    })]);
  const manualFailureDelivery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${manualFailureEvent.rows[0].id}/deliver`, { method: "POST", headers: requestHeaders });
  assert.equal(manualFailureDelivery.status, 503, "manual runtime delivery should surface gateway failure");
  const manualFailureAlert = await client.query("select severity, status from runtime_alerts where live_run_id = $1 and code = 'runtime_command_delivery_exhausted'", [manualFailureRun.runId]);
  assert.deepEqual(manualFailureAlert.rows[0], { severity: "critical", status: "open" }, "manual terminal delivery failure should create a critical alert");
  await assert.rejects(client.query("insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status) values ($1, $2, 'critical', 'runtime_command_delivery_exhausted', 'duplicate alert', 'open')", [tenantId, manualFailureRun.runId]), /duplicate key/, "a run must not have duplicate open alerts for the same condition");
  const manualFailureAudit = await client.query("select detail from audit_events where event_type = 'runtime_command.delivery_exhausted' and resource_key = (select id::text from runtime_alerts where live_run_id = $1 and code = 'runtime_command_delivery_exhausted')", [manualFailureRun.runId]);
  assert.equal(manualFailureAudit.rows[0].detail.deliveryMode, "manual", "manual terminal delivery failure must record its delivery mode");
  const healthyManualFailureTelemetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${telemetryToken}` },
    body: JSON.stringify({ tenantId, runId: manualFailureRun.runId, outputConnected: true, inferenceFps: 30, outputFps: 25, avSyncMs: 20, bitrateMbps: 4, gpuUtilization: 70, gpuMemoryMiB: 12000, audioActive: true, fallbackReady: true })
  });
  assert.equal(healthyManualFailureTelemetry.status, 202, "healthy telemetry should be accepted after a manual delivery failure");
  assert.equal((await client.query("select status from runtime_alerts where live_run_id = $1 and code = 'runtime_command_delivery_exhausted'", [manualFailureRun.runId])).rows[0].status, "open", "healthy telemetry must not auto-resolve a command delivery failure");

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
  const recordingRegisteredBody = await recordingRegistered.json();
  assert.equal(recordingRegisteredBody.data.contentVerification.objectVersion, "integration-recording-version-1", "recording registration must preserve the verifier-bound object version");
  assert.match(recordingRegisteredBody.data.contentVerification.evidenceRef, /^evidence:\/\/integration\/recording\//, "recording registration must preserve verifier-issued evidence");
  const recordingRetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/recordings`, { method: "POST", headers: recordingHeaders, body: JSON.stringify(recordingInput) });
  assert.equal(recordingRetry.status, 200, "recording evidence retries must be idempotent");
  const recordingConflict = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/recordings`, { method: "POST", headers: recordingHeaders, body: JSON.stringify({ ...recordingInput, checksumSha256: "b".repeat(64) }) });
  assert.equal(recordingConflict.status, 409, "recording idempotency keys must reject different evidence");
  const malformedRecording = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/recordings`, { method: "POST", headers: recordingHeaders, body: JSON.stringify({ ...recordingInput, runId: "not-a-uuid", idempotencyKey: "recording-invalid-run" }) });
  assert.equal(malformedRecording.status, 404, "malformed recording run IDs must not surface PostgreSQL UUID cast errors");
  const recordings = await fetch(`http://127.0.0.1:${consolePort}/api/v1/recordings`, { headers: requestHeaders });
  assert.equal(recordings.status, 200);
  const recordingsBody = await recordings.json();
  assert.deepEqual(recordingsBody.data.map((recording) => recording.id).sort(), [scopeArtifacts.recoverRecordingId, scopeArtifacts.staleRecordingId, recordingRegisteredBody.data.id].sort(), "the recording list must contain the registered evidence exactly once alongside the scope fixtures");
  assert.equal(recordingsBody.data[0].objectKey, recordingInput.objectKey);
  const recordingAudit = await client.query("select event_type, detail from audit_events where resource_type = 'recording_evidence'");
  assert.deepEqual(recordingAudit.rows.map((row) => row.event_type), ["recording_evidence.registered"]);
  assert.match(recordingAudit.rows[0].detail.evidenceRef, /^evidence:\/\/integration\/recording\//, "recording registration audit must retain verifier-issued evidence");

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

  // Runs seeded earlier in this test (recover, stale, program transition, audio
  // silence, manual delivery failure) still occupy capacity here, so the
  // concurrency limits and usage below are relative to that baseline.
  const occupiedBeforeEntitlements = Number((await client.query("select count(*) as count from live_runs where tenant_id = $1 and (state in ('LIVE', 'DEGRADED') or (state = 'ARMED' and scheduled_start_event_id is not null))", [tenantId])).rows[0].count);
  const degradedOccupyingRun = await seedRun("DEGRADED", "session_entitlement_degraded_active", new Date());
  const entitlementUpdate = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements/max_concurrent_live_runs`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ limitValue: occupiedBeforeEntitlements + 1 }) });
  assert.equal(entitlementUpdate.status, 200, "admin should configure tenant concurrency entitlement");
  const minuteEntitlementUpdate = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements/monthly_live_minutes`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ limitValue: 1000 }) });
  assert.equal(minuteEntitlementUpdate.status, 200, "admin should configure tenant live-minute entitlement");
  const entitlementList = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements`, { headers: requestHeaders });
  assert.equal(entitlementList.status, 200);
  const entitlementBody = await entitlementList.json();
  assert.equal(entitlementBody.data.find((item) => item.code === "max_concurrent_live_runs")?.used, occupiedBeforeEntitlements + 1, "degraded runs must consume concurrent live-run capacity");
  assert.equal(entitlementBody.data.find((item) => item.code === "monthly_live_minutes")?.limitValue, 1000);
  const limitedRun = await seedRun("DEGRADED", "session_entitlement_limit", new Date());
  const blockedRecovery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${limitedRun.runId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: randomUUID() }) });
  assert.equal(blockedRecovery.status, 409, "configured concurrency entitlement must block a second live activation");
  await client.query("update live_runs set state = 'ENDED', updated_at = now() where id = $1", [limitedRun.runId]);
  const pendingStartRun = await seedRun("ARMED", "session_entitlement_pending_start", new Date());
  const pendingStartPayload = { sessionId: "session_entitlement_pending_start", command: { id: `media_${randomUUID()}`, runId: pendingStartRun.runId, type: "start_program", issuedAt: new Date().toISOString(), traceId: `trace_${pendingStartRun.runId}`, payload: { controlAction: "START" } } };
  const pendingStartEvent = await client.query("insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload, available_at) values ($1, 'media.dispatch', 'live_run', $2, $3::jsonb, now() + interval '1 hour') returning id", [tenantId, pendingStartRun.runId, JSON.stringify(pendingStartPayload)]);
  await client.query("update live_runs set scheduled_start_event_id = $2, updated_at = now() where id = $1", [pendingStartRun.runId, pendingStartEvent.rows[0].id]);
  const pendingEntitlementUpdate = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements/max_concurrent_live_runs`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ limitValue: occupiedBeforeEntitlements + 2 }) });
  assert.equal(pendingEntitlementUpdate.status, 200, "admin should update tenant concurrency entitlement for a pending-start reservation");
  const pendingEntitlementList = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements`, { headers: requestHeaders });
  assert.equal(pendingEntitlementList.status, 200);
  assert.equal((await pendingEntitlementList.json()).data.find((item) => item.code === "max_concurrent_live_runs")?.used, occupiedBeforeEntitlements + 2, "an ARMED run with a pending start acknowledgement must reserve capacity");
  const reservationLimitedRun = await seedRun("DEGRADED", "session_entitlement_pending_limit", new Date());
  const blockedByPendingStart = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${reservationLimitedRun.runId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: randomUUID() }) });
  assert.equal(blockedByPendingStart.status, 409, "a pending start acknowledgement must block another activation at the tenant limit");
  const analystDisarmPendingStart = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${pendingStartRun.runId}/lifecycle`, { method: "POST", headers: analystRequestHeaders, body: JSON.stringify({ action: "disarm" }) });
  assert.equal(analystDisarmPendingStart.status, 403, "an analyst must not cancel a pending live activation");
  const disarmPendingStart = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${pendingStartRun.runId}/lifecycle`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ action: "disarm" }) });
  assert.equal(disarmPendingStart.status, 200, "an operator should cancel a pending scheduled activation before it is delivering");
  assert.equal((await disarmPendingStart.json()).data.state, "PREFLIGHT", "disarming must return the run to preflight");
  assert.deepEqual((await client.query("select state from outbox_events where id = $1", [pendingStartEvent.rows[0].id])).rows[0], { state: "cancelled" }, "disarming must cancel the pending activation outbox event");
  const cancelledDelivery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${pendingStartEvent.rows[0].id}/deliver`, { method: "POST", headers: requestHeaders });
  assert.equal(cancelledDelivery.status, 409, "cancelled activation events must not be manually re-delivered");
  const afterDisarmEntitlements = await fetch(`http://127.0.0.1:${consolePort}/api/v1/entitlements`, { headers: requestHeaders });
  assert.equal(afterDisarmEntitlements.status, 200);
  // degradedOccupyingRun and reservationLimitedRun remain DEGRADED; only the pending start is released.
  assert.equal((await afterDisarmEntitlements.json()).data.find((item) => item.code === "max_concurrent_live_runs")?.used, occupiedBeforeEntitlements + 2, "disarming a pending activation must release reserved concurrent capacity");
  assert.equal((await client.query("select count(*) as count from audit_events where resource_id = $1 and event_type = 'live_run.disarm'", [pendingStartRun.runId])).rows[0].count, "1", "disarming must be recorded in the audit chain");

  const interactionHeaders = { "content-type": "application/json", authorization: `Bearer ${interactionToken}` };
  const channelInteractionBody = { tenantId, runId: recoverRunId, channelConnectionId: recoverRun.channelId, eventId: "interaction-1", question: "这款商品有什么卖点？" };
  const channelInteraction = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/channel-interactions`, { method: "POST", headers: interactionHeaders, body: JSON.stringify(channelInteractionBody) });
  assert.equal(channelInteraction.status, 202, "a channel interaction with the tenant service token should be accepted");
  const duplicateChannelInteraction = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/channel-interactions`, { method: "POST", headers: interactionHeaders, body: JSON.stringify(channelInteractionBody) });
  assert.equal(duplicateChannelInteraction.status, 200, "identical channel interaction retries must be idempotent");
  const conflictingChannelInteraction = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/channel-interactions`, { method: "POST", headers: interactionHeaders, body: JSON.stringify({ ...channelInteractionBody, question: "换一条不同问题" }) });
  assert.equal(conflictingChannelInteraction.status, 409, "a channel interaction event id must not be reused with different content");
  assert.equal((await client.query("select count(*) as count from audit_events where event_type = 'channel_interaction.received'")).rows[0].count, "1", "a newly ingested channel interaction must be audited once");
  const replyInteractionId = (await client.query("select id from live_interactions where live_run_id = $1 and external_event_id = 'interaction-1'", [recoverRunId])).rows[0].id;
  const analystReplyDraft = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/reply-drafts`, { method: "POST", headers: analystRequestHeaders, body: JSON.stringify({ interactionId: replyInteractionId, channelConnectionId: recoverRun.channelId, body: "分析员不应创建渠道回复" }) });
  assert.equal(analystReplyDraft.status, 403, "an analyst must not create a channel reply draft");
  const replyDraftResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/reply-drafts`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ interactionId: replyInteractionId, channelConnectionId: recoverRun.channelId, body: "当前已批准资料显示商品卖点以详情页说明为准。" }) });
  assert.equal(replyDraftResponse.status, 201, "an operator should create a persistent channel reply draft");
  const replyDraft = (await replyDraftResponse.json()).data;
  const replyEdited = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/reply-drafts/${replyDraft.id}`, { method: "PUT", headers: operatorRequestHeaders, body: JSON.stringify({ body: "当前已批准资料显示商品卖点以详情页和平台结算页为准。" }) });
  assert.equal(replyEdited.status, 200, "an operator should edit a draft reply before submission");
  const replySubmitted = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/reply-drafts/${replyDraft.id}/submit`, { method: "POST", headers: operatorRequestHeaders });
  assert.equal(replySubmitted.status, 200, "an operator should submit a channel reply for approval");
  const operatorApproval = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/reply-drafts/${replyDraft.id}/approve`, { method: "POST", headers: operatorRequestHeaders });
  assert.equal(operatorApproval.status, 403, "an operator must not approve a channel reply");
  const replyApproved = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/reply-drafts/${replyDraft.id}/approve`, { method: "POST", headers: requestHeaders });
  assert.equal(replyApproved.status, 200, "a reviewer-capable admin should approve a channel reply created by another actor");
  const replyQueued = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/reply-drafts/${replyDraft.id}/send`, { method: "POST", headers: operatorRequestHeaders });
  assert.equal(replyQueued.status, 202, "an approved channel reply should enter the durable outbox");
  const queuedReply = await replyQueued.json();
  const manualReplyDelivery = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/outbox/${queuedReply.meta.outboxEventId}/deliver`, { method: "POST", headers: requestHeaders });
  assert.equal(manualReplyDelivery.status, 409, "manual runtime delivery must not bypass the channel-reply worker");

  const adapterPort = await availablePort();
  const adapterSigningSecret = "control-plane-integration-adapter-signing-secret";
  adapterProcess = spawn(process.execPath, [channelAdapter], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: appDatabaseUrl,
      CONTROL_PLANE_URL: `http://127.0.0.1:${consolePort}`,
      CHANNEL_ADAPTER_PORT: String(adapterPort),
      CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE: "1",
      CHANNEL_ADAPTER_DISPATCH_TOKEN: "channel-adapter-dispatch-token-at-least-32-bytes",
      CHANNEL_ADAPTER_TARGETS: JSON.stringify([{ tenantId, channelConnectionId: recoverRun.channelId, signingSecret: adapterSigningSecret, interactionToken, commerceToken, providerReplyEndpoint: `${mock.baseUrl}/provider-reply-fixture`, providerReplyToken: "provider-reply-token-at-least-32-bytes" }])
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${adapterPort}/healthz`)).ok, 10_000, "channel adapter startup");
  const adapterEventId = "adapter-paid-1";
  const adapterPayload = JSON.stringify({ kind: "commerce", runId: recoverRunId, eventType: "order_paid", orderReference: "adapter-order-1", amountCents: 9900, quantity: 1 });
  const adapterTimestamp = String(Date.now());
  const adapterSignature = `sha256=${createHmac("sha256", adapterSigningSecret).update(`${adapterTimestamp}.${adapterPayload}`).digest("hex")}`;
  const adapterHeaders = { "content-type": "application/json", "x-shuzhiren-event-id": adapterEventId, "x-shuzhiren-timestamp": adapterTimestamp, "x-shuzhiren-signature": adapterSignature };
  const malformedPayload = "{not-json";
  const malformedSignature = `sha256=${createHmac("sha256", adapterSigningSecret).update(`${adapterTimestamp}.${malformedPayload}`).digest("hex")}`;
  const malformedAdapterEvent = await fetch(`http://127.0.0.1:${adapterPort}/v1/webhooks/${recoverRun.channelId}`, { method: "POST", headers: { ...adapterHeaders, "x-shuzhiren-event-id": "adapter-malformed-1", "x-shuzhiren-signature": malformedSignature }, body: malformedPayload });
  assert.equal(malformedAdapterEvent.status, 400, "signed malformed webhook bodies must be reported as client errors");
  const adapterInvalidSignature = await fetch(`http://127.0.0.1:${adapterPort}/v1/webhooks/${recoverRun.channelId}`, { method: "POST", headers: { ...adapterHeaders, "x-shuzhiren-signature": "sha256=invalid" }, body: adapterPayload });
  assert.equal(adapterInvalidSignature.status, 401, "invalid signatures must be rejected before consuming channel rate capacity");
  const adapterDelivery = await fetch(`http://127.0.0.1:${adapterPort}/v1/webhooks/${recoverRun.channelId}`, { method: "POST", headers: adapterHeaders, body: adapterPayload });
  assert.equal(adapterDelivery.status, 202, "signed adapter commerce event should be forwarded");
  const adapterDuplicate = await fetch(`http://127.0.0.1:${adapterPort}/v1/webhooks/${recoverRun.channelId}`, { method: "POST", headers: adapterHeaders, body: adapterPayload });
  assert.equal(adapterDuplicate.status, 200, "delivered adapter event should be deduplicated before forwarding");
  const adapterReplay = await client.query("select state from channel_webhook_replays where channel_connection_id = $1 and external_event_id = $2", [recoverRun.channelId, adapterEventId]);
  assert.deepEqual(adapterReplay.rows[0], { state: "delivered" });
  const limitedAdapterEventId = "adapter-paid-limited-1";
  const limitedAdapterPayload = JSON.stringify({ kind: "commerce", runId: recoverRunId, eventType: "order_paid", orderReference: "adapter-order-limited-1", amountCents: 9900, quantity: 1 });
  const limitedAdapterSignature = `sha256=${createHmac("sha256", adapterSigningSecret).update(`${adapterTimestamp}.${limitedAdapterPayload}`).digest("hex")}`;
  const limitedAdapterDelivery = await fetch(`http://127.0.0.1:${adapterPort}/v1/webhooks/${recoverRun.channelId}`, { method: "POST", headers: { "content-type": "application/json", "x-shuzhiren-event-id": limitedAdapterEventId, "x-shuzhiren-timestamp": adapterTimestamp, "x-shuzhiren-signature": limitedAdapterSignature }, body: limitedAdapterPayload });
  assert.equal(limitedAdapterDelivery.status, 429, "a second verified event must be rate limited after capacity is exhausted");
  const releasedReplay = await client.query("select state, lease_expires_at is null as released from channel_webhook_replays where channel_connection_id = $1 and external_event_id = $2", [recoverRun.channelId, limitedAdapterEventId]);
  assert.deepEqual(releasedReplay.rows[0], { state: "pending", released: true }, "rate limiting must release a claimed replay so platform retries are not blocked by a false in-flight lease");

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

  const settlementHeaders = { "content-type": "application/json", authorization: `Bearer ${settlementToken}` };
  const settlementPeriodStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const settlementPeriodEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const reconciledStatement = { tenantId, channelConnectionId: recoverRun.channelId, providerStatementRef: "integration-statement-reconciled", periodStart: settlementPeriodStart, periodEnd: settlementPeriodEnd, sourceSha256: "a".repeat(64), evidenceRef: "evidence://integration/settlement/reconciled", lines: [
    { externalLineId: "sale-order-1", lineType: "gross_sale", externalOrderReference: "order-1", occurredAt: settlementPeriodEnd, amountCents: 19900 },
    { externalLineId: "sale-adapter-1", lineType: "gross_sale", externalOrderReference: "adapter-order-1", occurredAt: settlementPeriodEnd, amountCents: 9900 },
    { externalLineId: "refund-order-1", lineType: "refund", externalOrderReference: "order-1", occurredAt: settlementPeriodEnd, amountCents: -5000 },
    { externalLineId: "platform-fee-1", lineType: "platform_fee", occurredAt: settlementPeriodEnd, amountCents: -1000 },
    { externalLineId: "payout-1", lineType: "payout", occurredAt: settlementPeriodEnd, amountCents: 23800 }
  ] };
  const settlementImported = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/settlement-batches`, { method: "POST", headers: settlementHeaders, body: JSON.stringify(reconciledStatement) });
  assert.equal(settlementImported.status, 202, "a private settlement statement import must be accepted");
  const settlementImportedPayload = await settlementImported.json();
  assert.equal(settlementImportedPayload.data.status, "reconciled", "a matching statement should reconcile without human exceptions");
  assert.equal(settlementImportedPayload.data.exceptions.length, 0, "a matching statement should not create reconciliation exceptions");
  const settlementRetry = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/settlement-batches`, { method: "POST", headers: settlementHeaders, body: JSON.stringify(reconciledStatement) });
  assert.equal(settlementRetry.status, 200, "identical settlement statement imports must be idempotent");
  const settlementConflict = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/settlement-batches`, { method: "POST", headers: settlementHeaders, body: JSON.stringify({ ...reconciledStatement, sourceSha256: "b".repeat(64) }) });
  assert.equal(settlementConflict.status, 409, "the same provider statement reference cannot be reused with different source evidence");
  const reviewStatement = { ...reconciledStatement, providerStatementRef: "integration-statement-review", sourceSha256: "c".repeat(64), evidenceRef: "evidence://integration/settlement/review", lines: [
    { externalLineId: "unmatched-sale", lineType: "gross_sale", externalOrderReference: "missing-order", occurredAt: settlementPeriodEnd, amountCents: 100 },
    { externalLineId: "unmatched-payout", lineType: "payout", occurredAt: settlementPeriodEnd, amountCents: 100 }
  ] };
  const settlementReview = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/settlement-batches`, { method: "POST", headers: settlementHeaders, body: JSON.stringify(reviewStatement) });
  assert.equal(settlementReview.status, 202, "a valid statement with an unmatched order must be imported for review");
  const settlementReviewPayload = await settlementReview.json();
  assert.equal(settlementReviewPayload.data.status, "review_required", "an unmatched statement line must require review");
  const settlementException = settlementReviewPayload.data.exceptions.find((exception) => exception.exceptionType === "missing_operational_event");
  assert.ok(settlementException, "the unmatched statement line must create a missing-operational-event exception");
  const analystSettlementResolve = await fetch(`http://127.0.0.1:${consolePort}/api/v1/settlement-exceptions/${settlementException.id}/resolve`, { method: "POST", headers: analystRequestHeaders, body: JSON.stringify({ resolution: "分析员不能结案平台账单差异。", evidenceRef: "evidence://integration/settlement/analyst" }) });
  assert.equal(analystSettlementResolve.status, 403, "analysts must not resolve settlement exceptions");
  const settlementResolve = await fetch(`http://127.0.0.1:${consolePort}/api/v1/settlement-exceptions/${settlementException.id}/resolve`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ resolution: "平台已确认该订单属于账期外补充行，已建立追溯工单。", evidenceRef: "evidence://integration/settlement/resolution" }) });
  assert.equal(settlementResolve.status, 200, "an administrator must resolve a settlement exception with controlled evidence");
  const settlementList = await fetch(`http://127.0.0.1:${consolePort}/api/v1/settlement-batches`, { headers: analystRequestHeaders });
  assert.equal(settlementList.status, 200, "analysts may read governed settlement batches");
  assert.equal((await settlementList.json()).data.length, 2, "settlement list must expose both integration statements");
  const settlementAudit = await client.query("select event_type from audit_events where resource_type in ('settlement_batch', 'settlement_exception') order by chain_sequence");
  assert.deepEqual(settlementAudit.rows.map((row) => row.event_type), ["settlement_batch.imported", "settlement_batch.imported", "settlement_exception.resolved"], "settlement imports and exception resolution must enter the audit chain");

  await client.query("update tenant_entitlements set limit_value = 999 where tenant_id = $1 and code = 'max_concurrent_live_runs'", [tenantId]);
  await client.query("insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, audio_active, fallback_ready, sampled_at) values ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, true, now())", [tenantId, programTransitionRun.runId]);
  workerProcess = spawn(process.execPath, [worker], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: appDatabaseUrl,
      RUNTIME_GATEWAY_URL: mock.baseUrl,
      RUNTIME_SHARED_TOKEN: gatewayToken,
      CHANNEL_ADAPTER_URL: `http://127.0.0.1:${adapterPort}`,
      CHANNEL_ADAPTER_DISPATCH_TOKEN: "channel-adapter-dispatch-token-at-least-32-bytes",
      OUTBOX_POLL_MS: "20",
      SCHEDULER_POLL_MS: "1000",
      SCHEDULER_BATCH_SIZE: "1",
      RUNTIME_WATCHDOG_POLL_MS: "10",
      RUNTIME_WATCHDOG_BATCH_SIZE: "1",
      RUNTIME_TELEMETRY_MAX_AGE_SECONDS: "60",
      USAGE_METER_POLL_MS: "10",
      OUTBOX_MAX_ATTEMPTS: "2",
      OUTBOX_RETRY_BASE_MS: "10",
      OUTBOX_RETRY_MAX_MS: "20"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => {
    const result = await client.query("select state, active_program_segment_id, scheduled_start_event_id from live_runs where id = $1", [scheduledProgramRun.runId]);
    const run = result.rows[0];
    return run?.state === "LIVE" && run?.active_program_segment_id === scheduledProgramRun.primarySegmentId && run?.scheduled_start_event_id === null;
  }, 10_000, "scheduled start program baseline acknowledgement");
  const scheduledStartCommand = mock.mediaCommands.find((command) => command.action === "start_program" && command.program_segment_id === scheduledProgramRun.primarySegmentId);
  assert.deepEqual({ program_segment_id: scheduledStartCommand?.program_segment_id, program_script: scheduledStartCommand?.program_script, script_sha256: scheduledStartCommand?.script_sha256 }, { program_segment_id: scheduledProgramRun.primarySegmentId, program_script: scheduledProgramRun.primaryScript, script_sha256: scheduledProgramRun.primaryScriptSha256 }, "scheduled start must dispatch and acknowledge the frozen baseline script");
  const scheduledActivationAudit = await client.query("select count(*)::int as count from audit_events where resource_key = $1 and event_type = 'live_program.activation_accepted'", [scheduledProgramRun.runId]);
  assert.equal(scheduledActivationAudit.rows[0].count, 1, "a scheduled baseline activation must enter the immutable audit chain");
  await waitFor(async () => {
    const result = await client.query("select active_program_segment_id, active_insert_source_segment_id, active_insert_program_segment_id, pending_program_transition_event_id from live_runs where id = $1", [programTransitionRun.runId]);
    const cursor = result.rows[0];
    return cursor?.active_program_segment_id === programTransitionRun.insertSegmentId
      && cursor?.active_insert_source_segment_id === programTransitionRun.primarySegmentId
      && cursor?.active_insert_program_segment_id === programTransitionRun.insertSegmentId
      && cursor?.pending_program_transition_event_id === null;
  }, 10_000, "program insertion gateway acknowledgement");
  const insertionMediaCommand = mock.mediaCommands.find((command) => command.command_id === programInsertBody.data.mediaEvent.command.id);
  assert.deepEqual({ action: insertionMediaCommand?.action, program_segment_id: insertionMediaCommand?.program_segment_id, program_script: insertionMediaCommand?.program_script, script_sha256: insertionMediaCommand?.script_sha256 }, { action: "insert_program", program_segment_id: programTransitionRun.insertSegmentId, program_script: programTransitionRun.insertScript, script_sha256: programTransitionRun.insertScriptSha256 }, "worker must dispatch the approved frozen script and its hash to the gateway");
  const programOutputObservation = {
    tenantId,
    runId: programTransitionRun.runId,
    runtimeSessionId: `session_program_${programTransitionRun.runId}`,
    outboxEventId: programInsertBody.data.mediaEvent.id,
    commandId: programInsertBody.data.mediaEvent.command.id,
    programSegmentId: programTransitionRun.insertSegmentId,
    action: "INSERT_PROGRAM",
    source: "watermark_verifier",
    evidenceRef: "evidence://integration/program-output/insert",
    contentSha256: "a".repeat(64),
    confidence: 0.995,
    mediaTimeMs: 5000,
    observedAt: new Date().toISOString()
  };
  const { tenantId: _attestationTenantId, ...attestedObservation } = programOutputObservation;
  const attestationPayload = { issuer: "watermark_verifier", keyId: "integration-2026", audience: `${tenantId}:${programTransitionRun.runId}`, issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), observation: attestedObservation };
  const signedProgramOutputObservation = { ...programOutputObservation, attestation: { ...attestationPayload, signature: sign(null, Buffer.from(canonicalJson(attestationPayload)), outputVerifier.privateKey).toString("base64url") } };
  const telemetryAuthorizedOutputObservation = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/program-output-observations`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${telemetryToken}` }, body: JSON.stringify(signedProgramOutputObservation) });
  assert.equal(telemetryAuthorizedOutputObservation.status, 401, "telemetry service credentials must not submit output attestation evidence");
  const outputObservationAccepted = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/program-output-observations`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${programOutputToken}` }, body: JSON.stringify(signedProgramOutputObservation) });
  assert.equal(outputObservationAccepted.status, 202, "a verifier attestation bound to a delivered program command must be accepted");
  const outputObservationDuplicate = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/program-output-observations`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${programOutputToken}` }, body: JSON.stringify(signedProgramOutputObservation) });
  assert.equal(outputObservationDuplicate.status, 200, "an identical output observation retry must be idempotent");
  const outputObservationBadSignature = await fetch(`http://127.0.0.1:${consolePort}/api/v1/runtime/program-output-observations`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${programOutputToken}` }, body: JSON.stringify({ ...signedProgramOutputObservation, confidence: 0.5 }) });
  assert.equal(outputObservationBadSignature.status, 403, "a modified signed output observation must be rejected before it reaches immutable evidence storage");
  await assert.rejects(client.query("update program_output_observations set confidence = 0 where outbox_event_id = $1", [programInsertBody.data.mediaEvent.id]), /program output observations are immutable/i, "program output observation evidence must be append-only at the database layer");
  const outputObservationAudit = await client.query("select detail ->> 'programSegmentId' as program_segment_id, detail ->> 'outboxEventId' as outbox_event_id from audit_events where resource_key = $1 and event_type = 'live_program.output_observed'", [programTransitionRun.runId]);
  assert.deepEqual(outputObservationAudit.rows, [{ program_segment_id: programTransitionRun.insertSegmentId, outbox_event_id: programInsertBody.data.mediaEvent.id }], "a real output observation must enter the immutable audit chain with its command binding");
  const nestedProgramInsert = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${programTransitionRun.runId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "INSERT_PROGRAM", expectedState: "LIVE", programSegmentId: programTransitionRun.insertSegmentId, idempotencyKey: randomUUID() }) });
  assert.equal(nestedProgramInsert.status, 409, "an accepted insertion must be rolled back before another insertion");
  const programRollback = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${programTransitionRun.runId}/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ action: "ROLLBACK_PROGRAM", expectedState: "LIVE", idempotencyKey: randomUUID() }) });
  assert.equal(programRollback.status, 202, "an accepted insertion should allow a receipt-bound rollback");
  const programRollbackBody = await programRollback.json();
  await waitFor(async () => {
    const result = await client.query("select active_program_segment_id, active_insert_source_segment_id, active_insert_program_segment_id, pending_program_transition_event_id from live_runs where id = $1", [programTransitionRun.runId]);
    const cursor = result.rows[0];
    return cursor?.active_program_segment_id === programTransitionRun.primarySegmentId
      && cursor?.active_insert_source_segment_id === null
      && cursor?.active_insert_program_segment_id === null
      && cursor?.pending_program_transition_event_id === null;
  }, 10_000, "program rollback gateway acknowledgement");
  const rollbackMediaCommand = mock.mediaCommands.find((command) => command.command_id === programRollbackBody.data.mediaEvent.command.id);
  assert.deepEqual({ action: rollbackMediaCommand?.action, program_segment_id: rollbackMediaCommand?.program_segment_id, program_script: rollbackMediaCommand?.program_script, script_sha256: rollbackMediaCommand?.script_sha256 }, { action: "resume_program", program_segment_id: programTransitionRun.primarySegmentId, program_script: programTransitionRun.primaryScript, script_sha256: programTransitionRun.primaryScriptSha256 }, "rollback must restore the saved frozen source script rather than an operator-supplied value");
  const programTransitionAudit = await client.query("select detail ->> 'action' as action from audit_events where resource_key = $1 and event_type = 'live_program.transition_accepted' order by chain_sequence", [programTransitionRun.runId]);
  assert.deepEqual(programTransitionAudit.rows.map((row) => row.action), ["INSERT_PROGRAM", "ROLLBACK_PROGRAM"], "receipt-bound insertion and rollback must both enter the immutable audit chain");
  await waitFor(async () => (await client.query("select status, provider_message_id from channel_reply_drafts where id = $1", [replyDraft.id])).rows[0]?.status === "sent", 10_000, "channel reply worker delivery");
  assert.equal(mock.channelReplies.length, 1, "the channel adapter should forward the approved reply to its provider bridge once");
  assert.deepEqual((await client.query("select status from live_interactions where id = $1", [replyInteractionId])).rows[0], { status: "handled" }, "only a delivered channel reply should close the source interaction");
  assert.equal((await client.query("select event_type from audit_events where resource_id = $1 and event_type = 'channel_reply.delivered'", [replyDraft.id])).rows.length, 1, "channel reply delivery must be recorded in the audit chain");
  await waitFor(async () => (await client.query("select state from live_runs where id = $1", [staleRunId])).rows[0]?.state === "DEGRADED", 10_000, "stale telemetry watchdog");
  await waitFor(async () => Number((await client.query("select count(*) as count from usage_records where live_run_id = $1 and code = 'monthly_live_minutes'", [recoverRunId])).rows[0]?.count) >= 1, 10_000, "live-minute metering");
  await waitFor(async () => Number((await client.query("select count(*) as count from usage_records where live_run_id = $1 and code = 'monthly_live_minutes'", [degradedOccupyingRun.runId])).rows[0]?.count) >= 1, 10_000, "degraded live-minute metering");
  const alert = await client.query("select code, status from runtime_alerts where live_run_id = $1 and code = 'runtime_telemetry_stale'", [staleRunId]);
  assert.deepEqual(alert.rows[0], { code: "runtime_telemetry_stale", status: "open" });
  const alertId = (await client.query("select id from runtime_alerts where live_run_id = $1 and code = 'runtime_telemetry_stale'", [staleRunId])).rows[0].id;
  const notifierPort = await availablePort();
  const notifierSigningSecret = "control-plane-integration-notifier-signing-secret";
  notifierProcess = spawn(process.execPath, [alertNotifier], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: appDatabaseUrl,
      ALERT_NOTIFIER_PORT: String(notifierPort),
      ALERT_NOTIFIER_POLL_MS: "20",
      ALERT_NOTIFIER_ALLOW_INSECURE_HTTP: "true",
      ALERT_NOTIFIER_TARGETS: JSON.stringify([{ id: "integration-critical", tenantId, webhookUrl: `${mock.baseUrl}/alert-webhook`, signingSecret: notifierSigningSecret, minimumSeverity: "critical" }])
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${notifierPort}/healthz`)).ok, 10_000, "alert notifier startup");
  const notifierHealth = await fetch(`http://127.0.0.1:${notifierPort}/healthz`);
  const notifierHealthBody = await notifierHealth.json();
  assert.equal(notifierHealthBody.ok, true, "alert notifier health must require a fresh successful polling cycle");
  assert.equal(typeof notifierHealthBody.lastSuccessfulTickAt, "string", "alert notifier health must expose the last successful polling cycle");
  await waitFor(() => mock.alertNotifications.some((notification) => notification.payload.alert.id === alertId), 10_000, "runtime alert webhook delivery");
  assert.equal(mock.alertNotifications.find((notification) => notification.payload.alert.id === alertId)?.payload.alert.code, "runtime_telemetry_stale");
  const notificationDelivery = await client.query("select state, attempts from alert_notification_deliveries where runtime_alert_id = $1", [alertId]);
  assert.deepEqual(notificationDelivery.rows[0], { state: "delivered", attempts: 1 });

  const exhaustedRun = await seedRun("LIVE", "session_outbox_exhausted", new Date());
  const exhaustedCommandId = `fail_media_${randomUUID()}`;
  const exhaustedEvent = await client.query(`insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
    values ($1, 'media.dispatch', 'live_run', $2, $3::jsonb) returning id`, [tenantId, exhaustedRun.runId, JSON.stringify({
      sessionId: "session_outbox_exhausted",
      command: { id: exhaustedCommandId, runId: exhaustedRun.runId, type: "switch_to_human", issuedAt: new Date().toISOString(), traceId: `trace_${exhaustedRun.runId}`, payload: { controlAction: "OUTBOX_FAILURE_TEST" } }
    })]);
  const exhaustedEventId = exhaustedEvent.rows[0].id;
  await waitFor(async () => (await client.query("select status from runtime_alerts where live_run_id = $1 and code = 'runtime_command_delivery_exhausted'", [exhaustedRun.runId])).rows[0]?.status === "open", 10_000, "exhausted runtime command alert");
  const exhaustedAlert = await client.query("select severity, status from runtime_alerts where live_run_id = $1 and code = 'runtime_command_delivery_exhausted'", [exhaustedRun.runId]);
  assert.deepEqual(exhaustedAlert.rows[0], { severity: "critical", status: "open" }, "exhausted media dispatch should create a critical alert");
  const exhaustedAudit = await client.query("select detail from audit_events where event_type = 'runtime_command.delivery_exhausted' and resource_key = (select id::text from runtime_alerts where live_run_id = $1 and code = 'runtime_command_delivery_exhausted')", [exhaustedRun.runId]);
  assert.equal(exhaustedAudit.rows[0].detail.outboxEventId, exhaustedEventId, "terminal delivery failure audit must preserve the outbox event id");
  await waitFor(() => mock.alertNotifications.some((notification) => notification.payload.alert.code === "runtime_command_delivery_exhausted"), 10_000, "exhausted runtime command notification");
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
  assert.deepEqual(revokedReleaseBody.meta, { quarantinedLiveRunCount: 1, humanHandoffQueuedCount: 1 }, "model release revocation must report its live governance impact");
  assert.equal((await client.query("select state from live_runs where id = $1", [recoverRunId])).rows[0].state, "DEGRADED", "revoking a frozen live release must quarantine the active run");
  const governanceHandoff = await client.query("select payload #>> '{command,type}' as action, payload #>> '{command,payload,controlAction}' as control_action from outbox_events where aggregate_id = $1 order by created_at desc limit 1", [recoverRunId]);
  assert.deepEqual(governanceHandoff.rows[0], { action: "switch_to_human", control_action: "GOVERNANCE_REVOCATION" }, "revocation quarantine must enqueue a human-handoff media command");
  const governanceAudit = await client.query("select event_type from audit_events where resource_key = $1 and event_type = 'live_run.governance_quarantined'", [recoverRunId]);
  assert.equal(governanceAudit.rows.length, 1, "revocation quarantine must be sealed in the audit chain");
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
  assert.deepEqual(revokedAssetBody.meta, { quarantinedLiveRunCount: 0, humanHandoffQueuedCount: 0 }, "an already-quarantined run must not be counted twice when another binding is revoked");
  const assetRevokedPreflight = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/preflight`, { headers: requestHeaders });
  assert.equal(assetRevokedPreflight.status, 200);
  const assetRevokedPreflightBody = await assetRevokedPreflight.json();
  assert.equal(assetRevokedPreflightBody.data.checks.find((check) => check.id === "rights")?.status, "blocked", "a revoked frozen media asset must block preflight");
  const revokedManifestResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/live-runs/${recoverRunId}/release-manifest`, { headers: requestHeaders });
  assert.equal(revokedManifestResponse.status, 200);
  assert.equal((await revokedManifestResponse.json()).data.assets.find((asset) => asset.kind === "voice")?.approval, "revoked", "the release manifest must expose a revoked frozen asset");
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
  // N2: a channel connection and its channel_connection.created audit event commit in one transaction.
  const createdChannelName = `IT channel ${randomUUID()}`;
  const createdChannelResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/channels/connections`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ name: `  ${createdChannelName}  `, provider: "generic-rtmp", outputProtocol: "rtmp", secretRef: "kms://shuzhiren/integration/channel/created" }) });
  assert.equal(createdChannelResponse.status, 201, "a tenant-wide operator should create a channel connection");
  const createdChannel = (await createdChannelResponse.json()).data;
  assert.equal(createdChannel.status, "disabled", "a new channel connection must start disabled");
  assert.equal(createdChannel.name, createdChannelName, "a channel connection name must be stored without surrounding whitespace");
  const createdChannelAudit = await client.query("select u.external_subject from audit_events a join users u on u.id = a.actor_id where a.event_type = 'channel_connection.created' and a.resource_key = $1", [createdChannel.id]);
  assert.deepEqual(createdChannelAudit.rows, [{ external_subject: "integration-second-operator" }], "channel connection creation must be audited exactly once with the requesting operator");
  const duplicateChannelResponse = await fetch(`http://127.0.0.1:${consolePort}/api/v1/channels/connections`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ name: createdChannelName, provider: "generic-rtmp", outputProtocol: "rtmp", secretRef: "kms://shuzhiren/integration/channel/duplicate" }) });
  assert.equal(duplicateChannelResponse.status, 409, "a duplicate channel connection name must be rejected");
  const rolledBackChannelName = `IT rolled back channel ${randomUUID()}`;
  await client.query("create function integration_reject_channel_created_audit() returns trigger language plpgsql as $$ begin if new.event_type = 'channel_connection.created' then raise exception 'integration audit write failure'; end if; return new; end $$");
  await client.query("create trigger integration_reject_channel_created_audit before insert on audit_events for each row execute function integration_reject_channel_created_audit()");
  try {
    const failedAuditChannel = await fetch(`http://127.0.0.1:${consolePort}/api/v1/channels/connections`, { method: "POST", headers: operatorRequestHeaders, body: JSON.stringify({ name: rolledBackChannelName, provider: "generic-rtmp", outputProtocol: "rtmp", secretRef: "kms://shuzhiren/integration/channel/rolled-back" }) });
    assert.ok(failedAuditChannel.status >= 500, "a failed channel_connection.created audit write must fail the request");
  } finally {
    await client.query("drop trigger integration_reject_channel_created_audit on audit_events");
    await client.query("drop function integration_reject_channel_created_audit()");
  }
  assert.equal((await client.query("select count(*)::int as count from channel_connections where tenant_id = $1 and name = $2", [tenantId, rolledBackChannelName])).rows[0].count, 0, "a failed audit write must roll back the channel connection");
  // M3: PostgreSQL terminating an idle control-plane connection must be logged, not crash the process.
  let consoleStderr = "";
  next.stderr.setEncoding("utf8");
  next.stderr.on("data", (chunk) => { consoleStderr += chunk; });
  assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/health`)).status, 200, "the control plane pool must hold an idle connection before the termination check");
  const terminatedConsoleBackends = await client.query("select pg_terminate_backend(pid) as terminated from pg_stat_activity where application_name = 'shuzhiren-control-plane' and state = 'idle'");
  assert.ok(terminatedConsoleBackends.rows.some((row) => row.terminated === true), "the control plane pool must expose its idle connections by application_name");
  await waitFor(async () => consoleStderr.includes('"event":"database.pool_error"'), 10_000, "control plane pool error log");
  assert.equal(next.exitCode, null, "an idle connection terminated by PostgreSQL must not crash the control plane");
  assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/health`)).status, 200, "the control plane must reconnect after an idle connection error");
  assert.ok(!consoleStderr.includes(new URL(appDatabaseUrl).password), "database error logs must not contain the connection password");
  console.log("PASS  PostgreSQL control plane isolates tenant reads and service credentials, rejects stale product facts, evaluates sampling quality SLOs, revokes frozen model releases and media rights fail-closed, ingests idempotent reviewable PIM facts, enforces entitlements, meters LIVE and DEGRADED minutes, gates recovery, records idempotent commerce facts, durably notifies, tracks incidents, acknowledges runtime alerts, and degrades stale LIVE telemetry");
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
  const productId = randomUUID();
  const productVersionId = randomUUID();
  const policyProfileId = randomUUID();
  const runId = randomUUID();
  const channelId = randomUUID();
  const modelReleaseIds = { runtime: randomUUID(), lip_sync: randomUUID(), voice: randomUUID() };
  const mediaAssetIds = { portrait: randomUUID(), voice: randomUUID(), product_clip: randomUUID(), music: randomUUID() };
  await client.query("insert into tenants (id, slug, name) values ($1, $2, $3) on conflict (id) do nothing", [tenantId, `integration-${tenantId}`, "Control plane integration"]);
  await client.query("insert into shows (id, tenant_id, name) values ($1, $2, $3)", [showId, tenantId, `Integration show ${runId}`]);
  await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 1, '{}'::jsonb, 'approved')", [revisionId, tenantId, showId]);
  const productFacts = { priceCent: 9900, unitCostCent: 3500, stock: 20, highlights: ["Seeded product"], faq: ["Seeded FAQ"], sourceRef: `pim://integration/${runId}`, sourceSyncedAt: new Date().toISOString(), validFrom: new Date(Date.now() - 60_000).toISOString() };
  await client.query("insert into products (id, tenant_id, external_sku, name) values ($1, $2, $3, $4)", [productId, tenantId, `seed-${runId}`, "Seeded integration product"]);
  await client.query("insert into product_versions (id, tenant_id, product_id, revision, facts, approval_status, approved_at) values ($1, $2, $3, 1, $4::jsonb, 'approved', now())", [productVersionId, tenantId, productId, JSON.stringify(productFacts)]);
  await client.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [tenantId, revisionId, productVersionId]);
  // model_releases is unique on (tenant_id, component, name, version) and every
  // seeded run shares one tenant, so each run gets its own release version. The
  // releases must stay per-run: revoking one run's release has to quarantine
  // only that run (see the quarantinedLiveRunCount assertion).
  const modelReleaseVersion = `integration-${runId}`;
  for (const [component, releaseId] of Object.entries(modelReleaseIds)) {
    await client.query("insert into model_releases (id, tenant_id, name, version, component, source_commit, image_digest, artifact_hash, driver_version, license, rights_scope, evidence_ref, validation_summary, approval_status, approved_at) values ($1, $2, $3, $5, $4::model_release_component, 'integration-commit', 'sha256:integration-image', 'sha256:integration-artifact', 'NVIDIA integration', 'Apache-2.0', 'Integration validation only', 'evidence://integration/model-release', 'Integration-bound approved release.', 'approved', now())", [releaseId, tenantId, `Integration ${component}`, component, modelReleaseVersion]);
    await client.query("insert into show_revision_model_releases (tenant_id, show_revision_id, model_release_id, component) values ($1, $2, $3, $4::model_release_component)", [tenantId, revisionId, releaseId, component]);
  }
  for (const [kind, assetId] of Object.entries(mediaAssetIds)) {
    await client.query("insert into media_assets (id, tenant_id, kind, name, object_key, checksum, rights_scope, source_ref, approval_status, approved_at, runtime_voice_id, verified_object_version, verified_bytes, verified_content_type, verification_evidence_ref, verified_at) values ($1, $2, $3::media_asset_kind, $4, $5, $6, 'Integration approved rights', 'evidence://integration/media-asset', 'approved', now(), $7, 'integration-seed-v1', 1024, $8, 'evidence://integration/media-content', now())", [assetId, tenantId, kind, `Integration ${kind}`, `assets/${tenantId}/${kind}`, `sha256:${kind}`, kind === "voice" ? "integration_approved_voice" : null, kind === "portrait" || kind === "product_clip" ? "video/mp4" : "audio/wav"]);
    await client.query("insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) values ($1, $2, $3, $4::media_asset_kind)", [tenantId, revisionId, assetId, kind]);
  }
  const profileRules = [{ id: "integration_block_term", terms: ["集成策略禁播词"], reason: "集成策略包禁止该类提问", action: "refuse", riskLevel: "high", requiredEvidence: [] }];
  await client.query("insert into policy_profiles (id, tenant_id, name, version, rules, evidence_ref, validation_summary, approval_status, approved_at) values ($1, $2, $3, '1.0.0', $4::jsonb, 'evidence://integration/seed', 'Seeded binding for integration validation.', 'approved', now())", [policyProfileId, tenantId, `Integration policy ${runId}`, JSON.stringify(profileRules)]);
  await client.query("insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) values ($1, $2, $3)", [tenantId, revisionId, policyProfileId]);
  const capabilities = { channel: "integration-webhook", supportsRtmp: true, supportsSrt: false, supportsComments: true, supportsOutboundReplies: true, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: true };
  const channelVerifierId = await seedMembership(tenantId, "integration-channel-verifier", "Integration channel verifier", "reviewer");
  await client.query("insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref, verified_by) values ($1, $2, $3, 'normalized-webhook-rtmp', 'connected', 'rtmp', 'secret://integration/channel', $4::jsonb, now(), 'evidence://integration/channel-verification', $5)", [channelId, tenantId, `Integration channel ${runId}`, JSON.stringify(capabilities), channelVerifierId]);
  await client.query("insert into live_runs (id, tenant_id, show_revision_id, state, trace_id, runtime_session_id, channel_connection_id, product_version_id) values ($1, $2, $3, $4::live_run_state, $5, $6, $7, $8)", [runId, tenantId, revisionId, state, `trace_${runId}`, sessionId, channelId, productVersionId]);
  await client.query("insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, audio_active, fallback_ready, sampled_at) values ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, true, $3)", [tenantId, runId, sampledAt]);
  return { runId, channelId, policyProfileId, productVersionId, modelReleaseIds, mediaAssetIds };
}

async function seedProgramTransitionRun({ state = "LIVE", scheduledAt } = {}) {
  const showId = randomUUID();
  const revisionId = randomUUID();
  const runId = randomUUID();
  const primarySegmentId = randomUUID();
  const insertSegmentId = randomUUID();
  const primaryScript = "本段仅播报已批准的主节目商品事实。";
  const insertScript = "本段为已批准的限时插播，结束后回到主节目。";
  // users has no tenant_id; tenant membership lives in memberships.
  const approver = await client.query("select users.id from users join memberships on memberships.user_id = users.id where memberships.tenant_id = $1 and users.external_subject = 'integration-operator'", [tenantId]);
  if (!approver.rows[0]) throw new Error("integration admin must exist before seeding a program transition run");
  await client.query("insert into shows (id, tenant_id, name) values ($1, $2, $3)", [showId, tenantId, `Program transition show ${runId}`]);
  await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 1, '{}'::jsonb, 'draft')", [revisionId, tenantId, showId]);
  await client.query("insert into live_runs (id, tenant_id, show_revision_id, state, trace_id, runtime_session_id) values ($1, $2, $3, 'DRAFT', $4, $5)", [runId, tenantId, revisionId, `trace_${runId}`, `session_program_${runId}`]);
  await client.query("insert into show_revision_segments (id, tenant_id, show_revision_id, position, kind, title, purpose, duration_seconds, runtime_script) values ($1, $2, $3, 1, 'prepared_product', '主节目', '受审核主节目内容', 120, $4), ($5, $2, $3, 2, 'interactive', '限时插播', '受审核插播内容', 60, $6)", [primarySegmentId, tenantId, revisionId, primaryScript, insertSegmentId, insertScript]);
  await client.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revisionId, approver.rows[0].id]);
  await client.query("update live_runs set state = $2::live_run_state, scheduled_at = $3::timestamptz, active_program_segment_id = case when $2::live_run_state = 'LIVE' then $4::uuid else null end where id = $1", [runId, state, scheduledAt ?? null, primarySegmentId]);
  await client.query("insert into runtime_health_samples (tenant_id, live_run_id, output_connected, inference_fps, output_fps, av_sync_ms, bitrate_mbps, gpu_utilization, gpu_memory_mib, audio_active, fallback_ready, sampled_at) values ($1, $2, true, 30, 25, 20, 4, 70, 12000, true, true, now())", [tenantId, runId]);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  return { runId, primarySegmentId, insertSegmentId, primaryScript, insertScript, primaryScriptSha256: digest(primaryScript), insertScriptSha256: digest(insertScript) };
}

async function seedRunScopeArtifacts(recoverRunId, staleRunId) {
  const owner = await client.query("select id from users where external_subject = 'integration-operator'");
  if (!owner.rows[0]) throw new Error("integration admin user was not seeded");
  const recoverAlert = await client.query("insert into runtime_alerts (tenant_id, live_run_id, severity, code, message) values ($1, $2, 'warning', 'scope_recover_alert', 'Authorized scope fixture') returning id", [tenantId, recoverRunId]);
  const staleAlert = await client.query("insert into runtime_alerts (tenant_id, live_run_id, severity, code, message) values ($1, $2, 'warning', 'scope_stale_alert', 'Unauthorized scope fixture') returning id", [tenantId, staleRunId]);
  const recoverIncident = await client.query("insert into incidents (tenant_id, live_run_id, runtime_alert_id, severity, title, owner_id) values ($1, $2, $3, 'warning', 'Authorized scope fixture', $4) returning id", [tenantId, recoverRunId, recoverAlert.rows[0].id, owner.rows[0].id]);
  const staleIncident = await client.query("insert into incidents (tenant_id, live_run_id, runtime_alert_id, severity, title, owner_id) values ($1, $2, $3, 'warning', 'Unauthorized scope fixture', $4) returning id", [tenantId, staleRunId, staleAlert.rows[0].id, owner.rows[0].id]);
  const recoverRecording = await client.query("insert into recording_evidence (tenant_id, live_run_id, object_key, checksum_sha256, bytes, duration_seconds, idempotency_key, verified_object_version, verification_evidence_ref, verified_at) values ($1, $2, $3, $4, 1024, 10, $5, 'scope-version-1', $6, now()) returning id", [tenantId, recoverRunId, `recordings/${recoverRunId}/scope-fixture.mp4`, "a".repeat(64), `scope-recover-${recoverRunId}`, `evidence://integration/recording/${recoverRunId}`]);
  const staleRecording = await client.query("insert into recording_evidence (tenant_id, live_run_id, object_key, checksum_sha256, bytes, duration_seconds, idempotency_key, verified_object_version, verification_evidence_ref, verified_at) values ($1, $2, $3, $4, 1024, 10, $5, 'scope-version-1', $6, now()) returning id", [tenantId, staleRunId, `recordings/${staleRunId}/scope-fixture.mp4`, "b".repeat(64), `scope-stale-${staleRunId}`, `evidence://integration/recording/${staleRunId}`]);
  const outboxPayload = (runId) => JSON.stringify({ sessionId: `scope_${runId}`, command: { id: `scope_command_${runId}`, runId, type: "switch_to_human", issuedAt: new Date().toISOString(), traceId: `scope_trace_${runId}`, payload: { reason: "scope-fixture" } } });
  const recoverOutbox = await client.query("insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload) values ($1, 'media.dispatch', 'live_run', $2, $3::jsonb) returning id", [tenantId, recoverRunId, outboxPayload(recoverRunId)]);
  const staleOutbox = await client.query("insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload) values ($1, 'media.dispatch', 'live_run', $2, $3::jsonb) returning id", [tenantId, staleRunId, outboxPayload(staleRunId)]);
  return { recoverAlertId: recoverAlert.rows[0].id, staleAlertId: staleAlert.rows[0].id, recoverIncidentId: recoverIncident.rows[0].id, staleIncidentId: staleIncident.rows[0].id, recoverRecordingId: recoverRecording.rows[0].id, staleRecordingId: staleRecording.rows[0].id, recoverOutboxEventId: recoverOutbox.rows[0].id, staleOutboxEventId: staleOutbox.rows[0].id };
}

async function provisionApplicationRole() {
  const role = "shuzhiren_integration_app";
  const password = randomUUID();
  if (!/^[0-9a-f-]{36}$/.test(password)) throw new Error("integration application role password must be a UUID");
  await client.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} login nosuperuser nobypassrls noinherit nocreatedb nocreaterole; end if; end $$;`);
  await client.query(`alter role ${role} with login nosuperuser nobypassrls noinherit nocreatedb nocreaterole password '${password}'`);
  await client.query(`grant usage on schema public to ${role}`);
  await client.query(`grant select, insert, update, delete on all tables in schema public to ${role}`);
  await client.query(`grant usage, select, update on all sequences in schema public to ${role}`);
  // runtime_worker_actor is revoked from PUBLIC; the spawned runtime worker records its service actor through it.
  await client.query(`grant execute on function runtime_worker_actor(uuid, text) to ${role}`);
  const attributes = await client.query("select rolsuper, rolbypassrls from pg_roles where rolname = $1", [role]);
  assert.deepEqual(attributes.rows, [{ rolsuper: false, rolbypassrls: false }], "services under test must connect without RLS bypass");
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function seedMembership(targetTenantId, subject, displayName, role) {
  const user = await client.query(
    `insert into users (external_subject, display_name) values ($1, $2)
     on conflict (external_subject) do update set display_name = excluded.display_name
     returning id`,
    [subject, displayName]
  );
  await client.query(
    `insert into memberships (tenant_id, user_id, role) values ($1, $2, $3::membership_role)
     on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'active'`,
    [targetTenantId, user.rows[0].id, role]
  );
  return user.rows[0].id;
}

async function startMockServer() {
  const mediaCommands = [];
  const alertNotifications = [];
  const channelReplies = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/jwks") return json(response, 200, { keys: [jwk] });
    if ((url.pathname === "/v1/observations/0" || url.pathname === "/v1/observations/session_frozen_rights") && request.method === "GET") {
      assert.equal(request.headers.authorization, `Bearer ${gatewayToken}`);
      return json(response, 200, { session: { id: url.pathname.split("/").at(-1), active: true } });
    }
    if (url.pathname === "/v1/observations/missing_session" && request.method === "GET") {
      assert.equal(request.headers.authorization, `Bearer ${gatewayToken}`);
      return json(response, 200, { session: { id: "missing_session", active: false } });
    }
    if (url.pathname === "/v1/previews/session_recover" && request.method === "GET") {
      assert.equal(request.headers.authorization, `Bearer ${gatewayToken}`);
      return json(response, 200, { available: true, mode: "webrtc", url: "https://preview.internal/embed/session_recover", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.pathname === "/v1/media-evidence/verify" && request.method === "POST") {
      assert.equal(request.headers.authorization, `Bearer ${mediaEvidenceToken}`);
      const evidence = await requestBody(request);
      const contentType = evidence.kind === "portrait" || evidence.kind === "product_clip" ? "video/mp4" : evidence.kind === "music" ? "audio/mpeg" : "audio/wav";
      return json(response, 200, { objectKey: evidence.objectKey, checksum: evidence.expectedChecksum, objectVersion: "integration-version-1", bytes: 1024, contentType, evidenceRef: `evidence://integration/${evidence.objectKey}`, verifiedAt: new Date().toISOString() });
    }
    if (url.pathname === "/v1/recording-evidence/verify" && request.method === "POST") {
      assert.equal(request.headers.authorization, `Bearer ${recordingEvidenceToken}`);
      const evidence = await requestBody(request);
      return json(response, 200, { tenantId: evidence.tenantId, runId: evidence.runId, objectKey: evidence.objectKey, checksumSha256: evidence.checksumSha256, bytes: evidence.bytes, durationSeconds: evidence.durationSeconds, startedAt: evidence.startedAt, endedAt: evidence.endedAt, retentionUntil: evidence.retentionUntil, objectVersion: "integration-recording-version-1", evidenceRef: `evidence://integration/recording/${evidence.objectKey}`, verifiedAt: new Date().toISOString() });
    }
    if (url.pathname === "/v1/channel-evidence/verify" && request.method === "POST") {
      assert.equal(request.headers.authorization, `Bearer ${channelEvidenceToken}`);
      const evidence = await requestBody(request);
      return json(response, 200, { channelConnectionId: evidence.channelConnectionId, configurationSha256: evidence.configurationSha256, evidenceRef: `evidence://integration/channel/${evidence.channelConnectionId}`, verifiedAt: new Date().toISOString() });
    }
    if (url.pathname === "/v1/media" && request.method === "POST") {
      assert.equal(request.headers.authorization, `Bearer ${gatewayToken}`);
      const command = await requestBody(request);
      mediaCommands.push(command);
      if (command.command_id.startsWith("fail_media_")) return json(response, 503, { error: "injected_delivery_failure" });
      return json(response, 200, { accepted: true, command_id: command.command_id, session_id: command.session_id, action: command.action, receipt: { command_id: command.command_id, session_id: command.session_id, action: command.action, program_segment_id: command.program_segment_id ?? null, accepted_at: new Date().toISOString(), evidence: "integration_gateway_accepted" } });
    }
    if (url.pathname === "/provider-reply-fixture" && request.method === "POST") {
      assert.equal(request.headers.authorization, "Bearer provider-reply-token-at-least-32-bytes");
      const reply = await requestBody(request);
      channelReplies.push(reply);
      return json(response, 200, { providerMessageId: `provider_${reply.replyId}` });
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
  return { server, mediaCommands, alertNotifications, channelReplies, baseUrl: `http://127.0.0.1:${address.port}` };
}

function json(response, status, value) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
function canonicalJson(value) { if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`; }
async function requestRawBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }
async function requestBody(request) { return JSON.parse(await requestRawBody(request)); }
async function availablePort() { const server = http.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); await new Promise((resolve) => server.close(resolve)); if (!address || typeof address === "string") throw new Error("could not reserve a TCP port"); return address.port; }
async function waitFor(predicate, timeoutMs, label) { const deadline = Date.now() + timeoutMs; let lastError; while (Date.now() < deadline) { try { if (await predicate()) return; } catch (error) { lastError = error; } await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`); }
async function stop(child) { if (!child || child.exitCode !== null) return; child.kill("SIGTERM"); await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
