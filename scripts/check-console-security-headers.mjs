import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { register } from "node:module";

const source = await readFile(new URL("../apps/console/next.config.ts", import.meta.url), "utf8");

for (const expected of [
  "Content-Security-Policy",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "Permissions-Policy",
  "Referrer-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  'source: "/:path*"'
]) {
  if (!source.includes(expected)) throw new Error(`Console security headers must retain ${expected}`);
}

console.log("PASS  console applies browser security headers to every route");

// /api/v1/runtime/health must answer gateway failures with a fixed error code
// and keep the cause (and the shared token) out of the response body.
register("./lib/console-ts-loader.mjs", import.meta.url);
const sharedToken = "runtime-shared-token-value-for-health-check";
const sentinel = "gateway-body-sentinel";
let gatewayMode = "ok";
const gateway = http.createServer((request, response) => {
  if (gatewayMode === "slow") { setTimeout(() => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); }, 1_000); return; }
  const [status, body] = { ok: [200, JSON.stringify({ status: "ok", livetalking: "up" })], error: [500, `${sentinel} ${sharedToken}`], text: [200, `not-json-${sentinel}`], array: [200, "[1]"] }[gatewayMode];
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const closedPort = await new Promise((resolve) => { const probe = http.createServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
Object.assign(process.env, { CONTROL_PLANE_DEV_HEADER_IDENTITY: "true", NODE_ENV: "development", HOSTNAME: "127.0.0.1", RUNTIME_GATEWAY_DEMO_MODE: "false", RUNTIME_SHARED_TOKEN: sharedToken, RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS: "300" });
const { GET: runtimeHealth } = await import("../apps/console/app/api/v1/runtime/health/route.ts");
const adminRequest = () => new Request("http://127.0.0.1/api/v1/runtime/health", { headers: { "x-tenant-id": "tenant_demo", "x-actor-id": "health-check", "x-actor-name": "Health Check", "x-actor-role": "admin" } });
async function healthResponse() {
  const lines = [];
  const original = console.error;
  console.error = (...values) => { lines.push(values.join(" ")); };
  try {
    const response = await runtimeHealth(adminRequest());
    return { status: response.status, body: await response.text(), lines };
  } finally {
    console.error = original;
  }
}
try {
  process.env.RUNTIME_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
  const healthy = await healthResponse();
  assert.equal(healthy.status, 200, "a healthy gateway must be reported");
  assert.equal(JSON.parse(healthy.body).data.livetalking, "up");
  const failures = [["error", "a 500 response"], ["text", "a non-JSON body"], ["array", "a non-object body"], ["slow", "a timeout"], ["closed", "a closed port"], ["misconfigured", "invalid gateway configuration"]];
  for (const [mode, label] of failures) {
    gatewayMode = mode;
    if (mode === "closed") process.env.RUNTIME_GATEWAY_URL = `http://127.0.0.1:${closedPort}`;
    if (mode === "misconfigured") process.env.RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS = `invalid-${sentinel}`;
    const result = await healthResponse();
    assert.equal(result.status, 503, `${label} must answer 503`);
    assert.equal(result.body, '{"error":"runtime_unavailable"}', `${label} must not leak its cause to the client`);
    assert.equal(result.lines.length, 1, `${label} must be logged once`);
    assert.match(result.lines[0], /"event":"runtime_health_unavailable","route":"\/api\/v1\/runtime\/health"/);
    assert.ok(!result.lines[0].includes(sharedToken), `the ${label} log must not contain the runtime shared token`);
  }
} finally {
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
}

console.log("PASS  runtime health failures answer a fixed runtime_unavailable code and log the cause without the shared token");
