import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseObserverTargets, requireOutputProbeToken } from "../apps/runtime-observer/targets.mjs";

const index = process.argv.indexOf("--file");
const file = index >= 0 ? process.argv[index + 1] : undefined;
const runtimeEnvIndex = process.argv.indexOf("--runtime-env");
const runtimeEnv = runtimeEnvIndex >= 0 ? process.argv[runtimeEnvIndex + 1] : undefined;
const requireTargets = process.argv.includes("--require-targets");
if (!file) {
  console.error("ERROR Usage: node scripts/check-runtime-observer-targets.mjs --file /secure/path/runtime-observer-targets.json [--require-targets] [--runtime-env /secure/path/runtime.env]");
  process.exit(1);
}

try {
  const resolved = path.resolve(file);
  const targets = parseObserverTargets(await readFile(resolved, "utf8"), resolved);
  if (requireTargets && targets.length === 0) throw new Error("target file must contain at least one target");
  if (runtimeEnv) requireOutputProbeToken(targets, outputProbeToken(await readFile(path.resolve(runtimeEnv), "utf8")));
  console.log(`PASS  runtime observer target file verified: ${targets.length} target(s)`);
} catch (error) {
  console.error(`ERROR Runtime observer target file rejected: ${error instanceof Error ? error.message : "invalid target file"}`);
  process.exitCode = 1;
}

function outputProbeToken(text) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0 && line.slice(0, separator).trim() === "OUTPUT_PROBE_SHARED_TOKEN") return line.slice(separator + 1).trim();
  }
  return "";
}
