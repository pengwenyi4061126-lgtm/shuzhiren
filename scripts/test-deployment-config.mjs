import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(root, "scripts", "check-deployment-config.mjs");
const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-deploy-config-"));
const tenantId = "11111111-1111-4111-8111-111111111111";
const channelConnectionId = "22222222-2222-4222-8222-222222222222";
const runtimeToken = "runtime-shared-token-at-least-32-bytes";
const telemetryToken = "telemetry-token-at-least-32-bytes";
const outputProbeToken = "output-probe-token-at-least-32-bytes";
const commits = {
  MuseTalk: "0a89dec45a0192b824e3cf4daf96c239440c5ed8",
  CosyVoice: "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc",
  LiveTalking: "c7269433a2b6ecebcd9342445d2ecc882c98b0da"
};

function env(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n")}\n`;
}

const control = env({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:fixture-password@postgres.internal:5432/shuzhiren",
  CONTROL_PLANE_DEMO_MODE: "false",
  OIDC_ISSUER_URL: "https://issuer.internal",
  OIDC_AUDIENCE: "shuzhiren-console",
  OIDC_JWKS_URL: "https://issuer.internal/jwks.json",
  RUNTIME_TELEMETRY_TENANT_TOKENS: { [tenantId]: telemetryToken },
  RUNTIME_RECORDING_TENANT_TOKENS: { [tenantId]: "recording-token-at-least-32-bytes" },
  PIM_INGEST_TENANT_TOKENS: { [tenantId]: "pim-ingest-token-at-least-32-bytes" },
  CHANNEL_INGEST_TENANT_TOKENS: { [tenantId]: "channel-ingest-token-at-least-32-bytes" },
  CHANNEL_COMMERCE_TENANT_TOKENS: { [tenantId]: "commerce-ingest-token-at-least-32-bytes" }
});

function runtime(outputProbeTargets) {
  return env({
    NVIDIA_VISIBLE_DEVICES: "0",
    STREAM_OUTPUT_MODE: "rtmp",
    STREAM_RTMP_URL: "rtmp://ingest.internal/live",
    STREAM_KEY: "fixture-stream-key-not-a-placeholder",
    STREAM_FPS: "25",
    LIVETALKING_REF: commits.LiveTalking,
    MUSETALK_REF: commits.MuseTalk,
    COSYVOICE_REF: commits.CosyVoice,
    RUNTIME_GATEWAY_URL: "http://runtime-gateway.internal:8090",
    RUNTIME_SHARED_TOKEN: runtimeToken,
    RUNTIME_GATEWAY_DEMO_MODE: "false",
    DATABASE_URL: "postgresql://app:fixture-password@postgres.internal:5432/shuzhiren",
    CONTROL_PLANE_URL: "https://control-plane.internal",
    RUNTIME_OBSERVER_TARGETS_DIR: "/srv/shuzhiren/observer-config",
    RUNTIME_OBSERVER_TARGETS: [{ tenantId, runId: "run_fixture", sessionId: "session_fixture", telemetryToken, outputProbeUrl: "http://output-probe.internal:8081/v1/probes/fixture", outputProbeToken }],
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
  STREAM_RTMP_URL: "rtmp://ingest.internal/live",
  STREAM_KEY: "fixture-stream-key-not-a-placeholder",
  PROGRAM_AUDIOTYPE: "0",
  FALLBACK_AUDIOTYPE: "1",
  HUMAN_HANDOFF_AUDIOTYPE: "2"
});

const channel = env({
  DATABASE_URL: "postgresql://app:fixture-password@postgres.internal:5432/shuzhiren",
  CONTROL_PLANE_URL: "https://control-plane.internal",
  CHANNEL_ADAPTER_PORT: "8082",
  CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS: "60",
  CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE: "120",
  CHANNEL_ADAPTER_TARGETS: [{ tenantId, channelConnectionId, signingSecret: "channel-signing-secret-at-least-32-bytes", interactionToken: "channel-interaction-token-at-least-32", commerceToken: "channel-commerce-token-at-least-32-bytes" }]
});

const alert = env({
  DATABASE_URL: "postgresql://app:fixture-password@postgres.internal:5432/shuzhiren",
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
  runtime: path.join(fixtureDirectory, "runtime.env"),
  gateway: path.join(fixtureDirectory, "gateway.env"),
  channel: path.join(fixtureDirectory, "channel.env"),
  alert: path.join(fixtureDirectory, "alert.env")
};

function check(options = []) {
  return spawnSync(process.execPath, [checker, "--control", files.control, "--runtime", files.runtime, "--gateway", files.gateway, "--channel-adapter", files.channel, "--alert-notifier", files.alert, "--source-root", root, "--require-output-probe", ...options], { cwd: root, encoding: "utf8" });
}

try {
  const validProbeTarget = [{ id: "fixture", streamUrl: "rtmp://relay.internal/live/fixture", avSyncProbeUrl: "https://av-sync.internal/fixture", expectedFps: 25, expectedWidth: 1280, expectedHeight: 720 }];
  await Promise.all([writeFile(files.control, control), writeFile(files.runtime, runtime(validProbeTarget)), writeFile(files.gateway, gateway), writeFile(files.channel, channel), writeFile(files.alert, alert)]);
  const valid = check(["--require-cosyvoice"]);
  assert.equal(valid.status, 0, `valid deployment config failed:\n${valid.stderr}\n${valid.stdout}`);

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

  await writeFile(files.runtime, runtime([{ ...validProbeTarget[0], expectedHeight: undefined }]));
  const invalid = check();
  assert.notEqual(invalid.status, 0, "output probe with only expectedWidth must be rejected");
  assert.match(invalid.stderr, /OUTPUT_PROBE_TARGETS/, "invalid output probe error must identify the deployment gate");
  console.log("PASS  deployment configuration validates required output-probe and CosyVoice targets");
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true });
}
