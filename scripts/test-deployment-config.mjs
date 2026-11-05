import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { interpolate } from "./lib/compose-interpolation.mjs";
import { checkDockerignore, isExcluded, parseDockerignore } from "./lib/dockerignore.mjs";
import { checkComposePorts, checkRuntimeComposeConsistency, checkTemplateRequirements } from "./lib/runtime-compose-consistency.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(root, "scripts", "check-deployment-config.mjs");
const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-deploy-config-"));
const deploymentReleaseManifestPath = path.join(fixtureDirectory, "deployment-release-manifest.json");
const tenantId = "11111111-1111-4111-8111-111111111111";
const channelConnectionId = "22222222-2222-4222-8222-222222222222";
const runtimeToken = "runtime-shared-token-at-least-32-bytes";
const mediaEvidenceToken = "media-evidence-verifier-token-at-least-32-bytes";
const recordingEvidenceToken = "recording-evidence-verifier-token-at-least-32-bytes";
const channelEvidenceToken = "channel-evidence-verifier-token-at-least-32-bytes";
const telemetryToken = "telemetry-token-at-least-32-bytes";
const programOutputToken = "program-output-token-at-least-32-bytes";
const outputProbeToken = "output-probe-token-at-least-32-bytes";
const image = (name, digit) => `registry.internal/shuzhiren/${name}@sha256:${digit.repeat(64)}`;
const images = {
  controlPlane: image("control-plane", "0"),
  controlPlaneMigrator: image("control-plane-migrator", "1"),
  gateway: image("runtime-gateway", "2"),
  worker: image("runtime-worker", "3"),
  observer: image("runtime-observer", "4"),
  probe: image("output-probe", "5"),
  adapter: image("channel-adapter", "6"),
  notifier: image("alert-notifier", "7"),
  livetalking: image("livetalking", "8"),
  cosyvoice: image("cosyvoice", "9")
};
const releaseSigner = generateKeyPairSync("ed25519");
const releaseIssuer = "release_automation";
const releaseKeyId = "fixture-2026";
const releaseTrust = { [releaseIssuer]: { [releaseKeyId]: releaseSigner.publicKey.export({ type: "spki", format: "pem" }) } };
const releaseRevision = "a".repeat(40);
const releaseImages = {
  CONTROL_PLANE_IMAGE: images.controlPlane,
  CONTROL_PLANE_MIGRATOR_IMAGE: images.controlPlaneMigrator,
  RUNTIME_GATEWAY_IMAGE: images.gateway,
  RUNTIME_WORKER_IMAGE: images.worker,
  RUNTIME_OBSERVER_IMAGE: images.observer,
  OUTPUT_PROBE_IMAGE: images.probe,
  CHANNEL_ADAPTER_IMAGE: images.adapter,
  ALERT_NOTIFIER_IMAGE: images.notifier,
  LIVETALKING_IMAGE: images.livetalking,
  COSYVOICE_IMAGE: images.cosyvoice
};
const releaseEvidence = {
  sbom: `${JSON.stringify({ schemaVersion: 1, artifactType: "oci-buildx-sbom-index", releaseRevision, source: "https://github.com/shuzizhibo/shuzizhibo", images: releaseImages, attestationTransport: "oci-buildx-attached" })}\n`,
  provenance: `${JSON.stringify({ schemaVersion: 1, artifactType: "oci-buildx-provenance-index", releaseRevision, source: "https://github.com/shuzizhibo/shuzizhibo", images: releaseImages, attestationTransport: "oci-buildx-attached", builder: "github-actions-buildx" })}\n`
};
const releaseEvidenceSha256 = Object.fromEntries(Object.entries(releaseEvidence).map(([name, value]) => [name, `sha256:${createHash("sha256").update(value).digest("hex")}`]));
const commits = {
  MuseTalk: "0a89dec45a0192b824e3cf4daf96c239440c5ed8",
  CosyVoice: "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc",
  LiveTalking: "c7269433a2b6ecebcd9342445d2ecc882c98b0da"
};

function env(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n")}\n`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function deploymentReleaseManifest({ releaseRevision: manifestRevision = releaseRevision, manifestImages = undefined } = {}) {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000);
  const unsigned = {
    schemaVersion: 1,
    releaseRevision: manifestRevision,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    images: manifestImages ?? releaseImages,
    sbomSha256: releaseEvidenceSha256.sbom,
    provenanceSha256: releaseEvidenceSha256.provenance
  };
  return JSON.stringify({ ...unsigned, signature: { issuer: releaseIssuer, keyId: releaseKeyId, value: sign(null, Buffer.from(canonicalJson(unsigned)), releaseSigner.privateKey).toString("base64") } });
}

const control = env({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:fixture-password@postgres.internal:5432/shuzhiren",
  DATABASE_QUERY_TIMEOUT_MS: "5000",
  CONTROL_PLANE_DEMO_MODE: "false",
  RELEASE_REVISION: releaseRevision,
  DEPLOYMENT_RELEASE_MANIFEST: deploymentReleaseManifestPath,
  DEPLOYMENT_RELEASE_MANIFEST_TRUST: releaseTrust,
  OIDC_ISSUER_URL: "https://issuer.internal",
  OIDC_AUDIENCE: "shuzhiren-console",
  OIDC_JWKS_URL: "https://issuer.internal/jwks.json",
  OUTBOX_MAX_ATTEMPTS: "6",
  RUNTIME_GATEWAY_URL: "http://runtime-gateway.internal:8090",
  RUNTIME_SHARED_TOKEN: runtimeToken,
  RUNTIME_GATEWAY_DEMO_MODE: "false",
  RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS: "20000",
  MEDIA_EVIDENCE_VERIFIER_URL: "https://media-evidence.internal",
  MEDIA_EVIDENCE_VERIFIER_TOKEN: mediaEvidenceToken,
  MEDIA_EVIDENCE_VERIFIER_TIMEOUT_MS: "5000",
  RECORDING_EVIDENCE_VERIFIER_URL: "https://recording-evidence.internal",
  RECORDING_EVIDENCE_VERIFIER_TOKEN: recordingEvidenceToken,
  RECORDING_EVIDENCE_VERIFIER_TIMEOUT_MS: "5000",
  CHANNEL_EVIDENCE_VERIFIER_URL: "https://channel-evidence.internal",
  CHANNEL_EVIDENCE_VERIFIER_TOKEN: channelEvidenceToken,
  CHANNEL_EVIDENCE_VERIFIER_TIMEOUT_MS: "5000",
  RUNTIME_TELEMETRY_TENANT_TOKENS: { [tenantId]: telemetryToken },
  PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS: { [tenantId]: programOutputToken },
  PROGRAM_OUTPUT_VERIFIER_TRUST: { [tenantId]: { issuer: "watermark_verifier", keys: { "fixture-2026": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAx6+4e3XimNCIWqFItVRpuI4MZG36NG/ZkeWIAfIpwKg=\n-----END PUBLIC KEY-----\n" } } },
  RUNTIME_RECORDING_TENANT_TOKENS: { [tenantId]: "recording-token-at-least-32-bytes" },
  PIM_INGEST_TENANT_TOKENS: { [tenantId]: "pim-ingest-token-at-least-32-bytes" },
  CHANNEL_INGEST_TENANT_TOKENS: { [tenantId]: "channel-ingest-token-at-least-32-bytes" },
  CHANNEL_COMMERCE_TENANT_TOKENS: { [tenantId]: "commerce-ingest-token-at-least-32-bytes" },
  SETTLEMENT_INGEST_TENANT_TOKENS: { [tenantId]: "settlement-ingest-token-at-least-32" }
});

const controlCompose = env({
  CONTROL_PLANE_ENV_FILE: "/srv/shuzhiren/control.env",
  CONSOLE_HOST_BIND: "127.0.0.1",
  CONSOLE_PORT: "3000",
  CONTROL_PLANE_IMAGE: images.controlPlane,
  CONTROL_PLANE_MIGRATOR_IMAGE: images.controlPlaneMigrator
});

function runtime(outputProbeTargets, observerTargets = [{ tenantId, runId: "run_fixture", sessionId: "session_fixture", telemetryToken, programOutputToken, outputProbeUrl: "http://output-probe.internal:8081/v1/probes/fixture", outputProbeToken }]) {
  return env({
    NVIDIA_VISIBLE_DEVICES: "0",
    RUNTIME_GATEWAY_IMAGE: images.gateway,
    RUNTIME_WORKER_IMAGE: images.worker,
    RUNTIME_OBSERVER_IMAGE: images.observer,
    OUTPUT_PROBE_IMAGE: images.probe,
    CHANNEL_ADAPTER_IMAGE: images.adapter,
    ALERT_NOTIFIER_IMAGE: images.notifier,
    LIVETALKING_IMAGE: images.livetalking,
    COSYVOICE_IMAGE: images.cosyvoice,
    STREAM_OUTPUT_MODE: "rtmp",
    STREAM_RTMP_URL: "rtmp://ingest.internal/live",
    STREAM_KEY: "fixture-stream-key-not-a-placeholder",
    STREAM_FPS: "25",
    LIVETALKING_REF: commits.LiveTalking,
    MUSETALK_REF: commits.MuseTalk,
    COSYVOICE_REF: commits.CosyVoice,
    RUNTIME_GATEWAY_URL: "http://runtime-gateway:8090",
    RUNTIME_SHARED_TOKEN: runtimeToken,
    RUNTIME_GATEWAY_DEMO_MODE: "false",
    RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS: "20000",
    CHANNEL_ADAPTER_URL: "http://channel-adapter.internal:8082",
    CHANNEL_ADAPTER_DISPATCH_TOKEN: "channel-adapter-dispatch-token-at-least-32-bytes",
    RUNTIME_WORKER_DATABASE_URL: "postgresql://runtime_worker:fixture-password@postgres.internal:5432/shuzhiren",
    DATABASE_QUERY_TIMEOUT_MS: "5000",
    CONTROL_PLANE_URL: "https://control-plane.internal",
    RUNTIME_OBSERVER_TARGETS_DIR: "/srv/shuzhiren/observer-config",
    RUNTIME_OBSERVER_TARGETS: observerTargets,
    RUNTIME_OBSERVER_POLL_MS: "5000",
    RUNTIME_OBSERVER_TIMEOUT_MS: "3000",
    RUNTIME_OBSERVER_FAIL_CLOSED: "true",
    RUNTIME_OBSERVER_PORT: "8084",
    OUTPUT_PROBE_SHARED_TOKEN: outputProbeToken,
    OUTPUT_PROBE_TARGETS: outputProbeTargets,
    OUTPUT_PROBE_TIMEOUT_MS: "5000",
    OUTPUT_PROBE_CACHE_MS: "3000",
    OUTPUT_PROBE_AUDIO_SAMPLE_SECONDS: "5",
    OUTPUT_PROBE_SILENCE_DURATION_SECONDS: "2",
    OUTPUT_PROBE_SILENCE_THRESHOLD_DB: "-50",
    RUNTIME_WATCHDOG_POLL_MS: "5000",
    RUNTIME_WATCHDOG_BATCH_SIZE: "10",
    RUNTIME_TELEMETRY_MAX_AGE_SECONDS: "60",
    USAGE_METER_POLL_MS: "60000",
    PROGRAM_AUDIOTYPE: "0",
    FALLBACK_AUDIOTYPE: "1",
    HUMAN_HANDOFF_AUDIOTYPE: "2",
    OUTBOX_POLL_MS: "1000",
    SCHEDULER_POLL_MS: "1000",
    SCHEDULER_BATCH_SIZE: "10",
    OUTBOX_MAX_ATTEMPTS: "6",
    OUTBOX_LEASE_SECONDS: "60",
    OUTBOX_RETRY_BASE_MS: "1000",
    OUTBOX_RETRY_MAX_MS: "60000",
    RUNTIME_WORKER_PORT: "8080",
    LIVE_MAX_CONCURRENT_AVATARS: "1",
    LIVE_ALLOW_LLM_FREEFORM: "false",
    LIVE_REQUIRE_HUMAN_HANDOFF_FOR_HIGH_RISK: "true",
    LIVE_REQUIRE_AI_DISCLOSURE: "true",
    LLM_MODE: "external"
  });
}

const gateway = env({
  NVIDIA_VISIBLE_DEVICES: "0",
  RUNTIME_SHARED_TOKEN: runtimeToken,
  LIVETALKING_AVATAR_ID: "approved_avatar_fixture",
  MODEL_VOLUME_PATH: "/srv/models",
  AVATAR_VOLUME_PATH: "/srv/avatars",
  RECORDINGS_VOLUME_PATH: "/srv/recordings",
  COSYVOICE_REQUIRED: "true",
  COSYVOICE_SAMPLE_RATE: "24000",
  COSYVOICE_MODEL_DIR: "/opt/CosyVoice/CosyVoice/pretrained_models/Fun-CosyVoice3-0.5B-2512",
  COSYVOICE_MODEL_PATH: "/srv/cosyvoice-models",
  MEDIA_COMMAND_CACHE_TTL_SECONDS: "3600",
  MEDIA_COMMAND_CACHE_MAX_ENTRIES: "2048",
  RUNTIME_REQUEST_TIMEOUT_SECONDS: "15",
  RUNTIME_COMMAND_JOURNAL_PATH: "/var/lib/shuzhiren-runtime/commands.sqlite3",
  RUNTIME_COMMAND_JOURNAL_REQUIRED: "true",
  RUNTIME_GATEWAY_STATE_PATH: "/srv/shuzhiren/runtime-gateway-state",
  RUNTIME_GATEWAY_HOST_BIND: "127.0.0.1",
  PREVIEW_BROKER_URL: "",
  PREVIEW_BROKER_TOKEN: "",
  PREVIEW_GRANT_MAX_SECONDS: "600",
  STREAM_RTMP_URL: "rtmp://ingest.internal/live",
  STREAM_KEY: "fixture-stream-key-not-a-placeholder",
  PROGRAM_AUDIOTYPE: "0",
  FALLBACK_AUDIOTYPE: "1",
  HUMAN_HANDOFF_AUDIOTYPE: "2"
});

const channel = env({
  CHANNEL_ADAPTER_DATABASE_URL: "postgresql://channel_adapter:fixture-password@postgres.internal:5432/shuzhiren",
  DATABASE_QUERY_TIMEOUT_MS: "5000",
  CONTROL_PLANE_URL: "https://control-plane.internal",
  CHANNEL_ADAPTER_PORT: "8082",
  CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS: "60",
  CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE: "120",
  CHANNEL_ADAPTER_DISPATCH_TOKEN: "channel-adapter-dispatch-token-at-least-32-bytes",
  CHANNEL_ADAPTER_TARGETS: [{ tenantId, channelConnectionId, signingSecret: "channel-signing-secret-at-least-32-bytes", interactionToken: "channel-ingest-token-at-least-32-bytes", commerceToken: "commerce-ingest-token-at-least-32-bytes", providerReplyEndpoint: "https://provider-bridge.internal/v1/replies", providerReplyToken: "provider-reply-token-at-least-32-bytes" }]
});

const alert = env({
  ALERT_NOTIFIER_DATABASE_URL: "postgresql://alert_notifier:fixture-password@postgres.internal:5432/shuzhiren",
  DATABASE_QUERY_TIMEOUT_MS: "5000",
  ALERT_NOTIFIER_PORT: "8083",
  ALERT_NOTIFIER_POLL_MS: "5000",
  ALERT_NOTIFIER_LEASE_SECONDS: "60",
  ALERT_NOTIFIER_MAX_ATTEMPTS: "6",
  ALERT_NOTIFIER_RETRY_BASE_MS: "1000",
  ALERT_NOTIFIER_RETRY_MAX_MS: "60000",
  ALERT_NOTIFIER_TARGETS: [{ id: "fixture-oncall", tenantId, webhookUrl: "https://alerts.internal/events", signingSecret: "alert-signing-secret-at-least-32-bytes", minimumSeverity: "warning" }]
});

const files = {
  control: path.join(fixtureDirectory, "control.env"),
  releaseManifest: deploymentReleaseManifestPath,
  releaseSbom: path.join(fixtureDirectory, "release-sbom-index.json"),
  releaseProvenance: path.join(fixtureDirectory, "release-provenance-index.json"),
  controlCompose: path.join(fixtureDirectory, "control-compose.env"),
  runtime: path.join(fixtureDirectory, "runtime.env"),
  gateway: path.join(fixtureDirectory, "gateway.env"),
  channel: path.join(fixtureDirectory, "channel.env"),
  alert: path.join(fixtureDirectory, "alert.env")
};

function check(options = []) {
  return spawnSync(process.execPath, [checker, "--control", files.control, "--control-compose", files.controlCompose, "--runtime", files.runtime, "--gateway", files.gateway, "--channel-adapter", files.channel, "--alert-notifier", files.alert, "--source-root", root, "--require-output-probe", ...options], { cwd: root, encoding: "utf8" });
}

try {
  const validProbeTarget = [{ id: "fixture", streamUrl: "rtmp://relay.internal/live/fixture", avSyncProbeUrl: "https://av-sync.internal/fixture", expectedFps: 25, expectedWidth: 1280, expectedHeight: 720 }];
  await Promise.all([writeFile(files.control, control), writeFile(files.releaseManifest, deploymentReleaseManifest()), writeFile(files.releaseSbom, releaseEvidence.sbom), writeFile(files.releaseProvenance, releaseEvidence.provenance), writeFile(files.controlCompose, controlCompose), writeFile(files.runtime, runtime(validProbeTarget)), writeFile(files.gateway, gateway), writeFile(files.channel, channel), writeFile(files.alert, alert)]);
  const valid = check(["--require-cosyvoice"]);
  assert.equal(valid.status, 0, `valid deployment config failed:\n${valid.stderr}\n${valid.stdout}`);

  await writeFile(files.releaseSbom, "tampered\n");
  const invalidReleaseEvidence = check(["--require-cosyvoice"]);
  assert.notEqual(invalidReleaseEvidence.status, 0, "deployment manifests must reject tampered release evidence indexes");
  assert.match(invalidReleaseEvidence.stderr, /release-sbom-index\.json SHA-256 不匹配/, "tampered release evidence must identify the signed artifact gate");
  await writeFile(files.releaseSbom, releaseEvidence.sbom);

  const tamperedManifest = JSON.parse(deploymentReleaseManifest());
  tamperedManifest.signature.value = "AA==";
  await writeFile(files.releaseManifest, JSON.stringify(tamperedManifest));
  const invalidManifestSignature = check(["--require-cosyvoice"]);
  assert.notEqual(invalidManifestSignature.status, 0, "deployment manifests must reject tampered signatures");
  assert.match(invalidManifestSignature.stderr, /Ed25519 签名无效/, "tampered signature rejection must identify the release-signature gate");
  await writeFile(files.releaseManifest, deploymentReleaseManifest());

  await writeFile(files.releaseManifest, deploymentReleaseManifest({ releaseRevision: "b".repeat(40) }));
  const manifestRevisionMismatch = check(["--require-cosyvoice"]);
  assert.notEqual(manifestRevisionMismatch.status, 0, "signed manifests must bind the deployed source revision");
  assert.match(manifestRevisionMismatch.stderr, /releaseRevision 必须匹配 RELEASE_REVISION/, "manifest revision mismatch must identify the release binding gate");
  await writeFile(files.releaseManifest, deploymentReleaseManifest());

  await writeFile(files.runtime, runtime(validProbeTarget).replace(images.gateway, "registry.internal/shuzhiren/runtime-gateway:latest"));
  const floatingRuntimeImage = check(["--require-cosyvoice"]);
  assert.notEqual(floatingRuntimeImage.status, 0, "production deployments must reject floating image tags");
  assert.match(floatingRuntimeImage.stderr, /RUNTIME_GATEWAY_IMAGE.*不可变镜像引用/, "floating image rejection must identify the immutable-image gate");
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.controlCompose, controlCompose.replace(images.controlPlaneMigrator, images.controlPlane));
  const reusedImage = check(["--require-cosyvoice"]);
  assert.notEqual(reusedImage.status, 0, "production services must not reuse an unrelated image digest");
  assert.match(reusedImage.stderr, /各自独立的不可变镜像摘要/, "image digest reuse must identify the deployment-image gate");
  await writeFile(files.controlCompose, controlCompose);

  await writeFile(files.channel, channel.replace("postgresql://channel_adapter:fixture-password", "postgresql://runtime_worker:fixture-password"));
  const reusedDatabasePrincipal = check(["--require-cosyvoice"]);
  assert.notEqual(reusedDatabasePrincipal.status, 0, "service deployments must not reuse a database principal");
  assert.match(reusedDatabasePrincipal.stderr, /四个不同的 PostgreSQL 用户名/, "database-principal reuse must identify the least-privilege deployment gate");
  await writeFile(files.channel, channel);

  await writeFile(files.control, control.replace("DATABASE_QUERY_TIMEOUT_MS=5000", "DATABASE_QUERY_TIMEOUT_MS=61000"));
  const excessiveDatabaseTimeout = check(["--require-cosyvoice"]);
  assert.notEqual(excessiveDatabaseTimeout.status, 0, "control-plane database timeout must remain bounded for health checks");
  assert.match(excessiveDatabaseTimeout.stderr, /DATABASE_QUERY_TIMEOUT_MS/, "database timeout rejection must identify the readiness gate");
  await writeFile(files.control, control);

  await writeFile(files.control, control.replace(`RELEASE_REVISION=${releaseRevision}`, "RELEASE_REVISION=not-a-git-revision"));
  const invalidReleaseRevision = check(["--require-cosyvoice"]);
  assert.notEqual(invalidReleaseRevision.status, 0, "production deployments must expose an immutable control-plane source revision");
  assert.match(invalidReleaseRevision.stderr, /RELEASE_REVISION/, "release revision rejection must identify the traceability gate");
  await writeFile(files.control, control);

  await writeFile(files.control, control.replace("OUTBOX_MAX_ATTEMPTS=6", "OUTBOX_MAX_ATTEMPTS=4"));
  const mismatchedOutboxAttempts = check(["--require-cosyvoice"]);
  assert.notEqual(mismatchedOutboxAttempts.status, 0, "control-plane and runtime retry limits must match");
  assert.match(mismatchedOutboxAttempts.stderr, /OUTBOX_MAX_ATTEMPTS/, "retry-limit mismatch must identify the shared outbox gate");
  await writeFile(files.control, control);

  await writeFile(files.control, control.replace(runtimeToken, "different-control-gateway-token-at-least-32"));
  const mismatchedControlGatewayToken = check(["--require-cosyvoice"]);
  assert.notEqual(mismatchedControlGatewayToken.status, 0, "control-plane and runtime Gateway credentials must match");
  assert.match(mismatchedControlGatewayToken.stderr, /控制面与运行时的 RUNTIME_SHARED_TOKEN/, "Gateway credential mismatch must identify the control-plane delivery gate");
  await writeFile(files.control, control);

  await writeFile(files.control, control.replace("RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS=20000", "RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS=15000"));
  const mismatchedGatewayTimeout = check(["--require-cosyvoice"]);
  assert.notEqual(mismatchedGatewayTimeout.status, 0, "control-plane and runtime Gateway timeouts must match");
  assert.match(mismatchedGatewayTimeout.stderr, /RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS/, "Gateway timeout mismatch must identify the shared delivery gate");
  await writeFile(files.control, control);

  await writeFile(files.control, control.replace(mediaEvidenceToken, "short"));
  const shortMediaEvidenceToken = check(["--require-cosyvoice"]);
  assert.notEqual(shortMediaEvidenceToken.status, 0, "media evidence verification must reject a short private credential");
  assert.match(shortMediaEvidenceToken.stderr, /MEDIA_EVIDENCE_VERIFIER_TOKEN/, "media evidence credential rejection must identify the object-verification gate");
  await writeFile(files.control, control);

  await writeFile(files.control, control.replace(recordingEvidenceToken, mediaEvidenceToken));
  const reusedRecordingEvidenceToken = check(["--require-cosyvoice"]);
  assert.notEqual(reusedRecordingEvidenceToken.status, 0, "recording evidence verification must use a separate private credential");
  assert.match(reusedRecordingEvidenceToken.stderr, /私网服务 token 不得跨服务或跨租户复用/, "recording evidence token reuse must identify the verifier boundary");
  await writeFile(files.control, control);

  await writeFile(files.control, control.replace("https://media-evidence.internal", "rtmp://media-evidence.internal"));
  const unsafeMediaEvidenceUrl = check(["--require-cosyvoice"]);
  assert.notEqual(unsafeMediaEvidenceUrl.status, 0, "media evidence verification must use a credential-free HTTPS endpoint");
  assert.match(unsafeMediaEvidenceUrl.stderr, /MEDIA_EVIDENCE_VERIFIER_URL/, "media evidence URL rejection must identify the object-verification gate");
  await writeFile(files.control, control);

  await writeFile(files.control, control.replace("commerce-ingest-token-at-least-32-bytes", telemetryToken));
  const reusedServiceToken = check(["--require-cosyvoice"]);
  assert.notEqual(reusedServiceToken.status, 0, "private service tokens must not be reused across ingestion boundaries");
  assert.match(reusedServiceToken.stderr, /不得跨服务或跨租户复用/, "service-token reuse must identify the least-privilege deployment gate");
  await writeFile(files.control, control);

  await writeFile(files.runtime, runtime(validProbeTarget).replaceAll(runtimeToken, "short"));
  await writeFile(files.gateway, gateway.replaceAll(runtimeToken, "short"));
  const shortRuntimeToken = check(["--require-cosyvoice"]);
  assert.notEqual(shortRuntimeToken.status, 0, "runtime Gateway authentication must reject a short shared token");
  assert.match(shortRuntimeToken.stderr, /RUNTIME_SHARED_TOKEN/, "short runtime token rejection must identify the shared-token gate");
  await writeFile(files.runtime, runtime(validProbeTarget));
  await writeFile(files.gateway, gateway);

  await writeFile(files.gateway, gateway.replace("FALLBACK_AUDIOTYPE=1", "FALLBACK_AUDIOTYPE=0"));
  const duplicateGatewayActionSlot = check(["--require-cosyvoice"]);
  assert.notEqual(duplicateGatewayActionSlot.status, 0, "Gateway deployment must reject reused program and fallback action slots");
  assert.match(duplicateGatewayActionSlot.stderr, /动作索引必须互不相同/, "duplicate Gateway action slots must identify the media handoff gate");
  await writeFile(files.gateway, gateway);

  await writeFile(files.runtime, runtime(validProbeTarget).replace("HUMAN_HANDOFF_AUDIOTYPE=2", "HUMAN_HANDOFF_AUDIOTYPE=256"));
  const outOfRangeRuntimeActionSlot = check(["--require-cosyvoice"]);
  assert.notEqual(outOfRangeRuntimeActionSlot.status, 0, "runtime deployment must reject out-of-range human handoff action slots");
  assert.match(outOfRangeRuntimeActionSlot.stderr, /动作索引必须是 0 至 255/, "out-of-range runtime action slots must identify the media handoff gate");
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.channel, channel.replace("DATABASE_QUERY_TIMEOUT_MS=5000", "DATABASE_QUERY_TIMEOUT_MS=99"));
  const shortAdapterDatabaseTimeout = check(["--require-cosyvoice"]);
  assert.notEqual(shortAdapterDatabaseTimeout.status, 0, "channel adapter database timeout must remain bounded");
  assert.match(shortAdapterDatabaseTimeout.stderr, /渠道适配器.*DATABASE_QUERY_TIMEOUT_MS/, "channel adapter database timeout rejection must identify the durable replay gate");
  await writeFile(files.channel, channel);

  await writeFile(files.channel, channel.replace("https://control-plane.internal", "https://operator:password@control-plane.internal"));
  const adapterControlPlaneCredentials = check(["--require-cosyvoice"]);
  assert.notEqual(adapterControlPlaneCredentials.status, 0, "channel adapter control-plane URL must not embed credentials");
  assert.match(adapterControlPlaneCredentials.stderr, /CONTROL_PLANE_URL.*嵌入凭据/, "embedded control-plane credentials must identify the channel adapter URL gate");
  await writeFile(files.channel, channel);

  await writeFile(files.channel, channel.replace("https://control-plane.internal", "ftp://control-plane.internal"));
  const adapterControlPlaneProtocol = check(["--require-cosyvoice"]);
  assert.notEqual(adapterControlPlaneProtocol.status, 0, "channel adapter control-plane URL must use HTTP(S)");
  assert.match(adapterControlPlaneProtocol.stderr, /CONTROL_PLANE_URL.*HTTP\(S\)/, "control-plane protocol rejection must identify the channel adapter URL gate");
  await writeFile(files.channel, channel);

  await writeFile(files.channel, channel.replace("https://provider-bridge.internal/v1/replies", "http://provider-bridge.internal/v1/replies"));
  const adapterProviderReplyHttp = check(["--require-cosyvoice"]);
  assert.notEqual(adapterProviderReplyHttp.status, 0, "production channel adapter provider replies must use HTTPS");
  assert.match(adapterProviderReplyHttp.stderr, /HTTPS providerReplyEndpoint/, "provider reply transport rejection must identify the deployment gate");
  await writeFile(files.channel, channel);

  await writeFile(files.channel, channel.replace("https://provider-bridge.internal/v1/replies", "https://operator:password@provider-bridge.internal/v1/replies"));
  const adapterProviderReplyCredentials = check(["--require-cosyvoice"]);
  assert.notEqual(adapterProviderReplyCredentials.status, 0, "channel adapter provider reply URLs must not embed credentials");
  assert.match(adapterProviderReplyCredentials.stderr, /HTTPS providerReplyEndpoint/, "provider reply credential rejection must identify the deployment gate");
  await writeFile(files.channel, channel);

  await writeFile(files.runtime, runtime(validProbeTarget).replace("RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS=20000", "RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS=61000"));
  const excessiveGatewayTimeout = check(["--require-cosyvoice"]);
  assert.notEqual(excessiveGatewayTimeout.status, 0, "runtime Gateway delivery timeout must remain bounded");
  assert.match(excessiveGatewayTimeout.stderr, /RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS/, "Gateway delivery timeout rejection must identify the outbox gate");
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.runtime, runtime(validProbeTarget).replaceAll(outputProbeToken, runtimeToken));
  const reusedOutputProbeToken = check(["--require-cosyvoice"]);
  assert.notEqual(reusedOutputProbeToken.status, 0, "output probe credentials must not reuse the runtime Gateway token");
  assert.match(reusedOutputProbeToken.stderr, /不得跨服务或跨租户复用/, "output probe token reuse must identify the least-privilege deployment gate");
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.channel, channel.replace("channel-ingest-token-at-least-32-bytes", "wrong-interaction-token-at-least-32"));
  const mismatchedAdapterToken = check(["--require-cosyvoice"]);
  assert.notEqual(mismatchedAdapterToken.status, 0, "channel adapter interaction credentials must match the control-plane tenant token");
  assert.match(mismatchedAdapterToken.stderr, /interactionToken 必须匹配/, "adapter credential mismatch must identify the interaction token gate");
  await writeFile(files.channel, channel);

  await writeFile(files.channel, channel.replace("commerce-ingest-token-at-least-32-bytes", "wrong-commerce-token-at-least-32-byte"));
  const mismatchedCommerceToken = check(["--require-cosyvoice"]);
  assert.notEqual(mismatchedCommerceToken.status, 0, "channel adapter commerce credentials must match the control-plane tenant token");
  assert.match(mismatchedCommerceToken.stderr, /commerceToken 必须匹配/, "adapter credential mismatch must identify the commerce token gate");
  await writeFile(files.channel, channel);

  await writeFile(files.runtime, runtime(validProbeTarget).replace(telemetryToken, "wrong-observer-token-at-least-32-byte"));
  const mismatchedObserverToken = check(["--require-cosyvoice"]);
  assert.notEqual(mismatchedObserverToken.status, 0, "runtime observer credentials must match the control-plane tenant telemetry token");
  assert.match(mismatchedObserverToken.stderr, /observer 的 telemetryToken 必须匹配/, "observer credential mismatch must identify the telemetry token gate");
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.runtime, runtime(validProbeTarget).replace(outputProbeToken, "wrong-output-probe-token-at-least-32"));
  const mismatchedProbeToken = check(["--require-cosyvoice"]);
  assert.notEqual(mismatchedProbeToken.status, 0, "runtime observer output-probe credentials must match the probe service token");
  assert.match(mismatchedProbeToken.stderr, /outputProbeToken 必须匹配/, "probe credential mismatch must identify the output-probe token gate");
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.runtime, runtime(validProbeTarget, [
    { tenantId, runId: "run_fixture", sessionId: "session_fixture", telemetryToken, outputProbeUrl: "http://output-probe.internal:8081/v1/probes/fixture", outputProbeToken },
    { tenantId, runId: "run_fixture", sessionId: "session_other", telemetryToken, outputProbeUrl: "http://output-probe.internal:8081/v1/probes/other", outputProbeToken }
  ]));
  const duplicateObserverRun = check(["--require-cosyvoice"]);
  assert.notEqual(duplicateObserverRun.status, 0, "deployment preflight must reject duplicate observer run targets");
  assert.match(duplicateObserverRun.stderr, /RUNTIME_OBSERVER_TARGETS/, "duplicate observer targets must identify the observer configuration gate");
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.runtime, runtime(validProbeTarget).replace("RUNTIME_GATEWAY_DEMO_MODE=false", "RUNTIME_GATEWAY_DEMO_MODE=true"));
  const demoGateway = check(["--require-cosyvoice"]);
  assert.notEqual(demoGateway.status, 0, "production deployment must reject runtime gateway demo mode");
  assert.match(demoGateway.stderr, /RUNTIME_GATEWAY_DEMO_MODE/, "demo gateway rejection must identify the runtime gate");
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.gateway, gateway.replace("COSYVOICE_REQUIRED=true", "COSYVOICE_REQUIRED=false"));
  const missingCosyVoice = check(["--require-cosyvoice"]);
  assert.notEqual(missingCosyVoice.status, 0, "a realtime speech deployment must require CosyVoice health");
  assert.match(missingCosyVoice.stderr, /COSYVOICE_REQUIRED/, "missing CosyVoice requirement must identify the gateway gate");
  await writeFile(files.gateway, gateway);

  await writeFile(files.gateway, gateway.replace("RUNTIME_COMMAND_JOURNAL_REQUIRED=true", "RUNTIME_COMMAND_JOURNAL_REQUIRED=false"));
  const optionalCommandJournal = check(["--require-cosyvoice"]);
  assert.notEqual(optionalCommandJournal.status, 0, "production Gateway must require durable command journal storage");
  assert.match(optionalCommandJournal.stderr, /RUNTIME_COMMAND_JOURNAL_REQUIRED/, "command journal rejection must identify the production reliability gate");
  await writeFile(files.gateway, gateway);

  await writeFile(files.gateway, gateway.replace("RUNTIME_COMMAND_JOURNAL_PATH=/var/lib/shuzhiren-runtime/commands.sqlite3", "RUNTIME_COMMAND_JOURNAL_PATH=relative/commands.sqlite3"));
  const relativeCommandJournal = check(["--require-cosyvoice"]);
  assert.notEqual(relativeCommandJournal.status, 0, "production Gateway command journal path must be absolute");
  assert.match(relativeCommandJournal.stderr, /RUNTIME_COMMAND_JOURNAL_PATH/, "relative command journal path rejection must identify the persistence gate");
  await writeFile(files.gateway, gateway);

  await writeFile(files.gateway, gateway.replace("RUNTIME_GATEWAY_STATE_PATH=/srv/shuzhiren/runtime-gateway-state", "RUNTIME_GATEWAY_STATE_PATH=relative/runtime-gateway-state"));
  const relativeGatewayState = check(["--require-cosyvoice"]);
  assert.notEqual(relativeGatewayState.status, 0, "production Gateway state path must be an absolute managed host path");
  assert.match(relativeGatewayState.stderr, /RUNTIME_GATEWAY_STATE_PATH/, "relative Gateway state path rejection must identify the host persistence gate");
  await writeFile(files.gateway, gateway);

  await writeFile(files.gateway, gateway.replace("RUNTIME_GATEWAY_HOST_BIND=127.0.0.1", "RUNTIME_GATEWAY_HOST_BIND=0.0.0.0"));
  const publicGatewayBind = check(["--require-cosyvoice"]);
  assert.notEqual(publicGatewayBind.status, 0, "production Gateway must reject an all-interface host port binding");
  assert.match(publicGatewayBind.stderr, /RUNTIME_GATEWAY_HOST_BIND/, "public Gateway binding rejection must identify the network exposure gate");
  await writeFile(files.gateway, gateway);

  await writeFile(files.gateway, gateway.replace("PREVIEW_GRANT_MAX_SECONDS=600", "PREVIEW_GRANT_MAX_SECONDS=600\nPREVIEW_BROKER_URL=https://preview.internal"));
  const incompletePreviewBroker = check(["--require-cosyvoice"]);
  assert.notEqual(incompletePreviewBroker.status, 0, "a configured preview broker must have a distinct private credential");
  assert.match(incompletePreviewBroker.stderr, /PREVIEW_BROKER_URL 与 PREVIEW_BROKER_TOKEN/, "incomplete preview broker must identify the controlled-preview configuration gate");
  await writeFile(files.gateway, gateway);

  await writeFile(files.gateway, gateway.replace("PREVIEW_GRANT_MAX_SECONDS=600", "PREVIEW_GRANT_MAX_SECONDS=600\nPREVIEW_BROKER_URL=rtmp://preview.internal\nPREVIEW_BROKER_TOKEN=preview-broker-token-at-least-32-bytes"));
  const unsafePreviewBroker = check(["--require-cosyvoice"]);
  assert.notEqual(unsafePreviewBroker.status, 0, "a preview broker must use a credential-free HTTPS endpoint");
  assert.match(unsafePreviewBroker.stderr, /PREVIEW_BROKER_URL/, "unsafe preview broker must identify the controlled-preview URL gate");
  await writeFile(files.gateway, gateway);

  // M7: Compose hard-coded OUTBOX_MAX_ATTEMPTS: 6, so a matching control/runtime value of 4 passed the
  // preflight while the worker still ran with 6. The consistency check reports such literals.
  const fileOf = (id, text) => ({ id, path: `/fixture/${id}.env`, values: new Map(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])) });
  const legacyWorker = yaml.load("services:\n  runtime-worker:\n    environment:\n      OUTBOX_MAX_ATTEMPTS: 6\n");
  assert.deepEqual(checkRuntimeComposeConsistency({ composeDoc: legacyWorker, envFiles: [fileOf("runtime", "OUTBOX_MAX_ATTEMPTS=4")] }).errors.map((error) => error.code), ["RC-LITERAL"], "a hard-coded Compose value that an env file also sets must be reported");
  const runtimeComposeDoc = yaml.load(await readFile(path.join(root, "infra", "compose", "docker-compose.runtime.yml"), "utf8"));
  const workerEnvironment = runtimeComposeDoc.services["runtime-worker"].environment;
  const fourAttempts = new Map([["OUTBOX_MAX_ATTEMPTS", "4"], ["OUTBOX_POLL_MS", "1100"], ["SCHEDULER_POLL_MS", "1200"], ["SCHEDULER_BATCH_SIZE", "11"]]);
  for (const [key, value] of fourAttempts) assert.equal(interpolate(String(workerEnvironment[key]), fourAttempts), value, `runtime-worker ${key} must come from the runtime env file`);
  assert.equal(interpolate(String(runtimeComposeDoc.services["runtime-gateway"].environment.RUNTIME_REQUEST_TIMEOUT_SECONDS), new Map([["RUNTIME_REQUEST_TIMEOUT_SECONDS", "17"]])), "17", "the Gateway upstream timeout must come from the Gateway env file");
  await writeFile(files.control, control.replace("OUTBOX_MAX_ATTEMPTS=6", "OUTBOX_MAX_ATTEMPTS=4"));
  await writeFile(files.runtime, runtime(validProbeTarget).replace("OUTBOX_MAX_ATTEMPTS=6", "OUTBOX_MAX_ATTEMPTS=4"));
  const changedOutboxAttempts = check(["--require-cosyvoice"]);
  assert.equal(changedOutboxAttempts.status, 0, `a consistent OUTBOX_MAX_ATTEMPTS change must pass because Compose now forwards it:\n${changedOutboxAttempts.stderr}`);
  await writeFile(files.control, control);
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.runtime, runtime(validProbeTarget).replace("RUNTIME_GATEWAY_URL=http://runtime-gateway:8090", "RUNTIME_GATEWAY_URL=http://10.0.0.9:8090"));
  const overriddenLiteral = check(["--require-cosyvoice"]);
  assert.notEqual(overriddenLiteral.status, 0, "an env value that Compose silently ignores must fail the preflight");
  assert.match(overriddenLiteral.stderr, /\[RC-LITERAL\][^\n]*runtime-worker[^\n]*RUNTIME_GATEWAY_URL/, "the literal override must name the service and key");
  assert.doesNotMatch(overriddenLiteral.stderr, /10\.0\.0\.9/, "consistency errors must not print env values");
  await writeFile(files.runtime, runtime(validProbeTarget));

  await writeFile(files.alert, alert.replace("DATABASE_QUERY_TIMEOUT_MS=5000", "DATABASE_QUERY_TIMEOUT_MS=4000"));
  const conflictingTimeout = check(["--require-cosyvoice"]);
  assert.notEqual(conflictingTimeout.status, 0, "one Compose variable defined differently in two env files must fail the preflight");
  assert.match(conflictingTimeout.stderr, /\[RC-CONFLICT\][^\n]*DATABASE_QUERY_TIMEOUT_MS/, "the conflict must name the variable");
  assert.doesNotMatch(conflictingTimeout.stderr.split("\n").filter((line) => line.includes("[RC-CONFLICT]")).join("\n"), /4000|5000/, "conflict errors must not print env values");
  await writeFile(files.alert, alert);

  await writeFile(files.runtime, runtime(validProbeTarget).replace(/^OUTPUT_PROBE_CACHE_MS=.*\n/m, ""));
  const undefinedVariable = check(["--require-cosyvoice"]);
  assert.notEqual(undefinedVariable.status, 0, "a Compose variable missing from every env file must fail the preflight");
  assert.match(undefinedVariable.stderr, /\[RC-UNDEFINED\][^\n]*output-probe[^\n]*OUTPUT_PROBE_CACHE_MS/, "the undefined variable must name the service");
  await writeFile(files.runtime, runtime(validProbeTarget));

  // L10: the worker's adapter URL must use the port the adapter listens on.
  await writeFile(files.runtime, runtime(validProbeTarget).replace("CHANNEL_ADAPTER_URL=http://channel-adapter.internal:8082", "CHANNEL_ADAPTER_URL=http://channel-adapter:9000"));
  const mismatchedAdapterPort = check(["--require-cosyvoice"]);
  assert.notEqual(mismatchedAdapterPort.status, 0, "an adapter URL on a port the adapter does not listen on must fail the preflight");
  assert.match(mismatchedAdapterPort.stderr, /\[RC-CHANNEL-PORT\][^\n]*9000[^\n]*8082/, "the port mismatch must name both ports");
  await writeFile(files.runtime, runtime(validProbeTarget));
  const portDefaults = new Map([["RUNTIME_WORKER_PORT", "18080"], ["RUNTIME_OBSERVER_PORT", "18084"], ["CHANNEL_ADAPTER_PORT", "18082"], ["ALERT_NOTIFIER_PORT", "18083"]]);
  for (const [service, variable] of [["runtime-worker", "RUNTIME_WORKER_PORT"], ["runtime-observer", "RUNTIME_OBSERVER_PORT"], ["channel-adapter", "CHANNEL_ADAPTER_PORT"], ["alert-notifier", "ALERT_NOTIFIER_PORT"]]) {
    const definition = runtimeComposeDoc.services[service];
    const port = portDefaults.get(variable);
    assert.equal(interpolate(String(definition.environment[variable]), portDefaults), port, `${service} must listen on ${variable}`);
    assert.deepEqual(definition.expose.map((entry) => interpolate(String(entry), portDefaults)), [port], `${service} must expose ${variable}`);
    assert.match(interpolate(definition.healthcheck.test.join(" "), portDefaults), new RegExp(`localhost:${port}/healthz`), `${service} must health-check ${variable}`);
  }
  assert.equal(interpolate(String(runtimeComposeDoc.services["runtime-worker"].environment.CHANNEL_ADAPTER_URL), portDefaults), "http://channel-adapter:18082", "the default adapter URL must follow CHANNEL_ADAPTER_PORT");
  assert.deepEqual(checkComposePorts(yaml.load("services:\n  runtime-worker:\n    environment:\n      RUNTIME_WORKER_PORT: ${RUNTIME_WORKER_PORT:-8080}\n    expose: [\"8080\"]\n    healthcheck:\n      test: [\"CMD\", \"node\", \"-e\", \"fetch('http://localhost:8080/healthz')\"]\n")).errors.map((error) => error.code), ["RCT-PORT", "RCT-PORT"], "a hard-coded expose and health-check port must be reported");

  // L11: required Compose variables must name the template that defines them.
  const hintDoc = yaml.load("services:\n  livetalking:\n    command: run --avatar ${LIVETALKING_AVATAR_ID:?set-in-runtime-env} --model ${MODEL_DIR:?set-in-runtime-gateway-env}\n");
  const hintTemplates = { runtime: new Map(), "runtime-gateway": new Map([["LIVETALKING_AVATAR_ID", "approved_avatar"]]), "channel-adapter": new Map(), "alert-notifier": new Map() };
  assert.deepEqual(checkTemplateRequirements({ composeDoc: hintDoc, templates: hintTemplates }).errors.map((error) => `${error.code} ${error.message.split(" ")[0]}`), ["RCT-HINT LIVETALKING_AVATAR_ID", "RCT-HINT MODEL_DIR", "RCT-REQUIRED MODEL_DIR"], "wrong template hints and undefined required variables must be reported");

  // M23: root-anchored rules followed by `!vendor/LiveTalking/**` re-included submodule secrets and data.
  const legacyLiveTalkingIgnore = ".git\n.env\n.env.*\nsecrets\nmodels\ndata\n*.log\nvendor/*\n!vendor/LiveTalking\n!vendor/LiveTalking/**\nvendor/LiveTalking/.git\nvendor/LiveTalking/.git/**\nruntime/*\n!runtime/patches\n!runtime/patches/livetalking-observability.patch\n";
  const sensitiveContextPaths = ["vendor/LiveTalking/.env", "vendor/LiveTalking/models/put models here.txt", "vendor/LiveTalking/data/custom_config.json", "vendor/LiveTalking/livetalking.log", "vendor/LiveTalking/secrets/stream-key"];
  assert.deepEqual(checkDockerignore(legacyLiveTalkingIgnore, { mustExclude: sensitiveContextPaths }).leaked, sensitiveContextPaths, "the dockerignore model must reproduce the M23 leak of the legacy rules");
  const liveTalkingIgnore = await readFile(path.join(root, "runtime", "livetalking", "Dockerfile.dockerignore"), "utf8");
  assert.deepEqual(checkDockerignore(liveTalkingIgnore, { mustExclude: [...sensitiveContextPaths, "vendor/LiveTalking/.git/config", "vendor/CosyVoice/requirements.txt", "config/runtime.example.env"], mustInclude: ["vendor/LiveTalking/app.py", "vendor/LiveTalking/avatars/musetalk/models/unet.py", "runtime/patches/livetalking-observability.patch"] }), { leaked: [], missing: [] }, "the LiveTalking build context must keep only the locked source and its patches");
  const dockerignoreRules = parseDockerignore("*\n!keep/**\n**/.env\n!**/.env.example\n");
  assert.equal(isExcluded(dockerignoreRules, "keep/a/.env"), true, "later exclusion rules must win over the allow list");
  assert.equal(isExcluded(dockerignoreRules, "keep/a/.env.example"), false, "a later exception must re-include the example file");
  assert.equal(isExcluded(dockerignoreRules, "other/file"), true, "a parent-directory match must exclude nested files");

  await writeFile(files.runtime, runtime([{ ...validProbeTarget[0], expectedHeight: undefined }]));
  const invalid = check();
  assert.notEqual(invalid.status, 0, "output probe with only expectedWidth must be rejected");
  assert.match(invalid.stderr, /OUTPUT_PROBE_TARGETS/, "invalid output probe error must identify the deployment gate");
  console.log("PASS  deployment configuration validates required output-probe and CosyVoice targets");
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true });
}
