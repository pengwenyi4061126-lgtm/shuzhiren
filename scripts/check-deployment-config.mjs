import { lstat, open, readdir, readFile } from "node:fs/promises";
import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTarget as validateOutputProbeTarget } from "../apps/output-probe/lib.mjs";
import { parseObserverTargets } from "../apps/runtime-observer/targets.mjs";
import yaml from "js-yaml";
// Release manifests are signed over Canonical_JSON rule 2 (keys in code-point order, no locale dependence).
import { canonicalJson } from "../apps/console/lib/canonical-json.mjs";
import { checkDockerignore } from "./lib/dockerignore.mjs";
import { checkPatchSeries } from "./lib/livetalking-patches.mjs";
import { checkTemplateRefVariables, deprecatedRefVariables, verifyOpenSourceLock } from "./lib/open-source-lock.mjs";
import { verifyLiveTalkingNotice } from "./lib/runtime-image-licenses.mjs";
import { checkRuntimeComposeConsistency, liveTalkingTtsComposeProblems, streamKeyComposeProblems } from "./lib/runtime-compose-consistency.mjs";

// Context-relative paths the LiveTalking image build must leave out (M23) or keep.
const LIVETALKING_CONTEXT_EXCLUDED = Object.freeze([
  ".git/config", ".env", "config/runtime.example.env", "secrets/stream-key", "apps/console/package.json", "docs/DEPLOYMENT_RUNBOOK.md",
  "vendor/CosyVoice/requirements.txt", "vendor/MuseTalk/README.md", "runtime/gateway/app.py", "runtime/livetalking/tests/test_stream_secret.py", "runtime/livetalking/Dockerfile",
  "vendor/LiveTalking/.git", "vendor/LiveTalking/.git/config", "vendor/LiveTalking/.env", "vendor/LiveTalking/.env.local", "vendor/LiveTalking/avatars/musetalk/.env",
  "vendor/LiveTalking/models/put models here.txt", "vendor/LiveTalking/models/musetalkV15/unet.pth", "vendor/LiveTalking/data/custom_config.json", "vendor/LiveTalking/data/avatars/approved/full_imgs/0.png",
  "vendor/LiveTalking/livetalking.log", "vendor/LiveTalking/web/debug.log", "vendor/LiveTalking/secrets/stream-key", "vendor/LiveTalking/weights/model.pth",
  "vendor/LiveTalking/recordings/session.mp4", "vendor/LiveTalking/exports/run.json", "vendor/LiveTalking/cache/model.bin", "vendor/LiveTalking/logs/run.txt"
]);
const LIVETALKING_CONTEXT_INCLUDED = Object.freeze([
  "vendor/LiveTalking/app.py", "vendor/LiveTalking/config.py", "vendor/LiveTalking/requirements.txt", "vendor/LiveTalking/server/routes.py", "vendor/LiveTalking/streamout/rtmp.py",
  "vendor/LiveTalking/avatars/musetalk/models/unet.py", "vendor/LiveTalking/web/rtmpapi.html", "runtime/patches/livetalking-observability.patch",
  "runtime/patches/livetalking-stream-secret.patch", "runtime/patches/livetalking-local-tts.patch", "runtime/patches/livetalking.series", "runtime/livetalking/launcher.py", "runtime/livetalking/shuzhiren_secrets.py",
  "vendor/LiveTalking/LICENSE", "runtime/patches/LIVETALKING_MODIFICATIONS.md"
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowPlaceholders = process.argv.includes("--allow-placeholders");
const requireOutputProbe = process.argv.includes("--require-output-probe");
const requireCosyVoice = process.argv.includes("--require-cosyvoice");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : path.resolve(root, fallback);
};
const files = {
  control: option("--control", "config/control-plane.example.env"),
  controlCompose: option("--control-compose", "config/control-plane-compose.example.env"),
  runtime: option("--runtime", "config/runtime.example.env"),
  gateway: option("--gateway", "config/runtime-gateway.example.env"),
  channelAdapter: option("--channel-adapter", "config/channel-adapter.example.env"),
  alertNotifier: option("--alert-notifier", "config/alert-notifier.example.env"),
  lock: option("--lock", "runtime/open-source.lock.json"),
  sourceRoot: option("--source-root", ".")
};

const errors = [];
const warnings = [];

function parseEnv(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) { errors.push(`无法解析环境变量行：${rawLine}`); continue; }
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function required(values, fileName, keys) {
  for (const key of keys) {
    const value = values.get(key);
    if (!value) errors.push(`${fileName} 缺少 ${key}`);
    else if (!allowPlaceholders && /replace-with|replace-me|example\.com|<|>/.test(value)) errors.push(`${fileName} 的 ${key} 仍是占位符`);
  }
}

function isPlaceholder(value) {
  return /replace-with|replace-me|example\.com|<|>/.test(value);
}

function immutableImages(values, fileName, keys) {
  for (const key of keys) {
    const value = values.get(key);
    if (!value || (allowPlaceholders && isPlaceholder(value))) continue;
    const [repository, digest, ...rest] = value.split("@");
    const imageName = repository.slice(repository.lastIndexOf("/") + 1);
    if (rest.length || !repository.includes("/") || !repository || imageName.includes(":") || !/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) {
      errors.push(`${fileName} 的 ${key} 必须是无 tag 的 registry/repository@sha256:<64位十六进制> 不可变镜像引用`);
    }
  }
}

async function verifyReleaseEvidenceIndexes(manifest, manifestPath, imageKeys) {
  const evidence = [
    { file: "release-sbom-index.json", digest: manifest.sbomSha256, artifactType: "oci-buildx-sbom-index", label: "SBOM" },
    { file: "release-provenance-index.json", digest: manifest.provenanceSha256, artifactType: "oci-buildx-provenance-index", builder: "github-actions-buildx", label: "provenance" }
  ];
  for (const expected of evidence) {
    let source;
    try {
      source = await readFile(path.join(path.dirname(manifestPath), expected.file));
    } catch (error) {
      errors.push(`DEPLOYMENT_RELEASE_MANIFEST 缺少同目录 ${expected.file}：${error instanceof Error ? error.message : "无法读取"}`);
      continue;
    }
    if (`sha256:${createHash("sha256").update(source).digest("hex")}` !== expected.digest) {
      errors.push(`DEPLOYMENT_RELEASE_MANIFEST 的 ${expected.file} SHA-256 不匹配`);
      continue;
    }
    let index;
    try {
      index = JSON.parse(source.toString("utf8"));
    } catch {
      errors.push(`${expected.file} 必须是 JSON 对象`);
      continue;
    }
    if (!index || typeof index !== "object" || Array.isArray(index) || index.schemaVersion !== 2 || index.artifactType !== expected.artifactType || index.releaseRevision !== manifest.releaseRevision || (expected.builder && index.builder !== expected.builder)) {
      errors.push(`${expected.file} 必须绑定 Buildx attestation、发布提交和 artifact 类型`);
      continue;
    }
    if (!index.images || typeof index.images !== "object" || Array.isArray(index.images) || Object.keys(index.images).length !== imageKeys.length || imageKeys.some((key) => index.images[key] !== manifest.images[key])) errors.push(`${expected.file} 的十个镜像必须精确匹配 DEPLOYMENT_RELEASE_MANIFEST`);
    // M21: schemaVersion 2 records, per image, the attestation digest read from the registry; every missing or
    // malformed entry is reported.
    const attestations = index.attestations && typeof index.attestations === "object" && !Array.isArray(index.attestations) ? index.attestations : {};
    for (const key of imageKeys) if (!/^sha256:[a-f0-9]{64}$/.test(attestations[key]?.digest ?? "")) errors.push(`${expected.file} 缺少 ${key} 的 ${expected.label} 摘要，或摘要不是 sha256:<64 位小写十六进制>`);
  }
}

async function verifyDeploymentReleaseManifest(control, controlCompose, runtime, controlImageKeys, runtimeImageKeys) {
  const manifestPath = control.get("DEPLOYMENT_RELEASE_MANIFEST");
  const trustSource = control.get("DEPLOYMENT_RELEASE_MANIFEST_TRUST");
  if (!manifestPath || !trustSource || (allowPlaceholders && (isPlaceholder(manifestPath) || isPlaceholder(trustSource)))) return;
  if (!path.isAbsolute(manifestPath)) {
    errors.push("控制面 的 DEPLOYMENT_RELEASE_MANIFEST 必须是部署主机绝对路径");
    return;
  }
  let trust;
  try {
    trust = JSON.parse(trustSource);
    if (!trust || typeof trust !== "object" || Array.isArray(trust) || !Object.entries(trust).every(([issuer, keys]) => /^[a-z][a-z0-9_-]{1,63}$/.test(issuer) && keys && typeof keys === "object" && !Array.isArray(keys) && Object.entries(keys).length > 0 && Object.entries(keys).every(([keyId, pem]) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId) && typeof pem === "string" && createPublicKey(pem).asymmetricKeyType === "ed25519"))) throw new Error("invalid");
  } catch {
    errors.push("控制面 的 DEPLOYMENT_RELEASE_MANIFEST_TRUST 必须是 issuer 到 Ed25519 公钥的 JSON 对象");
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    errors.push(`无法读取 DEPLOYMENT_RELEASE_MANIFEST：${error instanceof Error ? error.message : "无效 JSON"}`);
    return;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push("DEPLOYMENT_RELEASE_MANIFEST 必须是 JSON 对象");
    return;
  }
  const signature = manifest.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature) || typeof signature.issuer !== "string" || typeof signature.keyId !== "string" || typeof signature.value !== "string") {
    errors.push("DEPLOYMENT_RELEASE_MANIFEST 缺少 issuer、keyId 和 Ed25519 signature");
    return;
  }
  const publicKey = trust[signature.issuer]?.[signature.keyId];
  if (typeof publicKey !== "string") {
    errors.push("DEPLOYMENT_RELEASE_MANIFEST 使用了未受信任的 issuer 或 keyId");
    return;
  }
  const unsigned = { ...manifest };
  delete unsigned.signature;
  try {
    if (!verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature.value, "base64"))) throw new Error("invalid");
  } catch {
    errors.push("DEPLOYMENT_RELEASE_MANIFEST Ed25519 签名无效");
    return;
  }
  if (manifest.schemaVersion !== 1) errors.push("DEPLOYMENT_RELEASE_MANIFEST 必须使用 schemaVersion 1");
  if (!/^[a-f0-9]{40}$/.test(manifest.releaseRevision ?? "")) errors.push("DEPLOYMENT_RELEASE_MANIFEST 的 releaseRevision 必须是完整 40 位小写 git SHA");
  if (manifest.releaseRevision !== control.get("RELEASE_REVISION")) errors.push("DEPLOYMENT_RELEASE_MANIFEST 的 releaseRevision 必须匹配 RELEASE_REVISION");
  const issuedAt = Date.parse(manifest.issuedAt ?? "");
  const expiresAt = Date.parse(manifest.expiresAt ?? "");
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 30 * 24 * 60 * 60 * 1000 || issuedAt > Date.now() + 5 * 60 * 1000 || expiresAt <= Date.now()) errors.push("DEPLOYMENT_RELEASE_MANIFEST 的 issuedAt/expiresAt 必须为当前有效且不超过 30 天的时间窗口");
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.sbomSha256 ?? "")) errors.push("DEPLOYMENT_RELEASE_MANIFEST 缺少 SBOM SHA-256");
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.provenanceSha256 ?? "")) errors.push("DEPLOYMENT_RELEASE_MANIFEST 缺少 provenance SHA-256");
  const images = manifest.images;
  const imageKeys = [...controlImageKeys, ...runtimeImageKeys];
  if (!images || typeof images !== "object" || Array.isArray(images) || Object.keys(images).length !== imageKeys.length) {
    errors.push("DEPLOYMENT_RELEASE_MANIFEST 缺少服务镜像映射");
    return;
  }
  for (const key of controlImageKeys) if (images[key] !== controlCompose.get(key)) errors.push(`DEPLOYMENT_RELEASE_MANIFEST 的 ${key} 必须匹配控制面 Compose`);
  for (const key of runtimeImageKeys) if (images[key] !== runtime.get(key)) errors.push(`DEPLOYMENT_RELEASE_MANIFEST 的 ${key} 必须匹配运行时 Compose`);
  if (/^sha256:[a-f0-9]{64}$/.test(manifest.sbomSha256 ?? "") && /^sha256:[a-f0-9]{64}$/.test(manifest.provenanceSha256 ?? "")) await verifyReleaseEvidenceIndexes(manifest, manifestPath, imageKeys);
}

function equal(values, fileName, key, expected) {
  if (values.get(key) !== expected) {
    const message = `${fileName} 的 ${key} 必须为 ${expected}`;
    if (allowPlaceholders) warnings.push(message);
    else errors.push(message);
  }
}

function positiveInteger(values, fileName, key) {
  const value = Number(values.get(key));
  if (!Number.isInteger(value) || value <= 0) {
    const message = `${fileName} 的 ${key} 必须为正整数`;
    if (allowPlaceholders) warnings.push(message); else errors.push(message);
  }
}

function boundedPositiveInteger(values, fileName, key, minimum, maximum) {
  const value = Number(values.get(key));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    const message = `${fileName} 的 ${key} 必须是 ${minimum} 至 ${maximum} 的整数`;
    if (allowPlaceholders) warnings.push(message); else errors.push(message);
  }
}

function distinctActionSlots(values, fileName) {
  const keys = ["PROGRAM_AUDIOTYPE", "FALLBACK_AUDIOTYPE", "HUMAN_HANDOFF_AUDIOTYPE"];
  const slots = keys.map((key) => Number(values.get(key)));
  if (slots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot > 255)) {
    errors.push(`${fileName} 的节目、备用与人工接管动作索引必须是 0 至 255 的整数`);
    return;
  }
  if (new Set(slots).size !== slots.length) errors.push(`${fileName} 的节目、备用与人工接管动作索引必须互不相同`);
}

function privateSecret(values, fileName, key) {
  const value = values.get(key);
  if (!value || (allowPlaceholders && /replace-with|replace-me|example\.com|<|>/.test(value))) return;
  if (value.length < 32 || /\s/.test(value)) errors.push(`${fileName} 的 ${key} 必须是至少 32 个字符且不含空白的私网密钥`);
}

function previewBroker(values) {
  const url = values.get("PREVIEW_BROKER_URL") ?? "";
  const token = values.get("PREVIEW_BROKER_TOKEN") ?? "";
  if (Boolean(url) !== Boolean(token)) errors.push("Gateway 的 PREVIEW_BROKER_URL 与 PREVIEW_BROKER_TOKEN 必须同时配置或同时留空");
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error("invalid");
    } catch {
      errors.push("Gateway 的 PREVIEW_BROKER_URL 必须是不含嵌入凭据或片段的 HTTPS 基础地址");
    }
    privateSecret(values, "Gateway", "PREVIEW_BROKER_TOKEN");
  }
  boundedPositiveInteger(values, "Gateway", "PREVIEW_GRANT_MAX_SECONDS", 30, 3_600);
}

function mediaEvidenceVerifier(values) {
  const url = values.get("MEDIA_EVIDENCE_VERIFIER_URL") ?? "";
  try {
    const parsed = new URL(url);
    const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.hash || (parsed.protocol !== "https:" && !loopbackHttp)) throw new Error("invalid");
  } catch {
    errors.push("控制面 的 MEDIA_EVIDENCE_VERIFIER_URL 必须是不含嵌入凭据或片段的 HTTPS 地址");
  }
  privateSecret(values, "控制面", "MEDIA_EVIDENCE_VERIFIER_TOKEN");
  boundedPositiveInteger(values, "控制面", "MEDIA_EVIDENCE_VERIFIER_TIMEOUT_MS", 100, 60_000);
}

function recordingEvidenceVerifier(values) {
  const url = values.get("RECORDING_EVIDENCE_VERIFIER_URL") ?? "";
  try {
    const parsed = new URL(url);
    const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.hash || (parsed.protocol !== "https:" && !loopbackHttp)) throw new Error("invalid");
  } catch {
    errors.push("控制面 的 RECORDING_EVIDENCE_VERIFIER_URL 必须是不含嵌入凭据或片段的 HTTPS 地址");
  }
  privateSecret(values, "控制面", "RECORDING_EVIDENCE_VERIFIER_TOKEN");
  boundedPositiveInteger(values, "控制面", "RECORDING_EVIDENCE_VERIFIER_TIMEOUT_MS", 100, 60_000);
}

function outboundControlPlaneUrl(values, fileName) {
  const value = values.get("CONTROL_PLANE_URL");
  if (!value) return;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    if (url.username || url.password) throw new Error("credentials");
  } catch {
    errors.push(`${fileName} 的 CONTROL_PLANE_URL 必须是不含嵌入凭据的 HTTP(S) 地址`);
  }
}

function databasePrincipal(values, fileName, key) {
  const value = values.get(key);
  if (!value || (allowPlaceholders && /replace-with|replace-me|example\.com|<|>/.test(value))) return undefined;
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username) throw new Error("invalid");
    return decodeURIComponent(url.username);
  } catch {
    errors.push(`${fileName} 的 ${key} 必须是含独立用户名的 PostgreSQL 连接串`);
    return undefined;
  }
}

const [controlText, controlComposeText, runtimeText, gatewayText, channelAdapterText, alertNotifierText, lockText] = await Promise.all([files.control, files.controlCompose, files.runtime, files.gateway, files.channelAdapter, files.alertNotifier, files.lock].map((file) => readFile(file, "utf8").catch((error) => { errors.push(`无法读取 ${file}: ${error.message}`); return ""; })));
const control = parseEnv(controlText);
const controlCompose = parseEnv(controlComposeText);
const runtime = parseEnv(runtimeText);
const gateway = parseEnv(gatewayText);
const channelAdapter = parseEnv(channelAdapterText);
const alertNotifier = parseEnv(alertNotifierText);

required(control, "控制面", ["NODE_ENV", "DATABASE_URL", "DATABASE_QUERY_TIMEOUT_MS", "CONTROL_PLANE_DEMO_MODE", "RELEASE_REVISION", "DEPLOYMENT_RELEASE_MANIFEST", "DEPLOYMENT_RELEASE_MANIFEST_TRUST", "OIDC_ISSUER_URL", "OIDC_AUDIENCE", "OIDC_JWKS_URL", "OUTBOX_MAX_ATTEMPTS", "RUNTIME_GATEWAY_URL", "RUNTIME_SHARED_TOKEN", "RUNTIME_GATEWAY_DEMO_MODE", "RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS", "MEDIA_EVIDENCE_VERIFIER_URL", "MEDIA_EVIDENCE_VERIFIER_TOKEN", "MEDIA_EVIDENCE_VERIFIER_TIMEOUT_MS", "RECORDING_EVIDENCE_VERIFIER_URL", "RECORDING_EVIDENCE_VERIFIER_TOKEN", "RECORDING_EVIDENCE_VERIFIER_TIMEOUT_MS", "CHANNEL_EVIDENCE_VERIFIER_URL", "CHANNEL_EVIDENCE_VERIFIER_TOKEN", "CHANNEL_EVIDENCE_VERIFIER_TIMEOUT_MS", "RUNTIME_TELEMETRY_TENANT_TOKENS", "PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS", "PROGRAM_OUTPUT_VERIFIER_TRUST", "RUNTIME_RECORDING_TENANT_TOKENS", "PIM_INGEST_TENANT_TOKENS", "CHANNEL_INGEST_TENANT_TOKENS", "CHANNEL_COMMERCE_TENANT_TOKENS", "SETTLEMENT_INGEST_TENANT_TOKENS"]);
if (!allowPlaceholders && !/^[a-f0-9]{40}$/.test(control.get("RELEASE_REVISION") ?? "")) errors.push("控制面 的 RELEASE_REVISION 必须是完整 40 位小写 git SHA");
required(controlCompose, "控制面 Compose", ["CONTROL_PLANE_IMAGE", "CONTROL_PLANE_MIGRATOR_IMAGE"]);
required(runtime, "运行时", ["NVIDIA_VISIBLE_DEVICES", "RUNTIME_GATEWAY_IMAGE", "RUNTIME_WORKER_IMAGE", "RUNTIME_OBSERVER_IMAGE", "OUTPUT_PROBE_IMAGE", "CHANNEL_ADAPTER_IMAGE", "ALERT_NOTIFIER_IMAGE", "LIVETALKING_IMAGE", "COSYVOICE_IMAGE", "STREAM_OUTPUT_MODE", "STREAM_RTMP_URL", "STREAM_KEY_FILE", "STREAM_FPS", "RUNTIME_GATEWAY_URL", "RUNTIME_SHARED_TOKEN", "RUNTIME_GATEWAY_DEMO_MODE", "RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS", "CHANNEL_ADAPTER_URL", "CHANNEL_ADAPTER_DISPATCH_TOKEN", "RUNTIME_WORKER_DATABASE_URL", "CONTROL_PLANE_URL", "RUNTIME_OBSERVER_TARGETS_DIR", "RUNTIME_OBSERVER_POLL_MS", "RUNTIME_OBSERVER_TIMEOUT_MS", "RUNTIME_OBSERVER_FAIL_CLOSED", "RUNTIME_OBSERVER_PORT", "RUNTIME_WATCHDOG_POLL_MS", "RUNTIME_WATCHDOG_BATCH_SIZE", "RUNTIME_TELEMETRY_MAX_AGE_SECONDS", "USAGE_METER_POLL_MS", "PROGRAM_AUDIOTYPE", "FALLBACK_AUDIOTYPE", "HUMAN_HANDOFF_AUDIOTYPE", "OUTBOX_POLL_MS", "SCHEDULER_POLL_MS", "SCHEDULER_BATCH_SIZE", "OUTBOX_MAX_ATTEMPTS", "OUTBOX_LEASE_SECONDS", "OUTBOX_RETRY_BASE_MS", "OUTBOX_RETRY_MAX_MS", "RUNTIME_WORKER_PORT"]);
required(gateway, "Gateway", ["NVIDIA_VISIBLE_DEVICES", "RUNTIME_SHARED_TOKEN", "COSYVOICE_REQUIRED", "LIVETALKING_AVATAR_ID", "MODEL_VOLUME_PATH", "AVATAR_VOLUME_PATH", "RECORDINGS_VOLUME_PATH", "COSYVOICE_SAMPLE_RATE", "COSYVOICE_MODEL_DIR", "RUNTIME_REQUEST_TIMEOUT_SECONDS", "RUNTIME_COMMAND_JOURNAL_PATH", "RUNTIME_COMMAND_JOURNAL_REQUIRED", "RUNTIME_GATEWAY_STATE_PATH", "RUNTIME_GATEWAY_HOST_BIND", "PREVIEW_GRANT_MAX_SECONDS", "STREAM_RTMP_URL", "PROGRAM_AUDIOTYPE", "FALLBACK_AUDIOTYPE", "HUMAN_HANDOFF_AUDIOTYPE"]);
required(channelAdapter, "渠道适配器", ["CHANNEL_ADAPTER_DATABASE_URL", "DATABASE_QUERY_TIMEOUT_MS", "CONTROL_PLANE_URL", "CHANNEL_ADAPTER_PORT", "CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS", "CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE", "CHANNEL_ADAPTER_DISPATCH_TOKEN", "CHANNEL_ADAPTER_TARGETS"]);
required(alertNotifier, "告警通知器", ["ALERT_NOTIFIER_DATABASE_URL", "DATABASE_QUERY_TIMEOUT_MS", "ALERT_NOTIFIER_PORT", "ALERT_NOTIFIER_POLL_MS", "ALERT_NOTIFIER_LEASE_SECONDS", "ALERT_NOTIFIER_MAX_ATTEMPTS", "ALERT_NOTIFIER_RETRY_BASE_MS", "ALERT_NOTIFIER_RETRY_MAX_MS", "ALERT_NOTIFIER_TARGETS"]);
const controlImageKeys = ["CONTROL_PLANE_IMAGE", "CONTROL_PLANE_MIGRATOR_IMAGE"];
const runtimeImageKeys = ["RUNTIME_GATEWAY_IMAGE", "RUNTIME_WORKER_IMAGE", "RUNTIME_OBSERVER_IMAGE", "OUTPUT_PROBE_IMAGE", "CHANNEL_ADAPTER_IMAGE", "ALERT_NOTIFIER_IMAGE", "LIVETALKING_IMAGE", "COSYVOICE_IMAGE"];
immutableImages(controlCompose, "控制面 Compose", controlImageKeys);
immutableImages(runtime, "运行时", runtimeImageKeys);
const concreteImages = [...controlImageKeys.map((key) => controlCompose.get(key)), ...runtimeImageKeys.map((key) => runtime.get(key))].filter((value) => !(allowPlaceholders && isPlaceholder(value)));
if (concreteImages.length === 10 && new Set(concreteImages).size !== concreteImages.length) errors.push("控制面和运行时服务必须使用各自独立的不可变镜像摘要");
await verifyDeploymentReleaseManifest(control, controlCompose, runtime, controlImageKeys, runtimeImageKeys);
const databasePrincipals = [
  databasePrincipal(control, "控制面", "DATABASE_URL"),
  databasePrincipal(runtime, "运行时", "RUNTIME_WORKER_DATABASE_URL"),
  databasePrincipal(channelAdapter, "渠道适配器", "CHANNEL_ADAPTER_DATABASE_URL"),
  databasePrincipal(alertNotifier, "告警通知器", "ALERT_NOTIFIER_DATABASE_URL")
].filter(Boolean);
if (databasePrincipals.length === 4 && new Set(databasePrincipals).size !== databasePrincipals.length) errors.push("控制面、runtime worker、渠道适配器和告警通知器必须使用四个不同的 PostgreSQL 用户名");
outboundControlPlaneUrl(channelAdapter, "渠道适配器");
positiveInteger(channelAdapter, "渠道适配器", "CHANNEL_ADAPTER_PORT");
positiveInteger(channelAdapter, "渠道适配器", "CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS");
positiveInteger(channelAdapter, "渠道适配器", "CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE");
positiveInteger(control, "控制面", "OUTBOX_MAX_ATTEMPTS");
boundedPositiveInteger(control, "控制面", "DATABASE_QUERY_TIMEOUT_MS", 100, 60_000);
boundedPositiveInteger(control, "控制面", "RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS", 100, 60_000);
mediaEvidenceVerifier(control);
recordingEvidenceVerifier(control);
boundedPositiveInteger(runtime, "运行时", "DATABASE_QUERY_TIMEOUT_MS", 100, 60_000);
boundedPositiveInteger(channelAdapter, "渠道适配器", "DATABASE_QUERY_TIMEOUT_MS", 100, 60_000);
boundedPositiveInteger(alertNotifier, "告警通知器", "DATABASE_QUERY_TIMEOUT_MS", 100, 60_000);
for (const key of ["ALERT_NOTIFIER_PORT", "ALERT_NOTIFIER_POLL_MS", "ALERT_NOTIFIER_LEASE_SECONDS", "ALERT_NOTIFIER_MAX_ATTEMPTS", "ALERT_NOTIFIER_RETRY_BASE_MS", "ALERT_NOTIFIER_RETRY_MAX_MS"]) positiveInteger(alertNotifier, "告警通知器", key);
positiveInteger(gateway, "Gateway", "COSYVOICE_SAMPLE_RATE");
{
  const timeout = Number(gateway.get("RUNTIME_REQUEST_TIMEOUT_SECONDS"));
  if (!Number.isFinite(timeout) || timeout < 0.1 || timeout > 120) errors.push("Gateway 的 RUNTIME_REQUEST_TIMEOUT_SECONDS 必须是 0.1 至 120 的秒数");
}
distinctActionSlots(runtime, "运行时");
distinctActionSlots(gateway, "Gateway");
if (!gateway.get("COSYVOICE_MODEL_DIR")?.startsWith("/")) errors.push("Gateway 的 COSYVOICE_MODEL_DIR 必须是 CosyVoice 容器内的绝对路径");
if (!gateway.get("RUNTIME_COMMAND_JOURNAL_PATH")?.startsWith("/")) errors.push("Gateway 的 RUNTIME_COMMAND_JOURNAL_PATH 必须是私有持久化绝对路径");
equal(gateway, "Gateway", "RUNTIME_COMMAND_JOURNAL_REQUIRED", "true");
if (!gateway.get("RUNTIME_GATEWAY_STATE_PATH")?.startsWith("/")) errors.push("Gateway 的 RUNTIME_GATEWAY_STATE_PATH 必须是受控主机绝对路径");
if (["0.0.0.0", "::", "[::]"].includes(gateway.get("RUNTIME_GATEWAY_HOST_BIND") ?? "")) errors.push("Gateway 的 RUNTIME_GATEWAY_HOST_BIND 不得使用全网卡通配监听地址");
previewBroker(gateway);
if (requireCosyVoice) equal(gateway, "Gateway", "COSYVOICE_REQUIRED", "true");
// H3/D2 (15.13): the Gateway synthesizes every program script and speech command with CosyVoice.
if (!["sft", "zero_shot"].includes(gateway.get("COSYVOICE_MODEL_KIND") ?? "")) errors.push("CosyVoice 模型类型缺失或无效：Gateway 的 COSYVOICE_MODEL_KIND 必须为 sft 或 zero_shot");
if (!gateway.get("COSYVOICE_VOICE_LIBRARY_PATH")?.startsWith("/")) errors.push("Gateway 的 COSYVOICE_VOICE_LIBRARY_PATH 必须是已批准声线库的主机绝对路径");
if (gateway.has("COSYVOICE_CHUNK_MAX_CHARS")) boundedPositiveInteger(gateway, "Gateway", "COSYVOICE_CHUNK_MAX_CHARS", 20, 800);
if (gateway.has("RUNTIME_COMMAND_DEADLINE_SECONDS")) {
  boundedPositiveInteger(gateway, "Gateway", "RUNTIME_COMMAND_DEADLINE_SECONDS", 1, 59);
  const deadlineMs = Number(gateway.get("RUNTIME_COMMAND_DEADLINE_SECONDS")) * 1000;
  const workerTimeoutMs = Number(runtime.get("RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS"));
  if (Number.isFinite(deadlineMs) && Number.isFinite(workerTimeoutMs) && deadlineMs >= workerTimeoutMs) errors.push("Gateway 的 RUNTIME_COMMAND_DEADLINE_SECONDS 必须小于运行时 RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS，否则 worker 会在 Gateway 仍在合成时重试");
}
privateSecret(runtime, "运行时", "RUNTIME_SHARED_TOKEN");
privateSecret(gateway, "Gateway", "RUNTIME_SHARED_TOKEN");
privateSecret(control, "控制面", "RUNTIME_SHARED_TOKEN");
if (runtime.get("OUTPUT_PROBE_SHARED_TOKEN")) privateSecret(runtime, "运行时", "OUTPUT_PROBE_SHARED_TOKEN");
for (const key of ["STREAM_FPS", "RUNTIME_OBSERVER_POLL_MS", "RUNTIME_OBSERVER_TIMEOUT_MS", "RUNTIME_OBSERVER_PORT", "RUNTIME_WATCHDOG_POLL_MS", "RUNTIME_WATCHDOG_BATCH_SIZE", "RUNTIME_TELEMETRY_MAX_AGE_SECONDS", "USAGE_METER_POLL_MS", "OUTBOX_POLL_MS", "SCHEDULER_POLL_MS", "SCHEDULER_BATCH_SIZE", "OUTBOX_MAX_ATTEMPTS", "OUTBOX_LEASE_SECONDS", "OUTBOX_RETRY_BASE_MS", "OUTBOX_RETRY_MAX_MS", "RUNTIME_WORKER_PORT"]) positiveInteger(runtime, "运行时", key);
boundedPositiveInteger(runtime, "运行时", "RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS", 100, 60_000);
equal(control, "控制面", "NODE_ENV", "production");
// The development request-header identity switch must never be on in a deployment, placeholders or not.
if (control.get("CONTROL_PLANE_DEV_HEADER_IDENTITY") === "true") errors.push("控制面 的 CONTROL_PLANE_DEV_HEADER_IDENTITY 不得为 true（开发请求头身份开关）");
equal(control, "控制面", "CONTROL_PLANE_DEMO_MODE", "false");
equal(control, "控制面", "RUNTIME_GATEWAY_DEMO_MODE", "false");
if (!allowPlaceholders && !/^[0-9a-f]{7,40}$/i.test(control.get("RELEASE_REVISION") ?? "")) errors.push("控制面 的 RELEASE_REVISION 必须是 7 至 40 位 Git 提交");

const tenantServiceTokenMaps = new Map();
const tenantUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
for (const key of ["RUNTIME_TELEMETRY_TENANT_TOKENS", "PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS", "RUNTIME_RECORDING_TENANT_TOKENS", "PIM_INGEST_TENANT_TOKENS", "CHANNEL_INGEST_TENANT_TOKENS", "CHANNEL_COMMERCE_TENANT_TOKENS", "SETTLEMENT_INGEST_TENANT_TOKENS"]) {
  const value = control.get(key);
  try {
    const tokens = value ? JSON.parse(value) : null;
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens) || !Object.entries(tokens).every(([tenant, token]) => tenant.length > 0 && typeof token === "string" && token.length >= 32 && !/\s/.test(token))) throw new Error("invalid");
    tenantServiceTokenMaps.set(key, tokens);
  } catch {
    const message = `控制面 的 ${key} 必须是每租户独立服务密钥的 JSON 对象`;
    if (allowPlaceholders) warnings.push(message); else errors.push(message);
  }
}
const tokenOwners = new Map();
function claimPrivateToken(token, owner) {
  if (!token || (allowPlaceholders && /replace-with|replace-me|example\.com|<|>/.test(token))) return;
  const previousOwner = tokenOwners.get(token);
  if (previousOwner && previousOwner !== owner) errors.push("私网服务 token 不得跨服务或跨租户复用");
  else tokenOwners.set(token, owner);
}
for (const [service, tokens] of tenantServiceTokenMaps) {
  for (const [tenantId, token] of Object.entries(tokens)) {
    claimPrivateToken(token, `${service}:${tenantId}`);
  }
}
claimPrivateToken(runtime.get("RUNTIME_SHARED_TOKEN"), "runtime-gateway");
claimPrivateToken(control.get("MEDIA_EVIDENCE_VERIFIER_TOKEN"), "media-evidence-verifier");
claimPrivateToken(control.get("RECORDING_EVIDENCE_VERIFIER_TOKEN"), "recording-evidence-verifier");
claimPrivateToken(control.get("CHANNEL_EVIDENCE_VERIFIER_TOKEN"), "channel-evidence-verifier");
claimPrivateToken(runtime.get("CHANNEL_ADAPTER_DISPATCH_TOKEN"), "channel-adapter-dispatch");
if (runtime.get("CHANNEL_ADAPTER_DISPATCH_TOKEN") !== channelAdapter.get("CHANNEL_ADAPTER_DISPATCH_TOKEN")) errors.push("运行时与渠道适配器的 CHANNEL_ADAPTER_DISPATCH_TOKEN 必须一致");
claimPrivateToken(runtime.get("OUTPUT_PROBE_SHARED_TOKEN"), "output-probe");
try {
  const trust = JSON.parse(control.get("PROGRAM_OUTPUT_VERIFIER_TRUST") ?? "");
  if (!trust || typeof trust !== "object" || Array.isArray(trust) || !Object.entries(trust).every(([tenantId, value]) => tenantUuid.test(tenantId) && value && typeof value === "object" && !Array.isArray(value) && /^[a-z][a-z0-9_-]{1,63}$/.test(value.issuer ?? "") && value.keys && typeof value.keys === "object" && !Array.isArray(value.keys) && Object.entries(value.keys).length > 0 && Object.entries(value.keys).every(([keyId, pem]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId) || typeof pem !== "string") return false;
    try { return createPublicKey(pem).asymmetricKeyType === "ed25519"; } catch { return false; }
  }))) throw new Error("invalid");
  for (const tenantId of Object.keys(tenantServiceTokenMaps.get("PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS") ?? {})) if (!(tenantId in trust)) errors.push("PROGRAM_OUTPUT_VERIFIER_TRUST 必须覆盖每个输出证明租户");
} catch {
  const message = "控制面 的 PROGRAM_OUTPUT_VERIFIER_TRUST 必须是每租户 Ed25519 验证器公钥 JSON 对象";
  if (allowPlaceholders) warnings.push(message); else errors.push(message);
}
try {
  const targets = JSON.parse(channelAdapter.get("CHANNEL_ADAPTER_TARGETS") ?? "");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const privateProviderReplyEndpoint = (value) => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch { return false; }
  };
  const targetValid = (target) => target && typeof target === "object" && !Array.isArray(target)
    && uuid.test(target.tenantId ?? "") && uuid.test(target.channelConnectionId ?? "")
    && [target.signingSecret, target.interactionToken, target.commerceToken, target.providerReplyToken].every((value) => typeof value === "string" && value.length >= 32 && !/\s/.test(value))
    && privateProviderReplyEndpoint(target.providerReplyEndpoint)
    && new Set([target.signingSecret, target.interactionToken, target.commerceToken, target.providerReplyToken]).size === 4;
  if (!Array.isArray(targets) || !targets.length || !targets.every(targetValid)) throw new Error("invalid");
  const interactionTokens = tenantServiceTokenMaps.get("CHANNEL_INGEST_TENANT_TOKENS") ?? {};
  const commerceTokens = tenantServiceTokenMaps.get("CHANNEL_COMMERCE_TENANT_TOKENS") ?? {};
  for (const target of targets) {
    if (target.interactionToken !== interactionTokens[target.tenantId]) errors.push("渠道适配器的 interactionToken 必须匹配控制面同租户的 CHANNEL_INGEST_TENANT_TOKENS");
    if (target.commerceToken !== commerceTokens[target.tenantId]) errors.push("渠道适配器的 commerceToken 必须匹配控制面同租户的 CHANNEL_COMMERCE_TENANT_TOKENS");
    claimPrivateToken(target.signingSecret, `channel-adapter-signature:${target.tenantId}:${target.channelConnectionId}`);
    claimPrivateToken(target.providerReplyToken, `channel-adapter-reply:${target.tenantId}:${target.channelConnectionId}`);
  }
} catch {
  const message = "渠道适配器的 CHANNEL_ADAPTER_TARGETS 必须包含 UUID 租户/渠道、无嵌入凭据的 HTTPS providerReplyEndpoint 和四种不同的高熵密钥";
  if (allowPlaceholders) warnings.push(message); else errors.push(message);
}
try {
  const targets = JSON.parse(alertNotifier.get("ALERT_NOTIFIER_TARGETS") ?? "");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const targetValid = (target) => target && typeof target === "object" && !Array.isArray(target)
    && /^[A-Za-z0-9._-]{1,80}$/.test(target.id ?? "") && uuid.test(target.tenantId ?? "")
    && /^https:\/\//.test(target.webhookUrl ?? "") && typeof target.signingSecret === "string" && target.signingSecret.length >= 32 && !/\s/.test(target.signingSecret)
    && [undefined, "warning", "critical"].includes(target.minimumSeverity);
  if (!Array.isArray(targets) || !targets.length || !targets.every(targetValid)) throw new Error("invalid");
  for (const target of targets) claimPrivateToken(target.signingSecret, `alert-notifier-signature:${target.tenantId}:${target.id}`);
} catch {
  const message = "告警通知器的 ALERT_NOTIFIER_TARGETS 必须包含租户 UUID、HTTPS 目标、独立签名密钥和有效最低等级";
  if (allowPlaceholders) warnings.push(message); else errors.push(message);
}
equal(runtime, "运行时", "LIVE_MAX_CONCURRENT_AVATARS", "1");
equal(runtime, "运行时", "LIVE_ALLOW_LLM_FREEFORM", "false");
equal(runtime, "运行时", "LIVE_REQUIRE_HUMAN_HANDOFF_FOR_HIGH_RISK", "true");
equal(runtime, "运行时", "LIVE_REQUIRE_AI_DISCLOSURE", "true");
equal(runtime, "运行时", "LLM_MODE", "external");
equal(runtime, "运行时", "RUNTIME_GATEWAY_DEMO_MODE", "false");
equal(runtime, "运行时", "STREAM_OUTPUT_MODE", "rtmp");
equal(runtime, "运行时", "STREAM_FPS", "25");

try {
  const targets = parseObserverTargets(runtime.get("RUNTIME_OBSERVER_TARGETS") ?? "[]", "RUNTIME_OBSERVER_TARGETS");
  const telemetryTokens = tenantServiceTokenMaps.get("RUNTIME_TELEMETRY_TENANT_TOKENS") ?? {};
  const outputTokens = tenantServiceTokenMaps.get("PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS") ?? {};
  const outputProbeToken = runtime.get("OUTPUT_PROBE_SHARED_TOKEN");
  if (targets.length > 0 && (!outputProbeToken || outputProbeToken.length < 32 || /\s/.test(outputProbeToken) || (!allowPlaceholders && /replace-with|replace-me|example\.com|<|>/.test(outputProbeToken)))) errors.push("运行时 observer 目标需要有效的 OUTPUT_PROBE_SHARED_TOKEN");
  for (const target of targets) {
    if (target.telemetryToken !== telemetryTokens[target.tenantId]) errors.push("运行时 observer 的 telemetryToken 必须匹配控制面同租户的 RUNTIME_TELEMETRY_TENANT_TOKENS");
    if (target.programOutputToken !== outputTokens[target.tenantId]) errors.push("运行时 observer 的 programOutputToken 必须匹配控制面同租户的 PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS");
    if (target.outputProbeToken !== outputProbeToken) errors.push("运行时 observer 的 outputProbeToken 必须匹配 OUTPUT_PROBE_SHARED_TOKEN");
  }
} catch {
  const message = "运行时 的 RUNTIME_OBSERVER_TARGETS 必须是可选的有效场次/会话/遥测密钥/私网输出探针数组";
  if (allowPlaceholders) warnings.push(message); else errors.push(message);
}
if (!runtime.get("RUNTIME_OBSERVER_TARGETS_DIR")?.startsWith("/")) errors.push("运行时 的 RUNTIME_OBSERVER_TARGETS_DIR 必须是宿主机绝对路径");

try {
  const targets = JSON.parse(runtime.get("OUTPUT_PROBE_TARGETS") ?? "[]");
  if (!Array.isArray(targets)) throw new Error("invalid");
  if (requireOutputProbe && targets.length === 0) throw new Error("missing");
  targets.forEach((target, index) => validateOutputProbeTarget(target, index));
  if (targets.length > 0) {
    const token = runtime.get("OUTPUT_PROBE_SHARED_TOKEN");
    if (!token || (!allowPlaceholders && /replace-with|replace-me|example\.com|<|>/.test(token))) throw new Error("token");
  }
} catch {
  const message = requireOutputProbe
    ? "启用 output-probe 时，OUTPUT_PROBE_TARGETS 必须包含有效目标，且 OUTPUT_PROBE_SHARED_TOKEN 必须为独立非占位符密钥"
    : "OUTPUT_PROBE_TARGETS 必须为有效的探针目标数组；启用 output-probe 时还必须提供独立密钥";
  if (allowPlaceholders && !requireOutputProbe) warnings.push(message); else errors.push(message);
}

if (runtime.get("NVIDIA_VISIBLE_DEVICES") !== gateway.get("NVIDIA_VISIBLE_DEVICES")) errors.push("运行时与 Gateway 的 NVIDIA_VISIBLE_DEVICES 必须一致");
if (runtime.get("RUNTIME_SHARED_TOKEN") !== gateway.get("RUNTIME_SHARED_TOKEN")) errors.push("运行时与 Gateway 的 RUNTIME_SHARED_TOKEN 必须一致");
if (control.get("RUNTIME_SHARED_TOKEN") !== runtime.get("RUNTIME_SHARED_TOKEN")) errors.push("控制面与运行时的 RUNTIME_SHARED_TOKEN 必须一致");
if (control.get("RUNTIME_GATEWAY_DEMO_MODE") !== runtime.get("RUNTIME_GATEWAY_DEMO_MODE")) errors.push("控制面与运行时的 RUNTIME_GATEWAY_DEMO_MODE 必须一致");
if (runtime.get("STREAM_RTMP_URL") !== gateway.get("STREAM_RTMP_URL")) errors.push("运行时与 Gateway 的 STREAM_RTMP_URL 必须一致");

// H2: the RTMP stream key lives only in the file named by STREAM_KEY_FILE. Nothing below prints its content.
for (const [name, values] of [["运行时", runtime], ["Gateway", gateway], ["渠道适配器", channelAdapter], ["告警通知器", alertNotifier]]) {
  if (values.get("STREAM_KEY")) errors.push(`${name} env 文件不得定义 STREAM_KEY，请写入 STREAM_KEY_FILE 指向的文件`);
}
{
  const rtmpUrl = runtime.get("STREAM_RTMP_URL") ?? "";
  if (rtmpUrl && !(allowPlaceholders && isPlaceholder(rtmpUrl))) {
    let valid = false;
    try {
      const url = new URL(rtmpUrl);
      valid = ["rtmp:", "rtmps:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash && !rtmpUrl.includes("?") && !rtmpUrl.includes("#") && !rtmpUrl.endsWith("/");
    } catch {
      valid = false;
    }
    if (!valid) errors.push("运行时 的 STREAM_RTMP_URL 必须是不含凭据、查询串、片段且不以 / 结尾的 rtmp:// 或 rtmps:// 推流基址");
  }
  const keyFile = runtime.get("STREAM_KEY_FILE") ?? "";
  if (keyFile && !path.isAbsolute(keyFile)) errors.push("运行时 的 STREAM_KEY_FILE 必须是部署主机绝对路径");
  else if (keyFile && !allowPlaceholders) {
    const problem = await streamKeyFileProblem(keyFile);
    if (problem) errors.push(`运行时 的 STREAM_KEY_FILE 指向的密钥文件${problem}`);
  }
}

async function streamKeyFileProblem(file) {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return "不存在";
  }
  if (!info.isFile()) return "不是普通文件";
  let raw;
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(1025);
      const { bytesRead } = await handle.read(buffer, 0, 1025, 0);
      raw = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return "不可读";
  }
  let text = raw.toString("latin1");
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  if (!text.trim()) return "为空";
  if (text.length > 1024 || /[^\x21-\x7e]|["\\]/.test(text)) return "格式非法（只允许 1 至 1024 个不含空白、引号和反斜杠的可打印 ASCII 字符）";
  if (process.platform !== "win32") {
    if (info.mode & 0o022) return "可被同组或其他用户写入";
    if (info.mode & 0o004) return "可被其他用户读取";
  }
  return "";
}
if (runtime.get("PROGRAM_AUDIOTYPE") !== gateway.get("PROGRAM_AUDIOTYPE")) errors.push("运行时与 Gateway 的 PROGRAM_AUDIOTYPE 必须一致");
if (runtime.get("FALLBACK_AUDIOTYPE") !== gateway.get("FALLBACK_AUDIOTYPE")) errors.push("运行时与 Gateway 的 FALLBACK_AUDIOTYPE 必须一致");
if (runtime.get("HUMAN_HANDOFF_AUDIOTYPE") !== gateway.get("HUMAN_HANDOFF_AUDIOTYPE")) errors.push("运行时与 Gateway 的 HUMAN_HANDOFF_AUDIOTYPE 必须一致");
if (control.get("OUTBOX_MAX_ATTEMPTS") !== runtime.get("OUTBOX_MAX_ATTEMPTS")) errors.push("控制面与运行时的 OUTBOX_MAX_ATTEMPTS 必须一致");
if (control.get("RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS") !== runtime.get("RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS")) errors.push("控制面与运行时的 RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS 必须一致");

// L17 (Requirement 39.1-39.8): every lock entry is checked against its own Git tree and its parent's gitlink, and
// image sources come from the lock and the submodule commits, not from runtime env variables.
let lock;
try { lock = JSON.parse(lockText); } catch { errors.push("无法解析开源运行时锁文件"); }
if (lock !== undefined) errors.push(...verifyOpenSourceLock({ sourceRoot: files.sourceRoot, lock }));
// L18 (Requirement 39.11, 39.15): runtime/patches/LIVETALKING_MODIFICATIONS.md names the locked commit, its NOTICE
// state and exactly the files the patch series modifies, adds, deletes or renames.
if (lock !== undefined) errors.push(...verifyLiveTalkingNotice({ sourceRoot: files.sourceRoot, lock }));
for (const name of deprecatedRefVariables(runtime)) warnings.push(`${name} 已废弃，镜像源码以 runtime/open-source.lock.json 与子模块提交为准`);
try {
  const configDirectory = path.join(files.sourceRoot, "config");
  const templateNames = (await readdir(configDirectory)).filter((name) => name.endsWith(".example.env")).sort();
  const templates = await Promise.all(templateNames.map(async (name) => ({ file: `config/${name}`, text: await readFile(path.join(configDirectory, name), "utf8") })));
  errors.push(...checkTemplateRefVariables({ sourceRoot: files.sourceRoot, templates }));
} catch (error) {
  errors.push(`config/*.example.env 无法读取：${error instanceof Error ? error.message : "读取失败"}`);
}

try {
  const liveTalkingSource = path.join(files.sourceRoot, "vendor", "LiveTalking");
  const observabilityPatch = path.join(files.sourceRoot, "runtime", "patches", "livetalking-observability.patch");
  const liveTalkingDockerfile = path.join(files.sourceRoot, "runtime", "livetalking", "Dockerfile");
  const liveTalkingDockerignore = path.join(files.sourceRoot, "runtime", "livetalking", "Dockerfile.dockerignore");
  const streamSecretPatch = path.join(files.sourceRoot, "runtime", "patches", "livetalking-stream-secret.patch");
  const patchSeries = path.join(files.sourceRoot, "runtime", "patches", "livetalking.series");
  const localTtsPatch = path.join(files.sourceRoot, "runtime", "patches", "livetalking-local-tts.patch");
  const [patchText, streamSecretText, localTtsText, dockerfileText, dockerignoreText] = await Promise.all([readFile(observabilityPatch, "utf8"), readFile(streamSecretPatch, "utf8"), readFile(localTtsPatch, "utf8"), readFile(liveTalkingDockerfile, "utf8"), readFile(liveTalkingDockerignore, "utf8")]);
  // H3: --tts none loads a plugin that never synthesizes, and an unknown --tts value stops startup.
  for (const expected of ["@register(\"tts\", \"none\")", "'none': 'tts.none_tts'", "raise ValueError(f\"unsupported --tts value: {opt.tts}\")", "+tts: none"]) if (!localTtsText.includes(expected)) errors.push(`LiveTalking 本地 TTS 补丁缺少禁用合成的挂接：${expected}`);
  if (!patchText.includes("/api/admin/runtime-metrics")) errors.push("LiveTalking 观测补丁缺少运行时指标接口");
  if (!patchText.includes("last_output_error=type(error).__name__")) errors.push("LiveTalking 观测指标不得暴露原始推流异常内容");
  // H2: the stream key is read from --stream_key_file and redacted from option logs, RTMP logs, errors and HTTP responses.
  for (const expected of ["parser.add_argument('--stream_key_file'", "apply_stream_key(opt)", "install_log_redaction([logger])", "logger.info(redacted_options(opt))", "middlewares=[secret_redaction_middleware()]", "redacted_options_dict(opt)", "redact_text(str(msg))", "redact_push_url(self.push_url)", "RTMP streamer init failed: {type(error).__name__}\") from None", "RTMP stream_frame failed: {type(error).__name__}\") from None"]) {
    if (!streamSecretText.includes(expected)) errors.push(`LiveTalking 推流密钥补丁缺少脱敏挂接：${expected}`);
  }
  for (const expected of ["COPY runtime/patches/livetalking.series runtime/patches/livetalking-*.patch /tmp/livetalking-patches/", "done < /tmp/livetalking-patches/livetalking.series", "git apply --check --recount \"/tmp/livetalking-patches/$patch\"", "COPY runtime/livetalking/launcher.py runtime/livetalking/shuzhiren_secrets.py /opt/shuzhiren/", "ENV PYTHONPATH=/opt/shuzhiren", "ENTRYPOINT [\"python3\", \"/opt/shuzhiren/launcher.py\"]"]) {
    if (!dockerfileText.includes(expected)) errors.push(`LiveTalking 镜像没有按补丁序列构建或没有以脱敏启动器运行：${expected}`);
  }
  for (const expected of ["USER livetalking", "ENV HOME=/tmp", "chown -R livetalking:livetalking /app"]) if (!dockerfileText.includes(expected)) errors.push(`LiveTalking 镜像必须以非 root 用户运行：${expected}`);
  const context = checkDockerignore(dockerignoreText, { mustExclude: LIVETALKING_CONTEXT_EXCLUDED, mustInclude: LIVETALKING_CONTEXT_INCLUDED });
  for (const file of context.leaked) errors.push(`LiveTalking 镜像构建上下文会带入敏感或无关内容：${file}`);
  for (const file of context.missing) errors.push(`LiveTalking 镜像构建上下文缺少构建所需文件：${file}`);
  if (!dockerfileText.includes("mkdir -p /app/models /app/data/avatars /app/data/record")) errors.push("LiveTalking 镜像必须保留 /app/models、/app/data/avatars、/app/data/record 挂载点目录");
  const series = checkPatchSeries({ sourceDir: liveTalkingSource, seriesFile: patchSeries });
  for (const required of ["livetalking-observability.patch", "livetalking-stream-secret.patch", "livetalking-local-tts.patch"]) if (!series.patches.includes(required)) errors.push(`LiveTalking 补丁序列缺少 ${required}`);
  for (const { patch, message } of series.failures) errors.push(`LiveTalking 补丁 ${patch} 无法应用到锁定提交 ${series.commit}：${message}`);
} catch (error) {
  errors.push(`LiveTalking 观测补丁不可验证：${error instanceof Error ? error.message : "补丁检查失败"}`);
}

// Runtime Compose must take every value Deploy_Check validates from these env files (M7).
try {
  const runtimeComposeDoc = yaml.load(await readFile(path.join(files.sourceRoot, "infra", "compose", "docker-compose.runtime.yml"), "utf8"));
  const envFiles = [["runtime", files.runtime, runtime], ["gateway", files.gateway, gateway], ["channelAdapter", files.channelAdapter, channelAdapter], ["alertNotifier", files.alertNotifier, alertNotifier]].map(([id, file, values]) => ({ id, path: file, values }));
  for (const { code, message } of checkRuntimeComposeConsistency({ composeDoc: runtimeComposeDoc, envFiles }).errors) errors.push(`[${code}] ${message}`);
  for (const message of streamKeyComposeProblems(runtimeComposeDoc)) errors.push(message);
  for (const message of liveTalkingTtsComposeProblems(runtimeComposeDoc)) errors.push(message);
} catch (error) {
  errors.push(`[RC-PARSE] 运行时 Compose 无法解析：${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
}

try {
  const composePath = path.join(files.sourceRoot, "infra", "compose", "docker-compose.runtime.yml");
  const liveTalkingConfig = path.join(files.sourceRoot, "vendor", "LiveTalking", "config.py");
  const liveTalkingRtmp = path.join(files.sourceRoot, "vendor", "LiveTalking", "streamout", "rtmp.py");
  const cosyVoiceServer = path.join(files.sourceRoot, "vendor", "CosyVoice", "runtime", "python", "fastapi", "server.py");
  const gatewayApp = path.join(files.sourceRoot, "runtime", "gateway", "app.py");
  const gatewayDockerfile = path.join(files.sourceRoot, "runtime", "gateway", "Dockerfile");
  const observerDockerfile = path.join(files.sourceRoot, "apps", "runtime-observer", "Dockerfile");
  const [compose, config, rtmp, cosyVoice, gatewayAppText, gatewayDockerfileText, observerDockerfileText] = await Promise.all([composePath, liveTalkingConfig, liveTalkingRtmp, cosyVoiceServer, gatewayApp, gatewayDockerfile, observerDockerfile].map((file) => readFile(file, "utf8")));
  for (const expected of ["--transport rtmp", "--model musetalk", "--avatar_id", "--listenport 8010", "--max_session 1", "--fps ${STREAM_FPS:-25}", "--push_url", "COSYVOICE_SAMPLE_RATE: ${COSYVOICE_SAMPLE_RATE:-24000}"]) if (!compose.includes(expected)) errors.push(`运行时 Compose 缺少受支持的启动契约：${expected}`);
  for (const expected of ["RUNTIME_OBSERVER_TARGETS_FILE: /run/shuzhiren/observer-config/runtime-observer-targets.json", "${RUNTIME_OBSERVER_TARGETS_DIR:-../../config}:/run/shuzhiren/observer-config:ro", "OUTPUT_PROBE_TARGETS: ${OUTPUT_PROBE_TARGETS:-[]}", "CHANNEL_ADAPTER_TARGETS: ${CHANNEL_ADAPTER_TARGETS:-[]}", "ALERT_NOTIFIER_TARGETS: ${ALERT_NOTIFIER_TARGETS:-[]}"]) if (!compose.includes(expected)) errors.push(`运行时 Compose 的可选 profile 解析契约缺失：${expected}`);
  for (const expected of ["parser.add_argument('--transport'", "parser.add_argument('--model'", "parser.add_argument('--avatar_id'", "parser.add_argument('--listenport'", "parser.add_argument('--max_session'", "parser.add_argument('--fps'", "parser.add_argument('--push_url'"]) if (!config.includes(expected)) errors.push(`锁定 LiveTalking 源码不再支持 Compose 所需参数：${expected}`);
  if (!rtmp.includes("sc.stream_server = self.push_url")) errors.push("锁定 LiveTalking 源码不再将 push_url 绑定到 RTMP 输出");
  if (!cosyVoice.includes("return StreamingResponse(generate_data(model_output))") || !cosyVoice.includes("tts_speech")) errors.push("锁定 CosyVoice FastAPI 不再输出原始语音 PCM 流");
  if (!gatewayAppText.includes('COSYVOICE_SAMPLE_RATE = int(os.environ.get("COSYVOICE_SAMPLE_RATE", "24000"))') || !gatewayAppText.includes("pcm_s16le_to_wav")) errors.push("Gateway 未以 24 kHz 配置封装 CosyVoice PCM");
  if (!/COPY(?:\s+--chown=[^\s]+)?\s+app\.py\s+audio\.py\s+\./.test(gatewayDockerfileText)) errors.push("Gateway 镜像缺少 PCM/WAV 封装模块");
  if (!/COPY(?:\s+--chown=[^\s]+)?\s+apps\/runtime-observer\/targets\.mjs\s+\.\/targets\.mjs/.test(observerDockerfileText)) errors.push("Runtime observer 镜像缺少受管目标解析模块");
} catch (error) {
  errors.push(`开源运行时启动契约不可验证：${error instanceof Error ? error.message : "读取失败"}`);
}

for (const warning of warnings) console.warn(`WARN  ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exitCode = 1;
} else {
  console.log(`PASS  部署配置预检通过 (${allowPlaceholders ? "仅模板结构校验" : "生产配置"})`);
}
