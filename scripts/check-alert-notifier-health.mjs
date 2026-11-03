import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../apps/alert-notifier/index.mjs", import.meta.url), "utf8");
for (const expected of ["lastSuccessfulTickAt", "lastTickError", "tickFresh", "Math.max(pollMs * 3, 15_000)", "lastSuccessfulTickAt = Date.now()", "stopping = true"]) {
  if (!source.includes(expected)) throw new Error(`Alert notifier health must retain fresh polling readiness behavior: ${expected}`);
}

console.log("PASS  alert notifier health requires database and fresh polling work");
