import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const expectedPredicate = "state in ('LIVE', 'DEGRADED') or (state = 'ARMED' and scheduled_start_event_id is not null)";
const sources = [
  "apps/console/lib/entitlements.ts",
  "apps/runtime-worker/index.mjs"
];

for (const source of sources) {
  const content = await readFile(new URL(`../${source}`, import.meta.url), "utf8");
  if (!content.includes(expectedPredicate)) throw new Error(`${source} must reserve concurrent capacity for LIVE, DEGRADED, and pending starts`);
  if (!content.includes("effective_until is null or effective_until >= current_date) for update")) throw new Error(`${source} must serialize concurrent activation checks with entitlement row locks`);
}

const worker = await readFile(new URL("../apps/runtime-worker/index.mjs", import.meta.url), "utf8");
if (!/from live_runs\s+where state in \('LIVE', 'DEGRADED'\)\s+and exists/.test(worker)) {
  throw new Error("runtime usage metering must record LIVE and DEGRADED minutes");
}

console.log(`PASS  entitlement accounting reserves LIVE, DEGRADED, and pending-start capacity (${root})`);
