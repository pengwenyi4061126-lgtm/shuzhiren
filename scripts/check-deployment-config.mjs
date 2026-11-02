import { readFile } from "node:fs/promises";
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
  lock: option("--lock", "runtime/open-source.lock.json")
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

const [controlText, runtimeText, gatewayText, lockText] = await Promise.all(Object.values(files).map((file) => readFile(file, "utf8").catch((error) => { errors.push(`无法读取 ${file}: ${error.message}`); return ""; })));
const control = parseEnv(controlText);
const runtime = parseEnv(runtimeText);
const gateway = parseEnv(gatewayText);

required(control, "控制面", ["NODE_ENV", "DATABASE_URL", "CONTROL_PLANE_DEMO_MODE", "OIDC_ISSUER_URL", "OIDC_AUDIENCE", "OIDC_JWKS_URL", "RUNTIME_TELEMETRY_TOKEN"]);
required(runtime, "运行时", ["NVIDIA_VISIBLE_DEVICES", "STREAM_RTMP_URL", "STREAM_KEY", "LIVETALKING_REF", "MUSETALK_REF", "COSYVOICE_REF", "RUNTIME_GATEWAY_URL", "RUNTIME_SHARED_TOKEN"]);
required(gateway, "Gateway", ["NVIDIA_VISIBLE_DEVICES", "RUNTIME_SHARED_TOKEN", "LIVETALKING_AVATAR_ID", "MODEL_VOLUME_PATH", "AVATAR_VOLUME_PATH", "STREAM_RTMP_URL", "STREAM_KEY"]);
equal(control, "控制面", "NODE_ENV", "production");
equal(control, "控制面", "CONTROL_PLANE_DEMO_MODE", "false");
equal(runtime, "运行时", "LIVE_MAX_CONCURRENT_AVATARS", "1");
equal(runtime, "运行时", "LIVE_ALLOW_LLM_FREEFORM", "false");
equal(runtime, "运行时", "LIVE_REQUIRE_HUMAN_HANDOFF_FOR_HIGH_RISK", "true");
equal(runtime, "运行时", "LIVE_REQUIRE_AI_DISCLOSURE", "true");
equal(runtime, "运行时", "LLM_MODE", "external");

if (runtime.get("NVIDIA_VISIBLE_DEVICES") !== gateway.get("NVIDIA_VISIBLE_DEVICES")) errors.push("运行时与 Gateway 的 NVIDIA_VISIBLE_DEVICES 必须一致");
if (runtime.get("RUNTIME_SHARED_TOKEN") !== gateway.get("RUNTIME_SHARED_TOKEN")) errors.push("运行时与 Gateway 的 RUNTIME_SHARED_TOKEN 必须一致");
if (runtime.get("STREAM_RTMP_URL") !== gateway.get("STREAM_RTMP_URL")) errors.push("运行时与 Gateway 的 STREAM_RTMP_URL 必须一致");
if (runtime.get("STREAM_KEY") !== gateway.get("STREAM_KEY")) errors.push("运行时与 Gateway 的 STREAM_KEY 必须一致");

try {
  const lock = JSON.parse(lockText);
  if (!Array.isArray(lock.components) || lock.components.length < 3) errors.push("开源运行时锁文件缺少组件");
  else for (const component of lock.components) {
    if (!/^[0-9a-f]{40}$/i.test(component.commit ?? "")) errors.push(`${component.name ?? "未知组件"} 没有固定 40 位 Git 提交`);
    if (!component.license) errors.push(`${component.name ?? "未知组件"} 缺少许可证记录`);
  }
} catch { errors.push("无法解析开源运行时锁文件"); }

if (runtime.get("STREAM_OUTPUT_MODE") !== "rtmp") warnings.push("当前检查只验证 RTMP 输出；若使用 SRT，需要先扩展 Gateway 和验收脚本。");

for (const warning of warnings) console.warn(`WARN  ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exitCode = 1;
} else {
  console.log(`PASS  部署配置预检通过 (${allowPlaceholders ? "仅模板结构校验" : "生产配置"})`);
}
