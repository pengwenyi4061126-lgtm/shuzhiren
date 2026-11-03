import { readFile } from "node:fs/promises";

const proxy = await readFile(new URL("../apps/console/proxy.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../apps/console/app/api/v1/live-runs/[runId]/lifecycle/route.ts", import.meta.url), "utf8");

if (!route.includes('"disarm"') || !route.includes('"archive"')) throw new Error("Lifecycle route must declare disarm and archive actions");
if (!route.includes('requireRole(actor, action === "approve" ? ["admin", "reviewer"] : ["admin", "operator"])')) throw new Error("Lifecycle actions must require reviewer approval or operator execution in the bounded route handler");
if (!proxy.includes('if (/^\\/api\\/v1\\/live-runs\\/[^/]+\\/lifecycle$/.test(path)) return allRoles;')) throw new Error("The proxy must admit authenticated roles and leave action authorization to the bounded lifecycle handler");
if (proxy.includes("lifecycleRoles(request)") || proxy.includes("request.clone().json()")) throw new Error("The proxy must not parse lifecycle request bodies outside the shared bounded parser");

console.log("PASS  privileged lifecycle actions enforce operator authorization");
