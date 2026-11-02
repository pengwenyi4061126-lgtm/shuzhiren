import { chmod, lstat, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { parseObserverTargets, requireOutputProbeToken } from "../apps/runtime-observer/targets.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const candidate = option("--candidate");
const destination = option("--destination");
const runtimeEnv = option("--runtime-env");
const requireTargets = process.argv.includes("--require-targets");

if (!candidate || !destination) {
  console.error("ERROR Usage: node scripts/apply-runtime-observer-targets.mjs --candidate /secure/path/runtime-observer-targets.next.json --destination /secure/path/runtime-observer-targets.json [--require-targets] [--runtime-env /secure/path/runtime.env]");
  process.exit(1);
}

try {
  const candidatePath = path.resolve(candidate);
  const destinationPath = path.resolve(destination);
  if (candidatePath === destinationPath) throw new Error("candidate and destination must be different files");
  if (path.dirname(candidatePath) !== path.dirname(destinationPath)) throw new Error("candidate and destination must be in the same directory for an atomic replacement");
  if (path.basename(destinationPath) !== "runtime-observer-targets.json") throw new Error("destination filename must be runtime-observer-targets.json");

  const candidateStat = await lstat(candidatePath);
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) throw new Error("candidate must be a regular file, not a symbolic link");
  const targetDirectory = await lstat(path.dirname(destinationPath));
  if (!targetDirectory.isDirectory() || targetDirectory.isSymbolicLink()) throw new Error("target directory must be a real directory, not a symbolic link");

  const targets = parseObserverTargets(await readFile(candidatePath, "utf8"), candidatePath);
  if (requireTargets && targets.length === 0) throw new Error("target file must contain at least one target");
  if (runtimeEnv) requireOutputProbeToken(targets, outputProbeToken(await readFile(path.resolve(runtimeEnv), "utf8")));

  // Tokens are present in this file. Preserve owner-only access while replacing it atomically.
  await chmod(candidatePath, 0o600);
  await rename(candidatePath, destinationPath);
  console.log(`PASS  runtime observer target file applied atomically: ${targets.length} target(s)`);
} catch (error) {
  console.error(`ERROR Runtime observer target file was not applied: ${error instanceof Error ? error.message : "invalid target file"}`);
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
