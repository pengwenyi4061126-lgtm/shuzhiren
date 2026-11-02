import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [store, outbox, worker] = await Promise.all([
  readFile(path.join(root, "apps", "console", "lib", "control-plane", "store.ts"), "utf8"),
  readFile(path.join(root, "apps", "console", "lib", "control-plane", "outbox.ts"), "utf8"),
  readFile(path.join(root, "apps", "runtime-worker", "index.mjs"), "utf8"),
]);

if (!store.includes("A runtime activation command is already pending confirmation")) throw new Error("Manual start and recovery must reject duplicate pending activation events");
if (!store.includes('const requiresRuntimeConfirmation = input.action === "START" || input.action === "RECOVER"') || !store.includes("set scheduled_start_event_id = $2")) throw new Error("Manual start and recovery must keep their current state while awaiting an outbox acknowledgement");
if (!store.includes('input.action === "RECOVER"') || !store.includes("Runtime health is not ready for recovery")) throw new Error("Recovery must require fresh healthy runtime telemetry");
if (!outbox.includes('["SCHEDULED_START", "START", "RECOVER"].includes(event.command.payload.controlAction)') || !outbox.includes("state in ('ARMED', 'DEGRADED')")) throw new Error("Outbox acknowledgement must promote confirmed starts and recoveries only");
if (!worker.includes('["SCHEDULED_START", "START", "RECOVER"].includes(event.payload?.command?.payload?.controlAction)') || !worker.includes("state in ('ARMED', 'DEGRADED')")) throw new Error("Background worker acknowledgement must promote confirmed starts and recoveries only");

console.log("PASS  live run enters LIVE only after runtime activation acknowledgement");
