import { readFile } from "node:fs/promises";

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
for (const source of ["runtime/livetalking/Dockerfile", "../../runtime/gateway", "vendor/CosyVoice"]) {
  if (!contents.compose.includes(source)) throw new Error(`Runtime Compose must retain the governed build source: ${source}`);
}
for (const [name, key] of [["runtime", "RUNTIME_SHARED_TOKEN="], ["gateway", "RUNTIME_GATEWAY_STATE_PATH="], ["gateway", "PREVIEW_GRANT_MAX_SECONDS="], ["channel", "CHANNEL_ADAPTER_TARGETS="], ["notifier", "ALERT_NOTIFIER_TARGETS="]]) {
  if (!contents[name].includes(key)) throw new Error(`${name} template must supply ${key} for Compose interpolation`);
}
for (const required of ["PREVIEW_BROKER_URL: ${PREVIEW_BROKER_URL:-}", "PREVIEW_BROKER_TOKEN: ${PREVIEW_BROKER_TOKEN:-}", "PREVIEW_GRANT_MAX_SECONDS: ${PREVIEW_GRANT_MAX_SECONDS:-600}"]) {
  if (!contents.compose.includes(required)) throw new Error(`Runtime Compose must pass controlled preview configuration: ${required}`);
}
for (const required of ["RUNTIME_WORKER_DATABASE_URL", "CHANNEL_ADAPTER_DATABASE_URL", "ALERT_NOTIFIER_DATABASE_URL", "CONTROL_PLANE_URL", "LIVETALKING_AVATAR_ID", "STREAM_RTMP_URL", "STREAM_KEY", "MODEL_VOLUME_PATH", "AVATAR_VOLUME_PATH", "RECORDINGS_VOLUME_PATH", "COSYVOICE_MODEL_PATH", "COSYVOICE_MODEL_DIR"]) {
  if (!Object.values(contents).some((content) => content.includes(`${required}=`))) throw new Error(`Runtime Compose template set must supply ${required}`);
}

console.log("PASS  runtime Compose templates cover every service profile and required interpolation input");
