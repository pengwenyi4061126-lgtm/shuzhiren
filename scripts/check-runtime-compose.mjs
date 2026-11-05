import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { parseEnvFile } from "./lib/compose-interpolation.mjs";
import { checkComposePorts, checkRuntimeComposeIsolation, checkTemplateRequirements } from "./lib/runtime-compose-consistency.mjs";

const files = {
  compose: "../infra/compose/docker-compose.runtime.yml",
  runtime: "../config/runtime.example.env",
  gateway: "../config/runtime-gateway.example.env",
  channel: "../config/channel-adapter.example.env",
  notifier: "../config/alert-notifier.example.env"
};
const contents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readFile(new URL(file, import.meta.url), "utf8")])));

for (const profile of ["output-probe", "channel-adapter", "alert-notifier", "cosyvoice"]) {
  if (!contents.compose.includes(`profiles: ["${profile}"]`)) throw new Error(`Runtime Compose must retain the ${profile} profile`);
}
for (const source of ["RUNTIME_GATEWAY_IMAGE", "RUNTIME_WORKER_IMAGE", "RUNTIME_OBSERVER_IMAGE", "OUTPUT_PROBE_IMAGE", "CHANNEL_ADAPTER_IMAGE", "ALERT_NOTIFIER_IMAGE", "LIVETALKING_IMAGE", "COSYVOICE_IMAGE"]) {
  if (!contents.compose.includes(source) || !contents.runtime.includes(`${source}=`)) throw new Error(`Runtime Compose must retain immutable deployment image input: ${source}`);
}
if (contents.compose.includes("build:")) throw new Error("Runtime production Compose must not build mutable local images");
for (const [name, key] of [["runtime", "RUNTIME_SHARED_TOKEN="], ["gateway", "RUNTIME_GATEWAY_STATE_PATH="], ["gateway", "PREVIEW_GRANT_MAX_SECONDS="], ["channel", "CHANNEL_ADAPTER_TARGETS="], ["notifier", "ALERT_NOTIFIER_TARGETS="]]) {
  if (!contents[name].includes(key)) throw new Error(`${name} template must supply ${key} for Compose interpolation`);
}
for (const required of ["PREVIEW_BROKER_URL: ${PREVIEW_BROKER_URL:-}", "PREVIEW_BROKER_TOKEN: ${PREVIEW_BROKER_TOKEN:-}", "PREVIEW_GRANT_MAX_SECONDS: ${PREVIEW_GRANT_MAX_SECONDS:-600}"]) {
  if (!contents.compose.includes(required)) throw new Error(`Runtime Compose must pass controlled preview configuration: ${required}`);
}
for (const required of ["RUNTIME_WORKER_DATABASE_URL", "CHANNEL_ADAPTER_DATABASE_URL", "ALERT_NOTIFIER_DATABASE_URL", "CONTROL_PLANE_URL", "LIVETALKING_AVATAR_ID", "STREAM_RTMP_URL", "STREAM_KEY", "MODEL_VOLUME_PATH", "AVATAR_VOLUME_PATH", "RECORDINGS_VOLUME_PATH", "COSYVOICE_MODEL_PATH", "COSYVOICE_MODEL_DIR"]) {
  if (!Object.values(contents).some((content) => content.includes(`${required}=`))) throw new Error(`Runtime Compose template set must supply ${required}`);
}

const composeDoc = yaml.load(contents.compose);
const portErrors = checkComposePorts(composeDoc).errors;
if (portErrors.length) throw new Error(`Runtime Compose ports must agree between environment, expose, health checks and service URLs:\n${portErrors.map(({ code, message }) => `[${code}] ${message}`).join("\n")}`);
const isolationErrors = checkRuntimeComposeIsolation(composeDoc).errors;
if (isolationErrors.length) throw new Error(`Runtime Compose must keep LiveTalking and CosyVoice reachable only from runtime-gateway:\n${isolationErrors.map(({ code, message }) => `[${code}] ${message}`).join("\n")}`);
const templates = {
  runtime: parseEnvFile(contents.runtime, "config/runtime.example.env"),
  "runtime-gateway": parseEnvFile(contents.gateway, "config/runtime-gateway.example.env"),
  "channel-adapter": parseEnvFile(contents.channel, "config/channel-adapter.example.env"),
  "alert-notifier": parseEnvFile(contents.notifier, "config/alert-notifier.example.env")
};
const templateErrors = checkTemplateRequirements({ composeDoc, templates }).errors;
if (templateErrors.length) throw new Error(`Runtime Compose required variables must point at the template that defines them:\n${templateErrors.map(({ code, message }) => `[${code}] ${message}`).join("\n")}`);

console.log("PASS  runtime Compose templates cover every service profile and required interpolation input");
