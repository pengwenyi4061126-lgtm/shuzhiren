import { readFile } from "node:fs/promises";

const [route, gateway] = await Promise.all([
  readFile(new URL("../apps/console/app/api/v1/runtime/media/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/lib/runtime-gateway.ts", import.meta.url), "utf8")
]);
for (const expected of [
  'const mediaTypes = new Set(["switch_to_fallback", "switch_to_human"])',
  'if ("sessionId" in input) return false;',
  'degradeRunFromRuntime(context, run.id',
  'manual_media_action_requires_live_run'
]) {
  if (!route.includes(expected)) throw new Error(`runtime media route must retain bound-session guard: ${expected}`);
}
if (route.includes("sessionId: body.sessionId")) throw new Error("runtime media route must never dispatch to a caller-provided session");
for (const expected of ["RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS", "AbortSignal.timeout(config.requestTimeoutMs)"]) {
  if (!gateway.includes(expected)) throw new Error(`runtime Gateway client must bound control-plane calls: ${expected}`);
}
console.log("PASS  runtime media actions use the bound session and controlled degradation");
