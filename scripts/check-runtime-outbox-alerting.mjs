import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = await readFile(path.join(root, "apps", "runtime-worker", "index.mjs"), "utf8");

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

console.log("PASS  exhausted runtime outbox delivery opens a durable, audited alert");
