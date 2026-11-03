import { readFile } from "node:fs/promises";

const proxy = await readFile(new URL("../apps/console/proxy.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../apps/console/app/api/v1/live-runs/[runId]/lifecycle/route.ts", import.meta.url), "utf8");

if (!route.includes('"disarm"') || !route.includes('"archive"')) throw new Error("Lifecycle route must declare disarm and archive actions");
const operatorLifecycleRule = proxy.match(/if \(action === .+return operatorRoles;/)?.[0] ?? "";
if (!operatorLifecycleRule.includes('action === "disarm"')) throw new Error("Disarming a live run must require an admin or operator role");
if (!operatorLifecycleRule.includes('action === "archive"')) throw new Error("Archiving a live run must require an admin or operator role");

console.log("PASS  privileged lifecycle actions enforce operator authorization");
