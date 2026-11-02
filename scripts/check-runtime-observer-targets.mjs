import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseObserverTargets } from "../apps/runtime-observer/targets.mjs";

const index = process.argv.indexOf("--file");
const file = index >= 0 ? process.argv[index + 1] : undefined;
const requireTargets = process.argv.includes("--require-targets");
if (!file) {
  console.error("ERROR Usage: node scripts/check-runtime-observer-targets.mjs --file /secure/path/runtime-observer-targets.json [--require-targets]");
  process.exit(1);
}

try {
  const resolved = path.resolve(file);
  const targets = parseObserverTargets(await readFile(resolved, "utf8"), resolved);
  if (requireTargets && targets.length === 0) throw new Error("target file must contain at least one target");
  console.log(`PASS  runtime observer target file verified: ${targets.length} target(s)`);
} catch (error) {
  console.error(`ERROR Runtime observer target file rejected: ${error instanceof Error ? error.message : "invalid target file"}`);
  process.exitCode = 1;
}
