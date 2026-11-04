import { readFile } from "node:fs/promises";

const [gateway, client, route, component] = await Promise.all([
  readFile(new URL("../runtime/gateway/app.py", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/lib/runtime-gateway.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/app/api/v1/live-runs/[runId]/preview/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/components/controlled-preview.tsx", import.meta.url), "utf8")
]);

for (const source of ["PREVIEW_BROKER_URL", "PREVIEW_BROKER_TOKEN", "validate_preview_grant", 'parsed.scheme != "https"', 'mode != "webrtc"', '@app.get("/v1/previews/{session_id}")']) {
  if (!gateway.includes(source)) throw new Error(`Runtime Gateway must retain controlled preview guard: ${source}`);
}
for (const source of ["getRuntimePreview", 'url.protocol === "https:"', "remainingMs < 15_000", "/v1/previews/"]) {
  if (!client.includes(source)) throw new Error(`Control-plane Gateway client must validate preview grants: ${source}`);
}
for (const source of ["requireRole(actor, [\"admin\", \"operator\"])", "getRun(actor, runId)", "recordAuditEvent", "cache-control\": \"no-store"] ) {
  if (!route.includes(source)) throw new Error(`Preview API must retain authorization, run scope, audit, and no-store controls: ${source}`);
}
if (route.includes("preview.url")) throw new Error("Preview audit route must never persist or log the preview URL");
for (const source of ["sandbox=\"allow-scripts allow-same-origin allow-forms\"", "referrerPolicy=\"no-referrer\"", "打开预览"]) {
  if (!component.includes(source)) throw new Error(`Controlled preview UI must retain constrained embed behavior: ${source}`);
}
if (component.includes("avatar") || component.includes("caption")) throw new Error("Controlled preview UI must not render a simulated avatar or caption as live video");

console.log("PASS  controlled preview is short-lived, scoped, audited, and does not simulate live video");
