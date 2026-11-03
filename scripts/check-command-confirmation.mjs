import { readFile } from "node:fs/promises";

const controlRoom = await readFile(new URL("../apps/console/components/control-room.tsx", import.meta.url), "utf8");
const confirmationSet = controlRoom.match(/const confirmationActions = new Set<LiveCommand\["action"\]>\(\[([^\]]+)\]\);/)?.[1] ?? "";

for (const action of ["START", "PAUSE", "HANDOFF", "END"]) {
  if (!confirmationSet.includes(`"${action}"`)) throw new Error(`${action} must require an explicit command confirmation step`);
}
if (!controlRoom.includes("if (confirmationActions.has(action))")) throw new Error("High-risk command dispatch must stop for a confirmation step");
if (!controlRoom.includes('role="dialog"') || !controlRoom.includes("confirmationAcknowledged")) throw new Error("The command confirmation dialog must require explicit acknowledgement");
if (!controlRoom.includes("onDispatch={requestDispatch}")) throw new Error("Control buttons must enter the command confirmation flow");
if (controlRoom.includes("window.confirm")) throw new Error("Command confirmation must use the consistent application dialog instead of a browser prompt");

console.log("PASS  high-risk live commands require explicit in-app confirmation");
