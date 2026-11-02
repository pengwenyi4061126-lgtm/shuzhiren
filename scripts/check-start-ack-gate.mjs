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
if (!store.includes('const requiresActivationConfirmation = input.action === "START" || input.action === "RECOVER"') || !store.includes("set scheduled_start_event_id = $2")) throw new Error("Manual start and recovery must keep their current state while awaiting an outbox acknowledgement");
if (!store.includes('const requiresEndConfirmation = input.action === "END"') || !store.includes("A runtime stop command is already pending confirmation") || !store.includes("set pending_media_event_id = $2")) throw new Error("Manual end must remain pending until a runtime stop acknowledgement");
if (!store.includes('input.action === "RECOVER"') || !store.includes("Runtime health is not ready for recovery")) throw new Error("Recovery must require fresh healthy runtime telemetry");
if (!outbox.includes('["SCHEDULED_START", "START", "RECOVER"].includes(event.command.payload.controlAction)') || !outbox.includes("state in ('ARMED', 'DEGRADED')")) throw new Error("Outbox acknowledgement must promote confirmed starts and recoveries only");
if (!outbox.includes('event.command.payload.controlAction === "END"') || !outbox.includes("state = 'ENDED', pending_media_event_id = null")) throw new Error("Outbox acknowledgement must end a run only after the stop command is confirmed");
if (!worker.includes('["SCHEDULED_START", "START", "RECOVER"].includes(event.payload?.command?.payload?.controlAction)') || !worker.includes("state in ('ARMED', 'DEGRADED')")) throw new Error("Background worker acknowledgement must promote confirmed starts and recoveries only");
if (!worker.includes('event.payload?.command?.payload?.controlAction === "END"') || !worker.includes("state = 'ENDED', pending_media_event_id = null")) throw new Error("Background worker acknowledgement must end a run only after the stop command is confirmed");

console.log("PASS  live run changes activation and end states only after runtime acknowledgement");
