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

console.log(`PASS  entitlement concurrency consistently counts LIVE and DEGRADED runs (${root})`);
