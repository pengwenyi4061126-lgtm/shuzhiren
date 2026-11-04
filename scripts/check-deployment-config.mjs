import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTarget as validateOutputProbeTarget } from "../apps/output-probe/lib.mjs";
import { parseObserverTargets } from "../apps/runtime-observer/targets.mjs";

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

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const [controlText, runtimeText, gatewayText, channelAdapterText, alertNotifierText, lockText] = await Promise.all([files.control, files.runtime, files.gateway, files.channelAdapter, files.alertNotifier, files.lock].map((file) => readFile(file, "utf8").catch((error) => { errors.push(`无法读取 ${file}: ${error.message}`); return ""; })));
const control = parseEnv(controlText);
const runtime = parseEnv(runtimeText);
const gateway = parseEnv(gatewayText);
const channelAdapter = parseEnv(channelAdapterText);
const alertNotifier = parseEnv(alertNotifierText);

required(control, "控制面", ["NODE_ENV", "DATABASE_URL", "DATABASE_QUERY_TIMEOUT_MS", "CONTROL_PLANE_DEMO_MODE", "RELEASE_REVISION", "OIDC_ISSUER_URL", "OIDC_AUDIENCE", "OIDC_JWKS_URL", "OUTBOX_MAX_ATTEMPTS", "RUNTIME_GATEWAY_URL", "RUNTIME_SHARED_TOKEN", "RUNTIME_GATEWAY_DEMO_MODE", "RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS", "RUNTIME_TELEMETRY_TENANT_TOKENS", "RUNTIME_RECORDING_TENANT_TOKENS", "PIM_INGEST_TENANT_TOKENS", "CHANNEL_INGEST_TENANT_TOKENS", "CHANNEL_COMMERCE_TENANT_TOKENS"]);
required(runtime, "运行时", ["NVIDIA_VISIBLE_DEVICES", "STREAM_OUTPUT_MODE", "STREAM_RTMP_URL", "STREAM_KEY", "STREAM_FPS", "LIVETALKING_REF", "MUSETALK_REF", "COSYVOICE_REF", "RUNTIME_GATEWAY_URL", "RUNTIME_SHARED_TOKEN", "RUNTIME_GATEWAY_DEMO_MODE", "RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS", "CHANNEL_ADAPTER_URL", "CHANNEL_ADAPTER_DISPATCH_TOKEN", "RUNTIME_WORKER_DATABASE_URL", "CONTROL_PLANE_URL", "RUNTIME_OBSERVER_TARGETS_DIR", "RUNTIME_OBSERVER_POLL_MS", "RUNTIME_OBSERVER_TIMEOUT_MS", "RUNTIME_OBSERVER_FAIL_CLOSED", "RUNTIME_OBSERVER_PORT", "RUNTIME_WATCHDOG_POLL_MS", "RUNTIME_WATCHDOG_BATCH_SIZE", "RUNTIME_TELEMETRY_MAX_AGE_SECONDS", "USAGE_METER_POLL_MS", "PROGRAM_AUDIOTYPE", "FALLBACK_AUDIOTYPE", "HUMAN_HANDOFF_AUDIOTYPE", "OUTBOX_MAX_ATTEMPTS", "OUTBOX_LEASE_SECONDS", "OUTBOX_RETRY_BASE_MS", "OUTBOX_RETRY_MAX_MS", "RUNTIME_WORKER_PORT"]);
required(gateway, "Gateway", ["NVIDIA_VISIBLE_DEVICES", "RUNTIME_SHARED_TOKEN", "COSYVOICE_REQUIRED", "LIVETALKING_AVATAR_ID", "MODEL_VOLUME_PATH", "AVATAR_VOLUME_PATH", "RECORDINGS_VOLUME_PATH", "COSYVOICE_SAMPLE_RATE", "COSYVOICE_MODEL_DIR", "RUNTIME_COMMAND_JOURNAL_PATH", "RUNTIME_COMMAND_JOURNAL_REQUIRED", "RUNTIME_GATEWAY_STATE_PATH", "RUNTIME_GATEWAY_HOST_BIND", "PREVIEW_GRANT_MAX_SECONDS", "STREAM_RTMP_URL", "STREAM_KEY", "PROGRAM_AUDIOTYPE", "FALLBACK_AUDIOTYPE", "HUMAN_HANDOFF_AUDIOTYPE"]);
required(channelAdapter, "渠道适配器", ["CHANNEL_ADAPTER_DATABASE_URL", "DATABASE_QUERY_TIMEOUT_MS", "CONTROL_PLANE_URL", "CHANNEL_ADAPTER_PORT", "CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS", "CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE", "CHANNEL_ADAPTER_DISPATCH_TOKEN", "CHANNEL_ADAPTER_TARGETS"]);
required(alertNotifier, "告警通知器", ["ALERT_NOTIFIER_DATABASE_URL", "DATABASE_QUERY_TIMEOUT_MS", "ALERT_NOTIFIER_PORT", "ALERT_NOTIFIER_POLL_MS", "ALERT_NOTIFIER_LEASE_SECONDS", "ALERT_NOTIFIER_MAX_ATTEMPTS", "ALERT_NOTIFIER_RETRY_BASE_MS", "ALERT_NOTIFIER_RETRY_MAX_MS", "ALERT_NOTIFIER_TARGETS"]);
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
boundedPositiveInteger(runtime, "运行时", "DATABASE_QUERY_TIMEOUT_MS", 100, 60_000);
boundedPositiveInteger(channelAdapter, "渠道适配器", "DATABASE_QUERY_TIMEOUT_MS", 100, 60_000);
boundedPositiveInteger(alertNotifier, "告警通知器", "DATABASE_QUERY_TIMEOUT_MS", 100, 60_000);
for (const key of ["ALERT_NOTIFIER_PORT", "ALERT_NOTIFIER_POLL_MS", "ALERT_NOTIFIER_LEASE_SECONDS", "ALERT_NOTIFIER_MAX_ATTEMPTS", "ALERT_NOTIFIER_RETRY_BASE_MS", "ALERT_NOTIFIER_RETRY_MAX_MS"]) positiveInteger(alertNotifier, "告警通知器", key);
positiveInteger(gateway, "Gateway", "COSYVOICE_SAMPLE_RATE");
distinctActionSlots(runtime, "运行时");
distinctActionSlots(gateway, "Gateway");
if (!gateway.get("COSYVOICE_MODEL_DIR")?.startsWith("/")) errors.push("Gateway 的 COSYVOICE_MODEL_DIR 必须是 CosyVoice 容器内的绝对路径");
if (!gateway.get("RUNTIME_COMMAND_JOURNAL_PATH")?.startsWith("/")) errors.push("Gateway 的 RUNTIME_COMMAND_JOURNAL_PATH 必须是私有持久化绝对路径");
equal(gateway, "Gateway", "RUNTIME_COMMAND_JOURNAL_REQUIRED", "true");
if (!gateway.get("RUNTIME_GATEWAY_STATE_PATH")?.startsWith("/")) errors.push("Gateway 的 RUNTIME_GATEWAY_STATE_PATH 必须是受控主机绝对路径");
if (["0.0.0.0", "::", "[::]"].includes(gateway.get("RUNTIME_GATEWAY_HOST_BIND") ?? "")) errors.push("Gateway 的 RUNTIME_GATEWAY_HOST_BIND 不得使用全网卡通配监听地址");
previewBroker(gateway);
if (requireCosyVoice) equal(gateway, "Gateway", "COSYVOICE_REQUIRED", "true");
privateSecret(runtime, "运行时", "RUNTIME_SHARED_TOKEN");
privateSecret(gateway, "Gateway", "RUNTIME_SHARED_TOKEN");
privateSecret(control, "控制面", "RUNTIME_SHARED_TOKEN");
if (runtime.get("OUTPUT_PROBE_SHARED_TOKEN")) privateSecret(runtime, "运行时", "OUTPUT_PROBE_SHARED_TOKEN");
for (const key of ["STREAM_FPS", "RUNTIME_OBSERVER_POLL_MS", "RUNTIME_OBSERVER_TIMEOUT_MS", "RUNTIME_OBSERVER_PORT", "RUNTIME_WATCHDOG_POLL_MS", "RUNTIME_WATCHDOG_BATCH_SIZE", "RUNTIME_TELEMETRY_MAX_AGE_SECONDS", "USAGE_METER_POLL_MS", "OUTBOX_MAX_ATTEMPTS", "OUTBOX_LEASE_SECONDS", "OUTBOX_RETRY_BASE_MS", "OUTBOX_RETRY_MAX_MS", "RUNTIME_WORKER_PORT"]) positiveInteger(runtime, "运行时", key);
boundedPositiveInteger(runtime, "运行时", "RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS", 100, 60_000);
equal(control, "控制面", "NODE_ENV", "production");
equal(control, "控制面", "CONTROL_PLANE_DEMO_MODE", "false");
equal(control, "控制面", "RUNTIME_GATEWAY_DEMO_MODE", "false");
if (!allowPlaceholders && !/^[0-9a-f]{7,40}$/i.test(control.get("RELEASE_REVISION") ?? "")) errors.push("控制面 的 RELEASE_REVISION 必须是 7 至 40 位 Git 提交");

const tenantServiceTokenMaps = new Map();
for (const key of ["RUNTIME_TELEMETRY_TENANT_TOKENS", "RUNTIME_RECORDING_TENANT_TOKENS", "PIM_INGEST_TENANT_TOKENS", "CHANNEL_INGEST_TENANT_TOKENS", "CHANNEL_COMMERCE_TENANT_TOKENS"]) {
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
claimPrivateToken(runtime.get("CHANNEL_ADAPTER_DISPATCH_TOKEN"), "channel-adapter-dispatch");
if (runtime.get("CHANNEL_ADAPTER_DISPATCH_TOKEN") !== channelAdapter.get("CHANNEL_ADAPTER_DISPATCH_TOKEN")) errors.push("运行时与渠道适配器的 CHANNEL_ADAPTER_DISPATCH_TOKEN 必须一致");
claimPrivateToken(runtime.get("OUTPUT_PROBE_SHARED_TOKEN"), "output-probe");
try {
  const targets = JSON.parse(channelAdapter.get("CHANNEL_ADAPTER_TARGETS") ?? "");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const targetValid = (target) => target && typeof target === "object" && !Array.isArray(target)
    && uuid.test(target.tenantId ?? "") && uuid.test(target.channelConnectionId ?? "")
    && [target.signingSecret, target.interactionToken, target.commerceToken, target.providerReplyToken].every((value) => typeof value === "string" && value.length >= 32 && !/\s/.test(value))
    && typeof target.providerReplyEndpoint === "string" && /^https?:\/\//.test(target.providerReplyEndpoint) && !/\/@/.test(target.providerReplyEndpoint)
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
  const message = "渠道适配器的 CHANNEL_ADAPTER_TARGETS 必须包含 UUID 租户/渠道、私有 providerReplyEndpoint 和四种不同的高熵密钥";
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
  const outputProbeToken = runtime.get("OUTPUT_PROBE_SHARED_TOKEN");
  if (targets.length > 0 && (!outputProbeToken || outputProbeToken.length < 32 || /\s/.test(outputProbeToken) || (!allowPlaceholders && /replace-with|replace-me|example\.com|<|>/.test(outputProbeToken)))) errors.push("运行时 observer 目标需要有效的 OUTPUT_PROBE_SHARED_TOKEN");
  for (const target of targets) {
    if (target.telemetryToken !== telemetryTokens[target.tenantId]) errors.push("运行时 observer 的 telemetryToken 必须匹配控制面同租户的 RUNTIME_TELEMETRY_TENANT_TOKENS");
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
if (runtime.get("STREAM_KEY") !== gateway.get("STREAM_KEY")) errors.push("运行时与 Gateway 的 STREAM_KEY 必须一致");
if (runtime.get("PROGRAM_AUDIOTYPE") !== gateway.get("PROGRAM_AUDIOTYPE")) errors.push("运行时与 Gateway 的 PROGRAM_AUDIOTYPE 必须一致");
if (runtime.get("FALLBACK_AUDIOTYPE") !== gateway.get("FALLBACK_AUDIOTYPE")) errors.push("运行时与 Gateway 的 FALLBACK_AUDIOTYPE 必须一致");
if (runtime.get("HUMAN_HANDOFF_AUDIOTYPE") !== gateway.get("HUMAN_HANDOFF_AUDIOTYPE")) errors.push("运行时与 Gateway 的 HUMAN_HANDOFF_AUDIOTYPE 必须一致");
if (control.get("OUTBOX_MAX_ATTEMPTS") !== runtime.get("OUTBOX_MAX_ATTEMPTS")) errors.push("控制面与运行时的 OUTBOX_MAX_ATTEMPTS 必须一致");
if (control.get("RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS") !== runtime.get("RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS")) errors.push("控制面与运行时的 RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS 必须一致");

try {
  const lock = JSON.parse(lockText);
  if (!Array.isArray(lock.components) || lock.components.length < 3) errors.push("开源运行时锁文件缺少组件");
  else {
    const envKeys = {
      MuseTalk: "MUSETALK_REF",
      CosyVoice: "COSYVOICE_REF",
      LiveTalking: "LIVETALKING_REF"
    };
    const expectedComponents = new Set(Object.keys(envKeys));
    const lockedNames = new Set();
    for (const component of lock.components) {
      const name = component.name ?? "未知组件";
      lockedNames.add(name);
      if (!/^[0-9a-f]{40}$/i.test(component.commit ?? "")) {
        errors.push(`${name} 没有固定 40 位 Git 提交`);
        continue;
      }
      if (!component.license) errors.push(`${name} 缺少许可证记录`);
      const envKey = envKeys[name];
      if (!envKey) continue;
      equal(runtime, "运行时", envKey, component.commit);

      const sourceDirectory = path.join(files.sourceRoot, "vendor", name);
      try {
        const actualCommit = git(sourceDirectory, ["rev-parse", "HEAD"]);
        if (actualCommit !== component.commit) errors.push(`${name} 源码 HEAD ${actualCommit} 与锁定提交 ${component.commit} 不一致`);
        if (git(sourceDirectory, ["status", "--porcelain"])) errors.push(`${name} 源码目录存在未提交修改，禁止用于生产镜像构建`);
      } catch (error) {
        errors.push(`${name} 源码目录不可验证：${error instanceof Error ? error.message : "git 检查失败"}`);
      }
    }
    for (const name of expectedComponents) if (!lockedNames.has(name)) errors.push(`开源运行时锁文件缺少 ${name}`);
  }
} catch { errors.push("无法解析开源运行时锁文件"); }

try {
  const liveTalkingSource = path.join(files.sourceRoot, "vendor", "LiveTalking");
  const observabilityPatch = path.join(files.sourceRoot, "runtime", "patches", "livetalking-observability.patch");
  const liveTalkingDockerfile = path.join(files.sourceRoot, "runtime", "livetalking", "Dockerfile");
  const liveTalkingDockerignore = path.join(files.sourceRoot, "runtime", "livetalking", "Dockerfile.dockerignore");
  const [patchText, dockerfileText, dockerignoreText] = await Promise.all([readFile(observabilityPatch, "utf8"), readFile(liveTalkingDockerfile, "utf8"), readFile(liveTalkingDockerignore, "utf8")]);
  if (!patchText.includes("/api/admin/runtime-metrics")) errors.push("LiveTalking 观测补丁缺少运行时指标接口");
  if (!patchText.includes("last_output_error=type(error).__name__")) errors.push("LiveTalking 观测指标不得暴露原始推流异常内容");
  if (!dockerfileText.includes("livetalking-observability.patch") || !dockerfileText.includes("git apply --check --recount")) errors.push("LiveTalking 镜像没有强制应用观测补丁");
  for (const expected of ["USER livetalking", "ENV HOME=/tmp", "chown -R livetalking:livetalking /app"]) if (!dockerfileText.includes(expected)) errors.push(`LiveTalking 镜像必须以非 root 用户运行：${expected}`);
  for (const expected of ["vendor/*", "!vendor/LiveTalking/**", "runtime/patches/livetalking-observability.patch"]) if (!dockerignoreText.includes(expected)) errors.push(`LiveTalking 镜像构建上下文缺少最小化规则：${expected}`);
  git(liveTalkingSource, ["apply", "--check", "--recount", observabilityPatch]);
} catch (error) {
  errors.push(`LiveTalking 观测补丁不可验证：${error instanceof Error ? error.message : "补丁检查失败"}`);
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
