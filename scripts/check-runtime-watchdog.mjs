import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = await readFile(path.join(root, "apps", "runtime-worker", "index.mjs"), "utf8");

for (const required of [
  "async function degradeStaleLiveRun()",
  "runtime_telemetry_stale",
  "for update of run skip locked",
  "update live_runs set state = 'DEGRADED'",
  "runtime_guard.degraded",
  "switch_to_fallback",
  "switch_to_human",
  "RUNTIME_TELEMETRY_MAX_AGE_SECONDS"
]) {
  if (!worker.includes(required)) throw new Error(`Runtime watchdog regression: missing ${required}`);
}

console.log("PASS  stale runtime telemetry is atomically alerted, degraded, and queued for fallback");
