import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = await readFile(path.join(root, "apps", "runtime-worker", "index.mjs"), "utf8");
const manualOutbox = await readFile(path.join(root, "apps", "console", "lib", "control-plane", "outbox.ts"), "utf8");

for (const required of [
  "async function openDeliveryExhaustedAlert",
  "runtime_command_delivery_exhausted",
  "runtime_command.delivery_exhausted",
  "event.attempts >= maxAttempts",
  "event.aggregate_id",
  "for update",
  "media.dispatch",
  "speech.dispatch"
]) {
  if (!worker.includes(required)) throw new Error(`Runtime outbox alerting regression: missing ${required}`);
}

for (const required of [
  "const outboxMaxAttempts",
  "async function openDeliveryExhaustedAlert",
  "runtime_command_delivery_exhausted",
  "runtime_command.delivery_exhausted",
  "input.attempts >= outboxMaxAttempts",
  "deliveryMode: \"manual\""
]) {
  if (!manualOutbox.includes(required)) throw new Error(`Manual outbox alerting regression: missing ${required}`);
}

console.log("PASS  worker and manual exhausted runtime outbox delivery open durable, audited alerts");
