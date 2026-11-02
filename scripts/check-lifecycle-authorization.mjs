import { readFile } from "node:fs/promises";

const proxy = await readFile(new URL("../apps/console/proxy.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../apps/console/app/api/v1/live-runs/[runId]/lifecycle/route.ts", import.meta.url), "utf8");

if (!route.includes('"disarm"')) throw new Error("Lifecycle route must declare the disarm action");
if (!proxy.includes('action === "disarm") return operatorRoles')) throw new Error("Disarming a live run must require an admin or operator role");

console.log("PASS  lifecycle actions enforce operator authorization for cancellation");
