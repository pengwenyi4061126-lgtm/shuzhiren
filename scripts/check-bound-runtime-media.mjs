import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../apps/console/app/api/v1/runtime/media/route.ts", import.meta.url), "utf8");
for (const expected of [
  'const mediaTypes = new Set(["switch_to_fallback", "switch_to_human"])',
  'if ("sessionId" in input) return false;',
  'degradeRunFromRuntime(context, run.id',
  'manual_media_action_requires_live_run'
]) {
  if (!route.includes(expected)) throw new Error(`runtime media route must retain bound-session guard: ${expected}`);
}
if (route.includes("sessionId: body.sessionId")) throw new Error("runtime media route must never dispatch to a caller-provided session");
console.log("PASS  runtime media actions use the bound session and controlled degradation");
