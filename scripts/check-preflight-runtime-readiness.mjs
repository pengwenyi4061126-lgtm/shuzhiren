import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "apps", "console", "lib", "control-plane", "store.ts"), "utf8");
const preflightSection = source.slice(source.indexOf("export async function evaluateRunPreflight"), source.indexOf("export async function degradeRunFromRuntime"));

if (!preflightSection.includes("outputReady: runtime.passed")) throw new Error("Preflight must use fresh runtime telemetry as the output readiness source");
if (preflightSection.includes("run.outputReady && runtime.passed")) throw new Error("Legacy output_ready flag must not permanently block a healthy runtime");

console.log("PASS  preflight output readiness derives from fresh runtime telemetry");
