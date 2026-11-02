import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowPlaceholders = process.argv.includes("--allow-placeholders");
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

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const [controlText, runtimeText, gatewayText, channelAdapterText, alertNotifierText, lockText] = await Promise.all([files.control, files.runtime, files.gateway, files.channelAdapter, files.alertNotifier, files.lock].map((file) => readFile(file, "utf8").catch((error) => { errors.push(`无法读取 ${file}: ${error.message}`); return ""; })));
const control = parseEnv(controlText);
const runtime = parseEnv(runtimeText);
const gateway = parseEnv(gatewayText);
const channelAdapter = parseEnv(channelAdapterText);
const alertNotifier = parseEnv(alertNotifierText);

required(control, "控制面", ["NODE_ENV", "DATABASE_URL", "CONTROL_PLANE_DEMO_MODE", "OIDC_ISSUER_URL", "OIDC_AUDIENCE", "OIDC_JWKS_URL", "RUNTIME_TELEMETRY_TENANT_TOKENS", "RUNTIME_RECORDING_TENANT_TOKENS", "PIM_INGEST_TENANT_TOKENS", "CHANNEL_INGEST_TENANT_TOKENS", "CHANNEL_COMMERCE_TENANT_TOKENS", "RUNTIME_SPEECH_VOICE"]);
required(runtime, "运行时", ["NVIDIA_VISIBLE_DEVICES", "STREAM_RTMP_URL", "STREAM_KEY", "LIVETALKING_REF", "MUSETALK_REF", "COSYVOICE_REF", "RUNTIME_GATEWAY_URL", "RUNTIME_SHARED_TOKEN", "CONTROL_PLANE_URL", "RUNTIME_OBSERVER_TARGETS", "RUNTIME_OBSERVER_POLL_MS", "RUNTIME_OBSERVER_TIMEOUT_MS", "RUNTIME_OBSERVER_FAIL_CLOSED", "RUNTIME_WATCHDOG_POLL_MS", "RUNTIME_WATCHDOG_BATCH_SIZE", "RUNTIME_TELEMETRY_MAX_AGE_SECONDS", "USAGE_METER_POLL_MS", "PROGRAM_AUDIOTYPE", "FALLBACK_AUDIOTYPE", "HUMAN_HANDOFF_AUDIOTYPE", "OUTBOX_MAX_ATTEMPTS", "OUTBOX_LEASE_SECONDS", "OUTBOX_RETRY_BASE_MS", "OUTBOX_RETRY_MAX_MS"]);
required(gateway, "Gateway", ["NVIDIA_VISIBLE_DEVICES", "RUNTIME_SHARED_TOKEN", "LIVETALKING_AVATAR_ID", "MODEL_VOLUME_PATH", "AVATAR_VOLUME_PATH", "RECORDINGS_VOLUME_PATH", "STREAM_RTMP_URL", "STREAM_KEY", "PROGRAM_AUDIOTYPE", "FALLBACK_AUDIOTYPE", "HUMAN_HANDOFF_AUDIOTYPE"]);
required(channelAdapter, "渠道适配器", ["DATABASE_URL", "CONTROL_PLANE_URL", "CHANNEL_ADAPTER_PORT", "CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS", "CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE", "CHANNEL_ADAPTER_TARGETS"]);
required(alertNotifier, "告警通知器", ["DATABASE_URL", "ALERT_NOTIFIER_PORT", "ALERT_NOTIFIER_POLL_MS", "ALERT_NOTIFIER_LEASE_SECONDS", "ALERT_NOTIFIER_MAX_ATTEMPTS", "ALERT_NOTIFIER_RETRY_BASE_MS", "ALERT_NOTIFIER_RETRY_MAX_MS", "ALERT_NOTIFIER_TARGETS"]);
positiveInteger(channelAdapter, "渠道适配器", "CHANNEL_ADAPTER_PORT");
positiveInteger(channelAdapter, "渠道适配器", "CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS");
positiveInteger(channelAdapter, "渠道适配器", "CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE");
for (const key of ["ALERT_NOTIFIER_PORT", "ALERT_NOTIFIER_POLL_MS", "ALERT_NOTIFIER_LEASE_SECONDS", "ALERT_NOTIFIER_MAX_ATTEMPTS", "ALERT_NOTIFIER_RETRY_BASE_MS", "ALERT_NOTIFIER_RETRY_MAX_MS"]) positiveInteger(alertNotifier, "告警通知器", key);
for (const key of ["RUNTIME_OBSERVER_POLL_MS", "RUNTIME_OBSERVER_TIMEOUT_MS", "RUNTIME_WATCHDOG_POLL_MS", "RUNTIME_WATCHDOG_BATCH_SIZE", "RUNTIME_TELEMETRY_MAX_AGE_SECONDS", "USAGE_METER_POLL_MS", "OUTBOX_MAX_ATTEMPTS", "OUTBOX_LEASE_SECONDS", "OUTBOX_RETRY_BASE_MS", "OUTBOX_RETRY_MAX_MS"]) positiveInteger(runtime, "运行时", key);
equal(control, "控制面", "NODE_ENV", "production");
equal(control, "控制面", "CONTROL_PLANE_DEMO_MODE", "false");

for (const key of ["RUNTIME_TELEMETRY_TENANT_TOKENS", "RUNTIME_RECORDING_TENANT_TOKENS", "PIM_INGEST_TENANT_TOKENS", "CHANNEL_INGEST_TENANT_TOKENS", "CHANNEL_COMMERCE_TENANT_TOKENS"]) {
  const value = control.get(key);
  try {
    const tokens = value ? JSON.parse(value) : null;
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens) || !Object.entries(tokens).every(([tenant, token]) => tenant.length > 0 && typeof token === "string" && token.length >= 16)) throw new Error("invalid");
  } catch {
    const message = `控制面 的 ${key} 必须是每租户独立服务密钥的 JSON 对象`;
    if (allowPlaceholders) warnings.push(message); else errors.push(message);
  }
}
try {
  const targets = JSON.parse(channelAdapter.get("CHANNEL_ADAPTER_TARGETS") ?? "");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const targetValid = (target) => target && typeof target === "object" && !Array.isArray(target)
    && uuid.test(target.tenantId ?? "") && uuid.test(target.channelConnectionId ?? "")
    && [target.signingSecret, target.interactionToken, target.commerceToken].every((value) => typeof value === "string" && value.length >= 16)
    && new Set([target.signingSecret, target.interactionToken, target.commerceToken]).size === 3;
  if (!Array.isArray(targets) || !targets.length || !targets.every(targetValid)) throw new Error("invalid");
} catch {
  const message = "渠道适配器的 CHANNEL_ADAPTER_TARGETS 必须包含 UUID 租户/渠道和三种不同的高熵密钥";
  if (allowPlaceholders) warnings.push(message); else errors.push(message);
}
try {
  const targets = JSON.parse(alertNotifier.get("ALERT_NOTIFIER_TARGETS") ?? "");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const targetValid = (target) => target && typeof target === "object" && !Array.isArray(target)
    && /^[A-Za-z0-9._-]{1,80}$/.test(target.id ?? "") && uuid.test(target.tenantId ?? "")
    && /^https:\/\//.test(target.webhookUrl ?? "") && typeof target.signingSecret === "string" && target.signingSecret.length >= 16
    && [undefined, "warning", "critical"].includes(target.minimumSeverity);
  if (!Array.isArray(targets) || !targets.length || !targets.every(targetValid)) throw new Error("invalid");
} catch {
  const message = "告警通知器的 ALERT_NOTIFIER_TARGETS 必须包含租户 UUID、HTTPS 目标、独立签名密钥和有效最低等级";
  if (allowPlaceholders) warnings.push(message); else errors.push(message);
}
equal(runtime, "运行时", "LIVE_MAX_CONCURRENT_AVATARS", "1");
equal(runtime, "运行时", "LIVE_ALLOW_LLM_FREEFORM", "false");
equal(runtime, "运行时", "LIVE_REQUIRE_HUMAN_HANDOFF_FOR_HIGH_RISK", "true");
equal(runtime, "运行时", "LIVE_REQUIRE_AI_DISCLOSURE", "true");
equal(runtime, "运行时", "LLM_MODE", "external");

try {
  const targets = JSON.parse(runtime.get("RUNTIME_OBSERVER_TARGETS") ?? "");
  const targetValid = (target) => target && typeof target === "object" && !Array.isArray(target)
    && ["tenantId", "runId", "sessionId", "telemetryToken", "outputProbeUrl"].every((key) => typeof target[key] === "string" && target[key].length > 0)
    && target.telemetryToken.length >= 16
    && (target.outputProbeToken === undefined || (typeof target.outputProbeToken === "string" && target.outputProbeToken.length >= 16))
    && /^https?:\/\//.test(target.outputProbeUrl);
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every(targetValid)) throw new Error("invalid");
} catch {
  const message = "运行时 的 RUNTIME_OBSERVER_TARGETS 必须包含每个直播场次的租户、场次、会话、独立遥测密钥和私网输出探针 URL";
  if (allowPlaceholders) warnings.push(message); else errors.push(message);
}

if (runtime.get("NVIDIA_VISIBLE_DEVICES") !== gateway.get("NVIDIA_VISIBLE_DEVICES")) errors.push("运行时与 Gateway 的 NVIDIA_VISIBLE_DEVICES 必须一致");
if (runtime.get("RUNTIME_SHARED_TOKEN") !== gateway.get("RUNTIME_SHARED_TOKEN")) errors.push("运行时与 Gateway 的 RUNTIME_SHARED_TOKEN 必须一致");
if (runtime.get("STREAM_RTMP_URL") !== gateway.get("STREAM_RTMP_URL")) errors.push("运行时与 Gateway 的 STREAM_RTMP_URL 必须一致");
if (runtime.get("STREAM_KEY") !== gateway.get("STREAM_KEY")) errors.push("运行时与 Gateway 的 STREAM_KEY 必须一致");
if (runtime.get("PROGRAM_AUDIOTYPE") !== gateway.get("PROGRAM_AUDIOTYPE")) errors.push("运行时与 Gateway 的 PROGRAM_AUDIOTYPE 必须一致");
if (runtime.get("FALLBACK_AUDIOTYPE") !== gateway.get("FALLBACK_AUDIOTYPE")) errors.push("运行时与 Gateway 的 FALLBACK_AUDIOTYPE 必须一致");
if (runtime.get("HUMAN_HANDOFF_AUDIOTYPE") !== gateway.get("HUMAN_HANDOFF_AUDIOTYPE")) errors.push("运行时与 Gateway 的 HUMAN_HANDOFF_AUDIOTYPE 必须一致");

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
  const [patchText, dockerfileText] = await Promise.all([readFile(observabilityPatch, "utf8"), readFile(liveTalkingDockerfile, "utf8")]);
  if (!patchText.includes("/api/admin/runtime-metrics")) errors.push("LiveTalking 观测补丁缺少运行时指标接口");
  if (!dockerfileText.includes("livetalking-observability.patch") || !dockerfileText.includes("git apply --check --recount")) errors.push("LiveTalking 镜像没有强制应用观测补丁");
  git(liveTalkingSource, ["apply", "--check", "--recount", observabilityPatch]);
} catch (error) {
  errors.push(`LiveTalking 观测补丁不可验证：${error instanceof Error ? error.message : "补丁检查失败"}`);
}

if (runtime.get("STREAM_OUTPUT_MODE") !== "rtmp") warnings.push("当前检查只验证 RTMP 输出；若使用 SRT，需要先扩展 Gateway 和验收脚本。");

for (const warning of warnings) console.warn(`WARN  ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exitCode = 1;
} else {
  console.log(`PASS  部署配置预检通过 (${allowPlaceholders ? "仅模板结构校验" : "生产配置"})`);
}
