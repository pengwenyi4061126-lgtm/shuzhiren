import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { aigcLabelBuildProblems, aigcLabelComposeProblems, aigcLabelTextProblem } from "./lib/aigc-label.mjs";
import { interpolate } from "./lib/compose-interpolation.mjs";
import { checkDockerignore, isExcluded, parseDockerignore } from "./lib/dockerignore.mjs";
import { checkPatchSeries } from "./lib/livetalking-patches.mjs";
import { parseEnvFile } from "./lib/compose-interpolation.mjs";
import { checkComposePorts, checkObserverCredentials, checkRuntimeComposeConsistency, checkRuntimeComposeIsolation, checkTemplateRequirements, liveTalkingCapacityComposeProblems, liveTalkingTtsComposeProblems, streamKeyComposeProblems } from "./lib/runtime-compose-consistency.mjs";

function findPython() {
  const requested = process.env.PYTHON?.trim();
  const candidates = requested ? [requested] : process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
  for (const command of candidates) {
    const probe = spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return command;
  }
  return undefined;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(root, "scripts", "check-deployment-config.mjs");
const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-deploy-config-"));
const deploymentReleaseManifestPath = path.join(fixtureDirectory, "deployment-release-manifest.json");
const streamKeyPath = path.join(fixtureDirectory, "stream-key");
const streamKey = `ci-sentinel-${randomBytes(16).toString("hex")}`;
const tenantId = "11111111-1111-4111-8111-111111111111";
const channelConnectionId = "22222222-2222-4222-8222-222222222222";
const runtimeToken = "runtime-shared-token-at-least-32-bytes";
const gatewayReadToken = "runtime-gateway-read-only-token-at-least-32";
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
// schemaVersion 2 (M21): each index records, per image, the attestation read from the registry.
const releaseAttestations = (predicateType, seed) => Object.fromEntries(Object.keys(releaseImages).map((key, index) => [key, { platform: "linux/amd64", platformManifestDigest: `sha256:${(index + 1).toString(16).repeat(64)}`, attestationManifestDigest: `sha256:${seed.repeat(64)}`, predicateType, digest: `sha256:${createHash("sha256").update(`${seed}:${key}`).digest("hex")}` }]));
const releaseEvidenceIndexes = {
  sbom: { schemaVersion: 2, artifactType: "oci-buildx-sbom-index", releaseRevision, source: "https://github.com/shuzizhibo/shuzizhibo", images: releaseImages, attestations: releaseAttestations("https://spdx.dev/Document", "b") },
  provenance: { schemaVersion: 2, artifactType: "oci-buildx-provenance-index", releaseRevision, source: "https://github.com/shuzizhibo/shuzizhibo", images: releaseImages, builder: "github-actions-buildx", attestations: releaseAttestations("https://slsa.dev/provenance/v0.2", "c") }
};
const releaseEvidence = Object.fromEntries(Object.entries(releaseEvidenceIndexes).map(([name, value]) => [name, `${JSON.stringify(value)}\n`]));
const evidenceSha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const releaseEvidenceSha256 = Object.fromEntries(Object.entries(releaseEvidence).map(([name, value]) => [name, evidenceSha256(value)]));

function env(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n")}\n`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function deploymentReleaseManifest({ releaseRevision: manifestRevision = releaseRevision, manifestImages = undefined, validityMs = 24 * 60 * 60 * 1000, sbomSha256 = releaseEvidenceSha256.sbom } = {}) {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + validityMs);
  const unsigned = {
    schemaVersion: 1,
    releaseRevision: manifestRevision,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    images: manifestImages ?? releaseImages,
    sbomSha256,
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
  MEDIA_UPLOAD_ALLOWED_ORIGINS: "https://media-assets.internal",
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
  SETTLEMENT_INGEST_TENANT_TOKENS: { [tenantId]: "settlement-ingest-token-at-least-32" },
  AIGC_LABEL_TEXT: "本直播由AI数字人生成",
  AIGC_CONTENT_PRODUCER: "Shuzhiren Fixture Operator"
});

const controlCompose = env({
  CONTROL_PLANE_ENV_FILE: "/srv/shuzhiren/control.env",
  MIGRATION_OWNER_ENV_FILE: "/srv/shuzhiren/migration-owner.env",
  CONSOLE_HOST_BIND: "127.0.0.1",
  CONSOLE_PORT: "3000",
  CONTROL_PLANE_IMAGE: images.controlPlane,
  CONTROL_PLANE_MIGRATOR_IMAGE: images.controlPlaneMigrator
});

// D4: the control-plane-migrate profile connects as the dedicated migration owner.
const migrationOwner = env({ MIGRATION_OWNER_DATABASE_URL: "postgresql://shuzhiren_migration_owner:fixture-owner-password@postgres.internal:5432/shuzhiren" });

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
    STREAM_KEY_FILE: streamKeyPath,
    STREAM_FPS: "25",
    RUNTIME_GATEWAY_URL: "http://runtime-gateway:8090",
    RUNTIME_SHARED_TOKEN: runtimeToken,
    RUNTIME_GATEWAY_READ_TOKEN: gatewayReadToken,
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
    AVATAR_BUILDER_TOKEN: "avatar-builder-token-at-least-48-random-characters-long",
    AVATAR_PUBLISHER_TOKEN: "avatar-publisher-token-at-least-48-random-characters-long",
    AVATAR_BUILDER_LOCK_DATABASE_URL: "postgresql://avatar_builder:fixture-password@postgres.internal:5432/shuzhiren",
    AVATAR_CANDIDATE_VOLUME_PATH: "/srv/shuzhiren/avatar-candidates",
    INTERACTION_RULES_ENABLED: "true",
    INTERACTION_RULE_POLL_MS: "2000",
    INTERACTION_RULE_MIN_SPEECH_INTERVAL_SECONDS: "30",
    INTERACTION_RULE_VIEWER_COOLDOWN_SECONDS: "600",
    INTERACTION_RULE_MAX_EVENT_AGE_SECONDS: "60",
    INTERACTION_RULE_BATCH_SIZE: "20",
    INTERACTION_RULE_NICKNAME_MAX_LENGTH: "12",
    LIVE_MAX_CONCURRENT_AVATARS: "1",
    LIVE_ALLOW_LLM_FREEFORM: "false",
    LIVE_REQUIRE_HUMAN_HANDOFF_FOR_HIGH_RISK: "true",
    LIVE_REQUIRE_AI_DISCLOSURE: "true",
    LLM_MODE: "external",
    AIGC_LABEL_ENABLED: "true",
    AIGC_LABEL_TEXT: "本直播由AI数字人生成",
    AIGC_LABEL_POSITION: "top-right"
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
  COSYVOICE_MODEL_KIND: "zero_shot",
  COSYVOICE_VOICE_LIBRARY_PATH: "/srv/shuzhiren/voices",
  COSYVOICE_CHUNK_MAX_CHARS: "120",
  COSYVOICE_SFT_SPEAKER_MAP: "",
  RUNTIME_COMMAND_DEADLINE_SECONDS: "15",
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
  migrationOwner: path.join(fixtureDirectory, "migration-owner.env"),
  runtime: path.join(fixtureDirectory, "runtime.env"),
  gateway: path.join(fixtureDirectory, "gateway.env"),
  channel: path.join(fixtureDirectory, "channel.env"),
  alert: path.join(fixtureDirectory, "alert.env")
};

function check(options = []) {
  return spawnSync(process.execPath, [checker, "--control", files.control, "--control-compose", files.controlCompose, "--migration-owner", files.migrationOwner, "--runtime", files.runtime, "--gateway", files.gateway, "--channel-adapter", files.channel, "--alert-notifier", files.alert, "--source-root", root, "--require-output-probe", ...options], { cwd: root, encoding: "utf8" });
}

try {
  const validProbeTarget = [{ id: "fixture", streamUrl: "rtmp://relay.internal/live/fixture", avSyncProbeUrl: "https://av-sync.internal/fixture", expectedFps: 25, expectedWidth: 1280, expectedHeight: 720 }];
  await writeFile(streamKeyPath, `${streamKey}\n`, { mode: 0o600 });
  await Promise.all([writeFile(files.control, control), writeFile(files.releaseManifest, deploymentReleaseManifest()), writeFile(files.releaseSbom, releaseEvidence.sbom), writeFile(files.releaseProvenance, releaseEvidence.provenance), writeFile(files.controlCompose, controlCompose), writeFile(files.migrationOwner, migrationOwner), writeFile(files.runtime, runtime(validProbeTarget)), writeFile(files.gateway, gateway), writeFile(files.channel, channel), writeFile(files.alert, alert)]);
  const valid = check(["--require-cosyvoice"]);
  assert.equal(valid.status, 0, `valid deployment config failed:\n${valid.stderr}\n${valid.stdout}`);
  // The avatar-builder entrypoint imports the LiveTalking application from /app.
  // Keep this contract regression-tested: the legacy single-path value must fail
  // instead of being accepted as a substring of the corrected PYTHONPATH.
  {
    const liveTalkingDockerfile = path.join(root, "runtime", "livetalking", "Dockerfile");
    const liveTalkingDockerfileText = await readFile(liveTalkingDockerfile, "utf8");
    assert.match(liveTalkingDockerfileText, /^ENV PYTHONPATH=\/opt\/shuzhiren:\/app$/m, "LiveTalking Dockerfile must expose both runtime and application import roots");
    const legacyDockerfileText = liveTalkingDockerfileText.replace("ENV PYTHONPATH=/opt/shuzhiren:/app", "ENV PYTHONPATH=/opt/shuzhiren");
    assert.notEqual(legacyDockerfileText, liveTalkingDockerfileText, "the LiveTalking Dockerfile regression fixture must change the import path");
    await writeFile(liveTalkingDockerfile, legacyDockerfileText);
    try {
      const legacy = check(["--require-cosyvoice"]);
      assert.notEqual(legacy.status, 0, "the legacy LiveTalking PYTHONPATH must be rejected");
      assert.match(legacy.stderr, /ENV PYTHONPATH=\/opt\/shuzhiren:\/app/, "the rejection must identify the required application import root");
    } finally {
      await writeFile(liveTalkingDockerfile, liveTalkingDockerfileText);
    }
  }
  // L17 (39.6, 39.8): image sources come from runtime/open-source.lock.json; a leftover *_REF only warns.
  assert.doesNotMatch(valid.stderr, /_REF/, "a runtime env without *_REF variables must not mention them");
  await writeFile(files.runtime, `${runtime(validProbeTarget)}LIVETALKING_REF=c7269433a2b6ecebcd9342445d2ecc882c98b0da\n`);
  const deprecatedRef = check(["--require-cosyvoice"]);
  assert.equal(deprecatedRef.status, 0, `a deprecated LIVETALKING_REF must not fail the check:\n${deprecatedRef.stderr}`);
  assert.match(deprecatedRef.stderr, /WARN  LIVETALKING_REF 已废弃，镜像源码以 runtime\/open-source\.lock\.json 与子模块提交为准/, "a deprecated LIVETALKING_REF must be reported as a warning");
  await writeFile(files.runtime, runtime(validProbeTarget));

  // AIGC explicit label: a production config that lacks or turns off the label, or whose console text differs
  // from the runtime text, fails, with and without --allow-placeholders.
  {
    const withoutKey = (text, key) => text.split("\n").filter((line) => !line.startsWith(`${key}=`)).join("\n");
    const replaceKey = (text, key, value) => text.split("\n").map((line) => (line.startsWith(`${key}=`) ? `${key}=${value}` : line)).join("\n");
    const runtimeEnv = runtime(validProbeTarget);
    const cases = [
      ["runtime", withoutKey(runtimeEnv, "AIGC_LABEL_ENABLED"), /运行时 缺少 AIGC_LABEL_ENABLED/],
      ["runtime", replaceKey(runtimeEnv, "AIGC_LABEL_ENABLED", "false"), /AIGC_LABEL_ENABLED 必须为 true；AIGC 显式标识不能关闭/],
      ["runtime", replaceKey(runtimeEnv, "AIGC_LABEL_ENABLED", ""), /运行时 缺少 AIGC_LABEL_ENABLED/],
      ["runtime", withoutKey(runtimeEnv, "AIGC_LABEL_TEXT"), /运行时 缺少 AIGC_LABEL_TEXT/],
      ["runtime", replaceKey(runtimeEnv, "AIGC_LABEL_TEXT", ""), /运行时 的 AIGC_LABEL_TEXT 为空/],
      ["runtime", replaceKey(runtimeEnv, "AIGC_LABEL_TEXT", "欢迎来到直播间"), /AIGC_LABEL_TEXT 没有写明内容由 AI 生成/],
      ["runtime", replaceKey(runtimeEnv, "AIGC_LABEL_TEXT", `AI${"长".repeat(40)}`), /AIGC_LABEL_TEXT 超过 32 个字符/],
      ["runtime", replaceKey(runtimeEnv, "AIGC_LABEL_POSITION", "center"), /AIGC_LABEL_POSITION 必须是 top-left、top-right、bottom-left、bottom-right 之一/],
      ["runtime", withoutKey(runtimeEnv, "AIGC_LABEL_POSITION"), /运行时 缺少 AIGC_LABEL_POSITION/],
      ["runtime", `${runtimeEnv}AIGC_LABEL_FONT_FILE=/tmp/font.ttf\n`, /不得定义 AIGC_LABEL_FONT_FILE/],
      ["control", replaceKey(control, "AIGC_LABEL_TEXT", "AI生成"), /控制面与运行时的 AIGC_LABEL_TEXT 必须一致/],
      ["control", withoutKey(control, "AIGC_LABEL_TEXT"), /控制面 缺少 AIGC_LABEL_TEXT/],
      ["control", withoutKey(control, "AIGC_CONTENT_PRODUCER"), /控制面 缺少 AIGC_CONTENT_PRODUCER/],
      ["control", replaceKey(control, "AIGC_CONTENT_PRODUCER", "replace-with-service-provider-name"), /AIGC_CONTENT_PRODUCER 仍是占位符/]
    ];
    for (const [file, text, pattern] of cases) {
      await writeFile(files[file], text);
      const rejected = check(["--require-cosyvoice"]);
      assert.notEqual(rejected.status, 0, `AIGC label config must be rejected: ${pattern}`);
      assert.match(rejected.stderr, pattern);
      if (!/占位符/.test(pattern.source)) {
        const template = check(["--require-cosyvoice", "--allow-placeholders"]);
        assert.match(template.stderr, new RegExp(`ERROR .*${pattern.source}`), `AIGC label problems stay errors with --allow-placeholders: ${pattern}`);
      }
    }
    await writeFile(files.runtime, runtimeEnv);
    await writeFile(files.control, control);
    assert.equal(aigcLabelTextProblem("AI生成"), null);
    assert.equal(aigcLabelTextProblem("人工智能生成内容"), null);
    assert.match(aigcLabelTextProblem("AI\u200b生成"), /控制字符/, "invisible format characters are refused like in shuzhiren_aigc_label.py");
    const composeDoc = yaml.load(await readFile(path.join(root, "infra", "compose", "docker-compose.runtime.yml"), "utf8"));
    assert.deepEqual(aigcLabelComposeProblems(composeDoc), [], "the runtime Compose must pass the AIGC label variables to LiveTalking");
    const withoutLabel = structuredClone(composeDoc);
    delete withoutLabel.services.livetalking.environment.AIGC_LABEL_TEXT;
    withoutLabel.services.livetalking.environment.AIGC_LABEL_ENABLED = "true";
    assert.deepEqual(aigcLabelComposeProblems(withoutLabel).map((message) => message.split(" ")[3]), ["livetalking.environment.AIGC_LABEL_ENABLED", "livetalking.environment.AIGC_LABEL_TEXT"], "a hard-coded or missing label variable must be reported");
    const dockerfileText = await readFile(path.join(root, "runtime", "livetalking", "Dockerfile"), "utf8");
    const patchText = await readFile(path.join(root, "runtime", "patches", "livetalking-aigc-label.patch"), "utf8");
    const seriesPatches = ["livetalking-observability.patch", "livetalking-stream-secret.patch", "livetalking-local-tts.patch", "livetalking-aigc-label.patch"];
    assert.deepEqual(aigcLabelBuildProblems({ seriesPatches, patchText, dockerfileText }), []);
    const buildProblems = aigcLabelBuildProblems({ seriesPatches: seriesPatches.slice(0, 3), patchText: patchText.replace("combine_frame = self.aigc_label.apply(combine_frame)", "pass"), dockerfileText: dockerfileText.replace("git fonts-noto-cjk", "git").replace("COPY runtime/livetalking/shuzhiren_aigc_label.py /opt/shuzhiren/", "") }).join("\n");
    for (const pattern of [/补丁序列缺少 livetalking-aigc-label\.patch/, /AIGC 标识补丁缺少挂接：combine_frame = self\.aigc_label\.apply/, /没有复制 AIGC 标识模块/, /没有安装中文字体包 fonts-noto-cjk/]) assert.match(buildProblems, pattern);
    console.log("PASS  deployment configuration fails without an enabled AIGC label, a valid label text and position, a matching console text and a content producer");
    // Requirement 6.12, 6.13, 6.15, 6.19: the overlay patch draws the picture layers before the AIGC label,
    // and LiveTalking reads background assets from a read-only volume.
    const seriesLines = (await readFile(path.join(root, "runtime", "patches", "livetalking.series"), "utf8")).split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
    assert.equal(seriesLines.at(-1), "livetalking-runtime-stream.patch", "the runtime stream patch must be last in the LiveTalking series");
    const overlayPatch = await readFile(path.join(root, "runtime", "patches", "livetalking-overlay.patch"), "utf8");
    const overlayAdded = overlayPatch.split(/\r?\n/).filter((line) => line.startsWith("+")).join("\n");
    assert.match(overlayAdded, /render_output_frame\(self\.overlay, self\.aigc_label, combine_frame,/, "process_frames must render through render_output_frame");
    assert.doesNotMatch(overlayAdded, /aigc_label\.apply\(/, "the overlay patch must not call the AIGC label directly");
    assert.match(overlayAdded, /shuzhiren_overlay\.SessionOverlay\(self\.aigc_label\)/);
    assert.match(overlayAdded, /datainfo = \{"shuzhiren_caption_id": caption_id\}/);
    assert.match(overlayAdded, /add_post\("\/api\/admin\/overlay\/scene", admin_overlay_scene\)/);
    assert.match(overlayAdded, /add_get\("\/api\/admin\/overlay", admin_overlay\)/);
    assert.ok(dockerfileText.split(/\r?\n/).includes("COPY runtime/livetalking/shuzhiren_overlay.py /opt/shuzhiren/"), "the LiveTalking image must copy shuzhiren_overlay.py");
    assert.ok((await readFile(path.join(root, "runtime", "livetalking", "Dockerfile.dockerignore"), "utf8")).split(/\r?\n/).includes("!runtime/livetalking/shuzhiren_overlay.py"), "the build context must allow shuzhiren_overlay.py");
    assert.ok(composeDoc.services.livetalking.volumes.includes("overlay-assets:/opt/shuzhiren/overlay-assets:ro"), "LiveTalking must mount the overlay-assets volume read-only");
    assert.ok(composeDoc.volumes && Object.hasOwn(composeDoc.volumes, "overlay-assets"), "the overlay-assets volume must be declared");
    console.log("PASS  the overlay patch composes before the AIGC label, and the image, build context and Compose carry the module and the read-only asset volume");
    const sessionAdmissionPatch = await readFile(path.join(root, "runtime", "patches", "livetalking-session-admission.patch"), "utf8");
    assert.match(sessionAdmissionPatch, /self\._creation_lock = asyncio\.Lock\(\)/);
    assert.match(sessionAdmissionPatch, /async with self\._creation_lock:/);
    assert.match(sessionAdmissionPatch, /active_count = len\(self\.sessions\)/);
    assert.match(sessionAdmissionPatch, /await asyncio\.shield\(build_task\)/);
    assert.match(sessionAdmissionPatch, /self\.sessions\.pop\(sessionid, None\)/);
    console.log("PASS  LiveTalking session admission counts in-progress reservations and releases failed or cancelled builds without exceeding max_session");
    const runtimeStreamPatch = await readFile(path.join(root, "runtime", "patches", "livetalking-runtime-stream.patch"), "utf8");
    assert.match(runtimeStreamPatch, /if opt\.transport == 'virtualcam':/);
    assert.match(runtimeStreamPatch, /self\.streaming_enabled = False/);
    assert.match(runtimeStreamPatch, /def start_stream\(self\)/);
    assert.match(runtimeStreamPatch, /def stop_stream\(self\)/);
    assert.match(runtimeStreamPatch, /self\._player\.push_video\(frame\)/);
    assert.match(runtimeStreamPatch, /self\._player\.push_audio\(frame, eventpoint\)/);
    assert.match(runtimeStreamPatch, /\/api\/admin\/stream\/start/);
    assert.match(runtimeStreamPatch, /\/api\/admin\/stream\/stop/);
    assert.match(runtimeStreamPatch, /put_nowait\(\(new_frame, None\)\)/);
    console.log("PASS  LiveTalking creates one project Avatar for preview, gates RTMP until approved start, and bounds preview queues");
  }
  // L17 (39.1-39.5, 39.7): lock entries against Git fixtures, nested submodules and *_REF template rules.
  const openSourceLock = spawnSync(process.execPath, [path.join(root, "scripts", "test-open-source-lock.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(openSourceLock.status, 0, `open-source lock tests failed:\n${openSourceLock.stdout}\n${openSourceLock.stderr}`);
  process.stdout.write(openSourceLock.stdout);

  await writeFile(files.releaseSbom, "tampered\n");
  const invalidReleaseEvidence = check(["--require-cosyvoice"]);
  assert.notEqual(invalidReleaseEvidence.status, 0, "deployment manifests must reject tampered release evidence indexes");
  assert.match(invalidReleaseEvidence.stderr, /release-sbom-index\.json SHA-256 不匹配/, "tampered release evidence must identify the signed artifact gate");
  await writeFile(files.releaseSbom, releaseEvidence.sbom);

  // M21: a signed index must carry the attestation digests read from the registry. A schemaVersion 1 index (the
  // constant "oci-buildx-attached" claim) is rejected, and every image without a valid SBOM digest is listed.
  const legacySbom = `${JSON.stringify({ schemaVersion: 1, artifactType: "oci-buildx-sbom-index", releaseRevision, source: "https://github.com/shuzizhibo/shuzizhibo", images: releaseImages, attestationTransport: "oci-buildx-attached" })}\n`;
  const withoutAttestations = structuredClone(releaseEvidenceIndexes.sbom);
  delete withoutAttestations.attestations.RUNTIME_WORKER_IMAGE;
  withoutAttestations.attestations.COSYVOICE_IMAGE.digest = "sha256:not-hex";
  for (const [label, sbom, patterns] of [
    ["schemaVersion 1", legacySbom, [/release-sbom-index\.json 必须绑定 Buildx attestation/]],
    ["missing attestations", `${JSON.stringify(withoutAttestations)}\n`, [/release-sbom-index\.json 缺少 RUNTIME_WORKER_IMAGE 的 SBOM 摘要/, /release-sbom-index\.json 缺少 COSYVOICE_IMAGE 的 SBOM 摘要/]]
  ]) {
    await writeFile(files.releaseSbom, sbom);
    await writeFile(files.releaseManifest, deploymentReleaseManifest({ sbomSha256: evidenceSha256(sbom) }));
    const rejected = check(["--require-cosyvoice"]);
    assert.notEqual(rejected.status, 0, `a signed SBOM index with ${label} must be rejected`);
    for (const pattern of patterns) assert.match(rejected.stderr, pattern, `${label}: ${pattern}`);
  }
  await writeFile(files.releaseSbom, releaseEvidence.sbom);
  await writeFile(files.releaseManifest, deploymentReleaseManifest());

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

  // L6: Deploy_Check enforces the same 30-day validity limit as the manifest generator.
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  await writeFile(files.releaseManifest, deploymentReleaseManifest({ validityMs: thirtyDaysMs }));
  const thirtyDayManifest = check(["--require-cosyvoice"]);
  assert.equal(thirtyDayManifest.status, 0, `a manifest valid for exactly 30 days must be accepted:\n${thirtyDayManifest.stderr}`);
  await writeFile(files.releaseManifest, deploymentReleaseManifest({ validityMs: thirtyDaysMs + 1 }));
  const overlongManifest = check(["--require-cosyvoice"]);
  assert.notEqual(overlongManifest.status, 0, "a manifest valid for more than 30 days must be rejected");
  assert.match(overlongManifest.stderr, /不超过 30 天/, "the validity rejection must state the 30-day limit");
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
  assert.match(reusedDatabasePrincipal.stderr, /五个不同的 PostgreSQL 用户名/, "database-principal reuse must identify the least-privilege deployment gate");
  await writeFile(files.channel, channel);

  // D4: the migration owner is its own PostgreSQL user in its own env file, and no application account uses it.
  for (const [label, file, content, pattern] of [
    ["a missing migration owner URL", files.migrationOwner, "MIGRATION_OWNER_DATABASE_URL=\n", /迁移账号 缺少 MIGRATION_OWNER_DATABASE_URL/],
    ["a placeholder migration owner URL", files.migrationOwner, "MIGRATION_OWNER_DATABASE_URL=postgresql://shuzhiren_migration_owner:replace-me@postgres.internal:5432/shuzhiren\n", /迁移账号 的 MIGRATION_OWNER_DATABASE_URL 仍是占位符/],
    ["the control-plane account as migration owner", files.migrationOwner, "MIGRATION_OWNER_DATABASE_URL=postgresql://app:fixture-password@postgres.internal:5432/shuzhiren\n", /迁移账号必须是独立的 PostgreSQL 用户/],
    ["a DATABASE_URL in the migration owner file", files.migrationOwner, `${migrationOwner}DATABASE_URL=postgresql://app:fixture-password@postgres.internal:5432/shuzhiren\n`, /不得定义 DATABASE_URL/],
    ["another database name", files.migrationOwner, "MIGRATION_OWNER_DATABASE_URL=postgresql://shuzhiren_migration_owner:fixture-owner-password@postgres.internal:5432/other\n", /必须指向同一个数据库名/],
    ["an application account named shuzhiren_migration_owner", files.control, control.replace("postgresql://app:fixture-password", "postgresql://shuzhiren_migration_owner:fixture-password"), /不得使用迁移 owner 账号 shuzhiren_migration_owner/],
    ["a compose env without MIGRATION_OWNER_ENV_FILE", files.controlCompose, controlCompose.replace("MIGRATION_OWNER_ENV_FILE=/srv/shuzhiren/migration-owner.env\n", ""), /控制面 Compose 缺少 MIGRATION_OWNER_ENV_FILE/],
    ["the control env file as migration owner env file", files.controlCompose, controlCompose.replace("MIGRATION_OWNER_ENV_FILE=/srv/shuzhiren/migration-owner.env", "MIGRATION_OWNER_ENV_FILE=/srv/shuzhiren/control.env"), /独立于 CONTROL_PLANE_ENV_FILE/]
  ]) {
    await writeFile(file, content);
    const rejected = check(["--require-cosyvoice"]);
    assert.notEqual(rejected.status, 0, `${label} must be rejected`);
    assert.match(rejected.stderr, pattern, label);
    assert.ok(!rejected.stderr.includes("fixture-owner-password") && !rejected.stderr.includes("fixture-password"), `${label}: errors must not echo database passwords`);
  }
  await Promise.all([writeFile(files.migrationOwner, migrationOwner), writeFile(files.control, control), writeFile(files.controlCompose, controlCompose)]);

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

  // M6: the development request-header identity switch is rejected with and without --allow-placeholders.
  await writeFile(files.control, `${control}CONTROL_PLANE_DEV_HEADER_IDENTITY=true\n`);
  for (const options of [["--require-cosyvoice"], ["--require-cosyvoice", "--allow-placeholders"]]) {
    const devIdentity = check(options);
    assert.notEqual(devIdentity.status, 0, `deployments must reject CONTROL_PLANE_DEV_HEADER_IDENTITY=true (${options.join(" ")})`);
    assert.match(devIdentity.stderr, /CONTROL_PLANE_DEV_HEADER_IDENTITY/, "the rejection must name the development identity switch");
  }
  await writeFile(files.control, `${control}CONTROL_PLANE_DEV_HEADER_IDENTITY=false\n`);
  assert.equal(check(["--require-cosyvoice"]).status, 0, "an explicitly disabled development identity switch must be accepted");
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

  await writeFile(files.control, control.replace("MEDIA_UPLOAD_ALLOWED_ORIGINS=https://media-assets.internal", "MEDIA_UPLOAD_ALLOWED_ORIGINS=http://media-assets.internal/path"));
  const unsafeMediaUploadOrigin = check(["--require-cosyvoice"]);
  assert.notEqual(unsafeMediaUploadOrigin.status, 0, "production media uploads must reject non-HTTPS or path-bearing origins");
  assert.match(unsafeMediaUploadOrigin.stderr, /MEDIA_UPLOAD_ALLOWED_ORIGINS/, "media upload origin rejection must identify the CSP allowlist gate");
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

  await writeFile(files.runtime, runtime(validProbeTarget).replace("AVATAR_BUILDER_TOKEN=avatar-builder-token-at-least-48-random-characters-long", "AVATAR_BUILDER_TOKEN=short"));
  const shortAvatarBuilderToken = check(["--require-cosyvoice"]);
  assert.notEqual(shortAvatarBuilderToken.status, 0, "avatar builder must reject a token shorter than its API startup requirement");
  assert.match(shortAvatarBuilderToken.stderr, /AVATAR_BUILDER_TOKEN 必须是至少 48 个字符/, "short avatar-builder token rejection must identify the API requirement");
  await writeFile(files.runtime, runtime(validProbeTarget).replace("AVATAR_PUBLISHER_TOKEN=avatar-publisher-token-at-least-48-random-characters-long", "AVATAR_PUBLISHER_TOKEN=short"));
  const shortAvatarPublisherToken = check(["--require-cosyvoice"]);
  assert.notEqual(shortAvatarPublisherToken.status, 0, "avatar publisher must reject a token shorter than its API startup requirement");
  assert.match(shortAvatarPublisherToken.stderr, /AVATAR_PUBLISHER_TOKEN 必须是至少 48 个字符/, "short avatar-publisher token rejection must identify the API requirement");
  await writeFile(files.runtime, runtime(validProbeTarget).replace("AVATAR_CANDIDATE_VOLUME_PATH=/srv/shuzhiren/avatar-candidates", "AVATAR_CANDIDATE_VOLUME_PATH=relative/avatar-candidates"));
  const relativeAvatarCandidatePath = check(["--require-cosyvoice"]);
  assert.notEqual(relativeAvatarCandidatePath.status, 0, "avatar candidate volume must be a Linux absolute host path");
  assert.match(relativeAvatarCandidatePath.stderr, /AVATAR_CANDIDATE_VOLUME_PATH 必须是 Linux 主机绝对路径/, "relative avatar-candidate path rejection must identify the host-volume contract");
  await writeFile(files.runtime, runtime(validProbeTarget));

  // M17 (Requirement 31.9): RUNTIME_GATEWAY_READ_TOKEN is a separate private credential of runtime-observer.
  const withReadToken = (value) => runtime(validProbeTarget).replace(`RUNTIME_GATEWAY_READ_TOKEN=${gatewayReadToken}\n`, value === undefined ? "" : `RUNTIME_GATEWAY_READ_TOKEN=${value}\n`);
  const previewGateway = gateway.replace("PREVIEW_BROKER_URL=\n", "PREVIEW_BROKER_URL=https://preview-broker.internal\n").replace("PREVIEW_BROKER_TOKEN=\n", "PREVIEW_BROKER_TOKEN=preview-broker-token-at-least-32-bytes\n");
  for (const [label, runtimeText, gatewayText, pattern, secret] of [
    ["a missing read-only token", withReadToken(undefined), gateway, /运行时 缺少 RUNTIME_GATEWAY_READ_TOKEN/, undefined],
    ["a 31-character read-only token", withReadToken("r".repeat(31)), gateway, /RUNTIME_GATEWAY_READ_TOKEN（Gateway 只读凭据）必须是至少 32 个字符且不含空白/, "r".repeat(31)],
    ["a read-only token with a space", withReadToken("read only token with a space inside it"), gateway, /RUNTIME_GATEWAY_READ_TOKEN（Gateway 只读凭据）必须是至少 32 个字符且不含空白/, "read only token with a space inside it"],
    ["a read-only token with a tab", withReadToken("read-only-token\twith-a-tab-inside-it-32"), gateway, /RUNTIME_GATEWAY_READ_TOKEN（Gateway 只读凭据）必须是至少 32 个字符且不含空白/, "read-only-token\twith-a-tab-inside-it-32"],
    ["the shared token as read-only token", withReadToken(runtimeToken), gateway, /RUNTIME_GATEWAY_READ_TOKEN（Gateway 只读凭据）不得与 RUNTIME_SHARED_TOKEN 相同/, runtimeToken],
    ["the output-probe token as read-only token", withReadToken(outputProbeToken), gateway, /RUNTIME_GATEWAY_READ_TOKEN（Gateway 只读凭据）不得与 output-probe 的 token 相同/, outputProbeToken],
    ["a tenant telemetry token as read-only token", withReadToken(telemetryToken), gateway, new RegExp(`RUNTIME_GATEWAY_READ_TOKEN（Gateway 只读凭据）不得与 RUNTIME_TELEMETRY_TENANT_TOKENS:${tenantId} 的 token 相同`), telemetryToken],
    ["the preview broker token as read-only token", withReadToken("preview-broker-token-at-least-32-bytes"), previewGateway, /RUNTIME_GATEWAY_READ_TOKEN（Gateway 只读凭据）不得与 PREVIEW_BROKER_TOKEN 的 token 相同/, "preview-broker-token-at-least-32-bytes"],
    ["a different read-only token in gateway.env", runtime(validProbeTarget), `${gateway}RUNTIME_GATEWAY_READ_TOKEN=another-read-only-token-at-least-32-chars\n`, /Gateway 的 RUNTIME_GATEWAY_READ_TOKEN 与运行时取值不同/, "another-read-only-token-at-least-32-chars"]
  ]) {
    await writeFile(files.runtime, runtimeText);
    await writeFile(files.gateway, gatewayText);
    const rejected = check(["--require-cosyvoice"]);
    assert.notEqual(rejected.status, 0, `${label} must be rejected`);
    assert.match(rejected.stderr, pattern, `${label}:\n${rejected.stderr}`);
    assert.match(rejected.stderr, /RUNTIME_GATEWAY_READ_TOKEN/, label);
    if (secret) assert.ok(!`${rejected.stdout}${rejected.stderr}`.includes(secret), `${label}: errors must not echo the token`);
  }
  await writeFile(files.runtime, runtime(validProbeTarget));
  await writeFile(files.gateway, `${gateway}RUNTIME_GATEWAY_READ_TOKEN=${gatewayReadToken}\n`);
  const sameReadTokenInGateway = check(["--require-cosyvoice"]);
  assert.equal(sameReadTokenInGateway.status, 0, `the same read-only token in gateway.env must be accepted:\n${sameReadTokenInGateway.stderr}`);
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

  // Requirement 1.11: disabling the interaction rule loop stops AI disclosure speech, so deployments reject it.
  assert.match(runtime(validProbeTarget), /^INTERACTION_RULES_ENABLED=true$/m, "the runtime fixture must set INTERACTION_RULES_ENABLED=true");
  await writeFile(files.runtime, runtime(validProbeTarget).replace("INTERACTION_RULES_ENABLED=true", "INTERACTION_RULES_ENABLED=false"));
  const rulesDisabled = check(["--require-cosyvoice"]);
  assert.notEqual(rulesDisabled.status, 0, "deployment must reject INTERACTION_RULES_ENABLED=false");
  assert.match(rulesDisabled.stderr, /INTERACTION_RULES_ENABLED/, "the rejection must name the variable");
  assert.match(rulesDisabled.stderr, /AI 身份口播/, "the rejection must explain that AI disclosure speech stops");
  await writeFile(files.runtime, runtime(validProbeTarget).replace(/^INTERACTION_RULES_ENABLED=.*\n/m, ""));
  const rulesUnset = check(["--require-cosyvoice"]);
  // An unset value is not reported by this gate (the worker defaults to true). The separate Compose consistency
  // gate (RC-UNDEFINED) still wants the variable defined, so only this gate's message is asserted absent.
  assert.doesNotMatch(rulesUnset.stderr, /INTERACTION_RULES_ENABLED 不得为 false/, "an unset INTERACTION_RULES_ENABLED must not be reported as disabled");
  await writeFile(files.runtime, runtime(validProbeTarget));
  const rulesEnabled = check(["--require-cosyvoice"]);
  assert.equal(rulesEnabled.status, 0, `INTERACTION_RULES_ENABLED=true must pass: ${rulesEnabled.stderr}`);

  // Requirement 6.21: SHUZHIREN_OVERLAY_ASSET_DIR is optional, but a relative value is rejected by name.
  await writeFile(files.runtime, `${runtime(validProbeTarget)}\nSHUZHIREN_OVERLAY_ASSET_DIR=overlay-assets\n`);
  const relativeOverlayDir = check(["--require-cosyvoice"]);
  assert.notEqual(relativeOverlayDir.status, 0, "a relative SHUZHIREN_OVERLAY_ASSET_DIR must fail deployment");
  assert.match(relativeOverlayDir.stderr, /SHUZHIREN_OVERLAY_ASSET_DIR 必须是绝对路径/, "the rejection must name the variable and the reason");
  await writeFile(files.runtime, `${runtime(validProbeTarget)}\nSHUZHIREN_OVERLAY_ASSET_DIR=/opt/shuzhiren/overlay-assets\n`);
  const absoluteOverlayDir = check(["--require-cosyvoice"]);
  assert.equal(absoluteOverlayDir.status, 0, `an absolute SHUZHIREN_OVERLAY_ASSET_DIR must pass: ${absoluteOverlayDir.stderr}`);
  assert.doesNotMatch(rulesEnabled.stderr, /SHUZHIREN_OVERLAY_ASSET_DIR/, "an unset SHUZHIREN_OVERLAY_ASSET_DIR must not be reported");
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

  // H3/D2 (15.13): the Gateway needs an explicit CosyVoice model kind and the approved voice library.
  for (const kind of [null, "SFT", "zeroshot", ""]) {
    const variant = kind === null ? gateway.replace("COSYVOICE_MODEL_KIND=zero_shot\n", "") : gateway.replace("COSYVOICE_MODEL_KIND=zero_shot", `COSYVOICE_MODEL_KIND=${kind}`);
    assert.notEqual(variant, gateway);
    await writeFile(files.gateway, variant);
    for (const options of [["--require-cosyvoice"], ["--require-cosyvoice", "--allow-placeholders"]]) {
      const invalidModelKind = check(options);
      assert.notEqual(invalidModelKind.status, 0, `COSYVOICE_MODEL_KIND=${kind ?? "(missing)"} must be rejected`);
      assert.match(invalidModelKind.stderr, /CosyVoice 模型类型缺失或无效/, `COSYVOICE_MODEL_KIND=${kind ?? "(missing)"} must name the model kind`);
    }
  }
  for (const [from, to, pattern] of [
    ["COSYVOICE_VOICE_LIBRARY_PATH=/srv/shuzhiren/voices", "COSYVOICE_VOICE_LIBRARY_PATH=voices", /COSYVOICE_VOICE_LIBRARY_PATH/],
    ["COSYVOICE_CHUNK_MAX_CHARS=120", "COSYVOICE_CHUNK_MAX_CHARS=801", /COSYVOICE_CHUNK_MAX_CHARS/],
    ["RUNTIME_COMMAND_DEADLINE_SECONDS=15", "RUNTIME_COMMAND_DEADLINE_SECONDS=20", /RUNTIME_COMMAND_DEADLINE_SECONDS 必须小于/]
  ]) {
    await writeFile(files.gateway, gateway.replace(from, to));
    const invalidSynthesisSetting = check(["--require-cosyvoice"]);
    assert.notEqual(invalidSynthesisSetting.status, 0, `${to} must be rejected`);
    assert.match(invalidSynthesisSetting.stderr, pattern, `${to} must be reported`);
  }
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

  // M17: only runtime-gateway may share a network with the unauthenticated LiveTalking and CosyVoice APIs.
  assert.deepEqual(checkRuntimeComposeIsolation(runtimeComposeDoc).errors, [], "the runtime Compose must isolate LiveTalking and CosyVoice");
  const workerOnMedia = structuredClone(runtimeComposeDoc);
  workerOnMedia.services["runtime-worker"].networks = ["default", "runtime-media"];
  assert.match(checkRuntimeComposeIsolation(workerOnMedia).errors.map((error) => error.message).join("\n"), /livetalking shares network runtime-media with runtime-worker/, "a sidecar joining the media network must be reported");
  const routableMedia = structuredClone(runtimeComposeDoc);
  routableMedia.networks["runtime-media"].internal = false;
  assert.notDeepEqual(checkRuntimeComposeIsolation(routableMedia).errors, [], "a media network with a default route must be reported");
  const flatNetwork = structuredClone(runtimeComposeDoc);
  for (const service of Object.values(flatNetwork.services)) delete service.networks;
  assert.notDeepEqual(checkRuntimeComposeIsolation(flatNetwork).errors, [], "the pre-M17 single default network must be reported");

  // M17 (Requirement 31.7, 31.8): runtime-observer gets the read-only Gateway credential and never RUNTIME_SHARED_TOKEN.
  const runtimeTemplates = Object.fromEntries(await Promise.all([["runtime", "runtime"], ["runtime-gateway", "runtime-gateway"], ["channel-adapter", "channel-adapter"], ["alert-notifier", "alert-notifier"]].map(async ([name, file]) => [name, parseEnvFile(await readFile(path.join(root, "config", `${file}.example.env`), "utf8"), `config/${file}.example.env`)])));
  assert.deepEqual(checkObserverCredentials(runtimeComposeDoc, runtimeTemplates).errors, [], "the runtime Compose must give runtime-observer only the read-only Gateway credential");
  const credentialCodes = (doc, templates) => checkObserverCredentials(doc, templates).errors.map((error) => error.code);
  const observerWithShared = structuredClone(runtimeComposeDoc);
  observerWithShared.services["runtime-observer"].environment.RUNTIME_SHARED_TOKEN = "${RUNTIME_SHARED_TOKEN:?set-in-runtime-env}";
  assert.deepEqual(credentialCodes(observerWithShared), ["RCT-OBSERVER-TOKEN"], "an observer RUNTIME_SHARED_TOKEN key must be reported");
  const observerAliasShared = structuredClone(runtimeComposeDoc);
  observerAliasShared.services["runtime-observer"].environment.GATEWAY_COMMAND_TOKEN = "prefix-${RUNTIME_SHARED_TOKEN}";
  assert.deepEqual(credentialCodes(observerAliasShared), ["RCT-OBSERVER-TOKEN"], "another observer key interpolating RUNTIME_SHARED_TOKEN must be reported");
  const observerReadAsShared = structuredClone(runtimeComposeDoc);
  observerReadAsShared.services["runtime-observer"].environment.RUNTIME_GATEWAY_READ_TOKEN = "${RUNTIME_SHARED_TOKEN:?set-in-runtime-env}";
  assert.deepEqual(credentialCodes(observerReadAsShared), ["RCT-READ-TOKEN", "RCT-OBSERVER-TOKEN"], "a read-only token mapped to the shared token must be reported");
  const observerEnvFile = structuredClone(runtimeComposeDoc);
  observerEnvFile.services["runtime-observer"].env_file = ["../../config/runtime.env"];
  assert.deepEqual(credentialCodes(observerEnvFile), ["RCT-OBSERVER-TOKEN"], "an observer env_file must be reported");
  const observerListShared = structuredClone(runtimeComposeDoc);
  observerListShared.services["runtime-observer"].environment = [...Object.entries(observerListShared.services["runtime-observer"].environment).map(([key, value]) => `${key}=${value}`), "RUNTIME_SHARED_TOKEN"];
  assert.deepEqual(credentialCodes(observerListShared), ["RCT-OBSERVER-TOKEN"], "a pass-through RUNTIME_SHARED_TOKEN list entry must be reported");
  for (const service of ["runtime-gateway", "runtime-observer"]) {
    const withoutReadToken = structuredClone(runtimeComposeDoc);
    delete withoutReadToken.services[service].environment.RUNTIME_GATEWAY_READ_TOKEN;
    assert.deepEqual(credentialCodes(withoutReadToken), ["RCT-READ-TOKEN"], `${service} without RUNTIME_GATEWAY_READ_TOKEN must be reported`);
  }
  const sameTemplateValue = { ...runtimeTemplates, runtime: new Map([...runtimeTemplates.runtime, ["RUNTIME_GATEWAY_READ_TOKEN", runtimeTemplates.runtime.get("RUNTIME_SHARED_TOKEN")]]) };
  assert.deepEqual(credentialCodes(runtimeComposeDoc, sameTemplateValue), ["RCT-READ-TOKEN", "RCT-READ-TOKEN"], "a template giving both credentials one value must be reported for runtime and runtime-gateway");
  const gatewayTemplateReadToken = { ...runtimeTemplates, "runtime-gateway": new Map([...runtimeTemplates["runtime-gateway"], ["RUNTIME_GATEWAY_READ_TOKEN", "x"]]) };
  assert.deepEqual(credentialCodes(runtimeComposeDoc, gatewayTemplateReadToken), ["RCT-READ-TOKEN"], "the read-only token must be defined in the runtime template only");
  const noTemplateReadToken = { ...runtimeTemplates, runtime: new Map([...runtimeTemplates.runtime].filter(([key]) => key !== "RUNTIME_GATEWAY_READ_TOKEN")) };
  assert.deepEqual(credentialCodes(runtimeComposeDoc, noTemplateReadToken), ["RCT-READ-TOKEN"], "a runtime template without the read-only token must be reported");  // H2: the stream key may only live in the STREAM_KEY_FILE file and is never printed.
  const assertStreamKeyRejected = (result, pattern, description) => {
    assert.notEqual(result.status, 0, description);
    assert.match(result.stderr, pattern, description);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(streamKey), `${description}: the preflight must not print the stream key`);
  };
  await writeFile(files.runtime, `${runtime(validProbeTarget)}STREAM_KEY=${streamKey}\n`);
  assertStreamKeyRejected(check(["--require-cosyvoice"]), /运行时 env 文件不得定义 STREAM_KEY/, "a stream key in the runtime env file must be rejected");
  await writeFile(files.runtime, runtime(validProbeTarget));
  await writeFile(files.gateway, `${gateway}STREAM_KEY=${streamKey}\n`);
  assertStreamKeyRejected(check(["--require-cosyvoice"]), /Gateway env 文件不得定义 STREAM_KEY/, "a stream key in the Gateway env file must be rejected");
  await writeFile(files.gateway, gateway);
  await writeFile(files.runtime, runtime(validProbeTarget).replace(`STREAM_KEY_FILE=${streamKeyPath}`, "STREAM_KEY_FILE=secrets/stream-key"));
  assertStreamKeyRejected(check(["--require-cosyvoice"]), /STREAM_KEY_FILE 必须是部署主机绝对路径/, "a relative stream key file path must be rejected");
  await writeFile(files.runtime, runtime(validProbeTarget).replace(`STREAM_KEY_FILE=${streamKeyPath}`, `STREAM_KEY_FILE=${streamKeyPath}.absent`));
  assertStreamKeyRejected(check(["--require-cosyvoice"]), /STREAM_KEY_FILE 指向的密钥文件不存在/, "a missing stream key file must be rejected");
  await writeFile(files.runtime, runtime(validProbeTarget));
  for (const [content, pattern] of [["\n", /密钥文件为空/], [`${streamKey} trailing\n`, /密钥文件格式非法/], [`"${streamKey}"\n`, /密钥文件格式非法/]]) {
    await writeFile(streamKeyPath, content, { mode: 0o600 });
    assertStreamKeyRejected(check(["--require-cosyvoice"]), pattern, `stream key file content ${JSON.stringify(content.slice(0, 3))}… must be rejected`);
  }
  if (process.platform !== "win32") {
    for (const [mode, pattern] of [[0o644, /可被其他用户读取/], [0o620, /可被同组或其他用户写入/]]) {
      await writeFile(streamKeyPath, `${streamKey}\n`);
      await chmod(streamKeyPath, mode);
      assertStreamKeyRejected(check(["--require-cosyvoice"]), pattern, `a stream key file with mode ${mode.toString(8)} must be rejected`);
    }
    await chmod(streamKeyPath, 0o600);
  }
  await writeFile(streamKeyPath, `${streamKey}\n`, { mode: 0o600 });
  for (const url of ["rtmp://ingest.internal/live?token=1", "rtmp://user:pass@ingest.internal/live", "rtmp://ingest.internal/live/", "https://ingest.internal/live"]) {
    await writeFile(files.runtime, runtime(validProbeTarget).replace("STREAM_RTMP_URL=rtmp://ingest.internal/live", `STREAM_RTMP_URL=${url}`));
    await writeFile(files.gateway, gateway.replace("STREAM_RTMP_URL=rtmp://ingest.internal/live", `STREAM_RTMP_URL=${url}`));
    assertStreamKeyRejected(check(["--require-cosyvoice"]), /STREAM_RTMP_URL 必须是不含凭据、查询串、片段/, `STREAM_RTMP_URL ${url} must be rejected`);
  }
  await writeFile(files.runtime, runtime(validProbeTarget));
  await writeFile(files.gateway, gateway);
  const validWithKeyFile = check(["--require-cosyvoice"]);
  assert.equal(validWithKeyFile.status, 0, `the restored stream key file must pass:\n${validWithKeyFile.stderr}`);

  // H2: the legacy Compose command put the key into argv; the current file mounts it as a secret.
  const legacyStreamCompose = yaml.load("services:\n  livetalking:\n    command: >-\n      python3 app.py --transport rtmp --push_url ${STREAM_RTMP_URL:?set-in-runtime-env}/${STREAM_KEY:?set-in-runtime-env}\n");
  const legacyProblems = streamKeyComposeProblems(legacyStreamCompose).join("\n");
  for (const pattern of [/不得插值 STREAM_KEY/, /--stream_key_file \/run\/secrets\/stream-key/, /--push_url 只能是不含推流密钥/, /stream_key, target: stream-key/, /secrets\.stream_key\.file/]) assert.match(legacyProblems, pattern, "the legacy stream key wiring must be reported");
  assert.deepEqual(streamKeyComposeProblems(runtimeComposeDoc), [], "the runtime Compose must pass the stream key only as a secret file");

  // H3/D2 (15.12): LiveTalking runs without a TTS plugin; speech is CosyVoice audio from runtime-gateway.
  assert.deepEqual(liveTalkingTtsComposeProblems(runtimeComposeDoc), [], "the runtime Compose must start LiveTalking with --tts none");
  assert.deepEqual(liveTalkingCapacityComposeProblems(runtimeComposeDoc), [], "the runtime Compose must limit the single-GPU LiveTalking service to one session");
  for (const command of [
    "python3 app.py --max_session 2",
    "python3 app.py --max_session 1 --max_session 1",
    "python3 app.py"
  ]) {
    assert.match(liveTalkingCapacityComposeProblems({ services: { livetalking: { command } } }).join("\n"), /--max_session 必须恰好设置为 1/);
  }
  assert.deepEqual(liveTalkingCapacityComposeProblems({ services: { livetalking: { command: ["python3", "app.py", "--max_session=1"] } } }), [], "the array command must enforce the same one-session limit");
  const baseCommand = "python3 app.py --transport rtmp --stream_key_file /run/secrets/stream-key";
  const ttsCommand = (extra) => ({ services: { livetalking: { command: `${baseCommand} ${extra}` } } });
  assert.deepEqual(liveTalkingTtsComposeProblems(ttsCommand("--tts none --TTS_SERVER http://cosyvoice:50000")), []);
  assert.deepEqual(liveTalkingTtsComposeProblems(ttsCommand("--tts=none '--TTS_SERVER' \"http://cosyvoice:50000\"")), [], "quoted and --flag=value forms are the same arguments");
  assert.deepEqual(liveTalkingTtsComposeProblems({ services: { livetalking: { command: [...baseCommand.split(" "), "--tts", "none", "--TTS_SERVER", "http://cosyvoice:50000"] } } }), [], "an array command is checked as is");
  for (const extra of ["--TTS_SERVER http://cosyvoice:50000", "--tts edgetts --TTS_SERVER http://cosyvoice:50000", "--tts=cosyvoice --TTS_SERVER http://cosyvoice:50000", "--tts none --tts none --TTS_SERVER http://cosyvoice:50000", "--tts none --TTS_SERVER http://127.0.0.1:9880", "--tts none --TTS_SERVER ${X}", "--tts none", "--tt none --tts none --TTS_SERVER http://cosyvoice:50000", "--tts none --TTS_SERV http://cosyvoice:50000 --TTS_SERVER http://cosyvoice:50000", "--tts 'none"]) {
    assert.match(liveTalkingTtsComposeProblems(ttsCommand(extra)).join("\n"), /LiveTalking_Runtime TTS 配置不合规/, `livetalking ${extra} must be rejected`);
  }
  const renderedCommand = interpolate(String(runtimeComposeDoc.services.livetalking.command), new Map([["LIVETALKING_AVATAR_ID", "approved"], ["STREAM_RTMP_URL", "rtmp://ingest.internal/live"], ["STREAM_KEY", streamKey]]));
  assert.ok(!renderedCommand.includes(streamKey) && renderedCommand.includes("--stream_key_file /run/secrets/stream-key"), "a STREAM_KEY left in an env file must not reach the LiveTalking argv");

  // H2: patched LiveTalking and the image launcher, exercised in Python against the locked commit plus the patch series.
  const python = findPython();
  if (!python) {
    if (process.env.CI) throw new Error("Python 3 is required in CI for the LiveTalking stream-key tests; set PYTHON");
    console.warn("SKIP  Python 3 not found; LiveTalking stream-key behavior tests not run (set PYTHON to enable)");
  } else {
    const patchedSource = path.join(fixtureDirectory, "livetalking-patched");
    const series = checkPatchSeries({ sourceDir: path.join(root, "vendor", "LiveTalking"), seriesFile: path.join(root, "runtime", "patches", "livetalking.series"), checkoutTo: patchedSource, paths: ["app.py", "config.py", "registry.py", "utils/logger.py", "server/__init__.py", "server/routes.py", "server/session_manager.py", "server/rtc_manager.py", "server/webrtc.py", "streamout/__init__.py", "streamout/rtmp.py", "avatars/base_avatar.py"] });
    assert.deepEqual(series.failures, [], "the LiveTalking patch series must apply to the locked commit");
    const pythonTest = spawnSync(python, [path.join(root, "runtime", "livetalking", "tests", "test_stream_secret.py"), "--livetalking-source", patchedSource], { cwd: root, encoding: "utf8", timeout: 240_000 });
    assert.equal(pythonTest.status, 0, `LiveTalking stream-key behavior tests failed:\n${pythonTest.stdout}\n${pythonTest.stderr}`);
    process.stdout.write(pythonTest.stdout);
    const admissionTest = spawnSync(python, [path.join(root, "runtime", "livetalking", "tests", "test_session_admission.py"), "--livetalking-source", patchedSource], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.equal(admissionTest.status, 0, `LiveTalking session-admission tests failed:\n${admissionTest.stdout}\n${admissionTest.stderr}`);
    process.stdout.write(admissionTest.stdout);
    // AIGC explicit label: configuration and launcher tests always run; the drawing tests need numpy, Pillow and a
    // CJK font and print SKIP without them (AIGC_LABEL_REQUIRE_IMAGING=true turns a SKIP into a failure).
    const labelArgs = [path.join(root, "runtime", "livetalking", "tests", "test_aigc_label.py"), "--livetalking-source", patchedSource, ...(process.env.AIGC_LABEL_REQUIRE_IMAGING === "true" ? ["--require-imaging"] : [])];
    const labelTest = spawnSync(python, labelArgs, { cwd: root, encoding: "utf8", timeout: 240_000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.equal(labelTest.status, 0, `LiveTalking AIGC label tests failed:\n${labelTest.stdout}\n${labelTest.stderr}`);
    process.stdout.write(labelTest.stdout);
  }

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
