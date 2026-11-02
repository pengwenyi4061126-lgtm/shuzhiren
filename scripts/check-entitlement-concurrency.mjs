import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const expectedPredicate = "state in ('LIVE', 'DEGRADED')";
const sources = [
  "apps/console/lib/entitlements.ts",
  "apps/runtime-worker/index.mjs"
];

for (const source of sources) {
  const content = await readFile(new URL(`../${source}`, import.meta.url), "utf8");
  if (!content.includes(expectedPredicate)) throw new Error(`${source} must count LIVE and DEGRADED runs against concurrent capacity`);
}

const worker = await readFile(new URL("../apps/runtime-worker/index.mjs", import.meta.url), "utf8");
if (!/from live_runs\s+where state in \('LIVE', 'DEGRADED'\)\s+and exists/.test(worker)) {
  throw new Error("runtime usage metering must record LIVE and DEGRADED minutes");
}

console.log(`PASS  entitlement accounting consistently includes LIVE and DEGRADED runs (${root})`);
