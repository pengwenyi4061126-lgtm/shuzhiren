import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const monitoring = await readFile(path.join(root, "apps", "console", "lib", "monitoring.ts"), "utf8");

for (const required of [
  "const telemetryAlertCodes",
  "function isTelemetryAlertCode",
  "isTelemetryAlertCode(alert.code) && !active.has(alert.code)"
]) {
  if (!monitoring.includes(required)) throw new Error(`Telemetry alert ownership regression: missing ${required}`);
}

if (monitoring.includes('alert.status === "open" && !active.has(alert.code)')) throw new Error("Telemetry alert ownership regression: non-telemetry alerts can still be auto-resolved");

console.log("PASS  healthy telemetry resolves only telemetry-owned alerts");
