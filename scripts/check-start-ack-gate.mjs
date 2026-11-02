import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [store, outbox] = await Promise.all([
  readFile(path.join(root, "apps", "console", "lib", "control-plane", "store.ts"), "utf8"),
  readFile(path.join(root, "apps", "console", "lib", "control-plane", "outbox.ts"), "utf8"),
]);

if (!store.includes("A start command is already pending runtime confirmation")) throw new Error("Manual start must reject a duplicate pending start event");
if (!store.includes("set scheduled_start_event_id = $2") || !store.includes("state = 'ARMED'")) throw new Error("Manual start must remain ARMED while awaiting its outbox event");
if (!outbox.includes('["SCHEDULED_START", "START"].includes(event.command.payload.controlAction)')) throw new Error("Outbox acknowledgement must promote both scheduled and manual starts");

console.log("PASS  live run enters LIVE only after start outbox acknowledgement");
