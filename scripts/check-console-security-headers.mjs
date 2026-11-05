import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { register } from "node:module";

const source = await readFile(new URL("../apps/console/next.config.ts", import.meta.url), "utf8");
const layout = await readFile(new URL("../apps/console/app/layout.tsx", import.meta.url), "utf8");

for (const expected of [
  "Content-Security-Policy",
  "Permissions-Policy",
  "Referrer-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Strict-Transport-Security",
  'source: "/:path*"',
  'source: "/api/:path*"'
]) {
  if (!source.includes(expected)) throw new Error(`Console security headers must retain ${expected}`);
}
if (!layout.includes('export const dynamic = "force-dynamic"')) throw new Error("the root layout must render per request so pages receive the CSP nonce");

console.log("PASS  console applies browser security headers to every route");

// Behavioral checks of the headers, loaded from the TypeScript sources.
register("./lib/console-ts-loader.mjs", import.meta.url);
const directives = (policy) => new Map(policy.split(";").map((part) => part.trim().split(/\s+/)).filter((tokens) => tokens[0]).map(([name, ...values]) => [name, values]));
const csp = await import("../apps/console/lib/csp.ts");
{
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const { default: nextConfig } = await import("../apps/console/next.config.ts");
  const rules = await nextConfig.headers();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  const headersFor = (sourcePattern) => new Map((rules.find((rule) => rule.source === sourcePattern)?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]));
  const everyRoute = headersFor("/:path*");
  const apiRoutes = headersFor("/api/:path*");
  assert.equal(everyRoute.get("content-security-policy"), undefined, "page CSP must come only from the proxy so a static policy cannot block nonce scripts");
  assert.match(everyRoute.get("strict-transport-security") ?? "", /^max-age=(\d+)$/, "built servers must send HSTS");
  assert.ok(Number(/max-age=(\d+)/.exec(everyRoute.get("strict-transport-security"))[1]) >= 31_536_000, "HSTS must last at least a year");
  for (const header of ["permissions-policy", "referrer-policy", "x-content-type-options", "x-frame-options"]) assert.ok(everyRoute.get(header), `every route must send ${header}`);
  const api = directives(apiRoutes.get("content-security-policy") ?? "");
  assert.deepEqual(api.get("default-src"), ["'none'"], "API responses must not load any content");
  assert.deepEqual(api.get("frame-ancestors"), ["'none'"], "API responses must prevent framing");
}
const nonces = new Set(Array.from({ length: 200 }, () => csp.generateNonce()));
assert.equal(nonces.size, 200, "nonces must differ per request");
for (const nonce of nonces) assert.ok(Buffer.from(nonce, "base64").length >= 16, "a nonce must carry at least 128 random bits");
for (const development of [false, true]) {
  const page = directives(csp.pageCsp("abc", { development }));
  assert.deepEqual(page.get("script-src"), ["'self'", "'nonce-abc'", "'strict-dynamic'", ...(development ? ["'unsafe-eval'"] : [])], "page scripts must require the nonce");
  assert.deepEqual(page.get("object-src"), ["'none'"]);
  assert.deepEqual(page.get("frame-ancestors"), ["'none'"]);
  assert.ok(!page.get("script-src").includes("'unsafe-inline'"), "page script-src must not allow inline scripts");
}
{
  const { proxy } = await import("../apps/console/proxy.ts");
  const { NextRequest } = await import("next/server.js");
  const previous = { NODE_ENV: process.env.NODE_ENV, CONTROL_PLANE_DEV_HEADER_IDENTITY: process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY };
  process.env.NODE_ENV = "production";
  delete process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY;
  const rejectedPage = await proxy(new NextRequest("http://console.internal/shows"));
  const rejectedPagePolicy = directives(rejectedPage.headers.get("content-security-policy") ?? "");
  assert.equal(rejectedPage.status, 401);
  assert.ok(rejectedPagePolicy.get("script-src")?.some((value) => value.startsWith("'nonce-")), "proxy responses for pages must carry the nonce policy");
  assert.equal(rejectedPage.headers.get("strict-transport-security"), csp.strictTransportSecurity, "proxy error responses must send HSTS in production");
  const rejectedApi = await proxy(new NextRequest("http://console.internal/api/v1/alerts"));
  assert.equal(rejectedApi.headers.get("content-security-policy"), csp.apiCsp, "proxy API errors must carry the API policy");
  assert.equal(rejectedApi.headers.get("strict-transport-security"), csp.strictTransportSecurity);
  process.env.NODE_ENV = "development";
  process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY = "true";
  const forwardedPage = await proxy(new NextRequest("http://127.0.0.1/shows"));
  const responsePolicy = forwardedPage.headers.get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(responsePolicy)?.[1];
  assert.equal(forwardedPage.headers.get("x-middleware-next"), "1", "an allowed page request must continue to rendering");
  assert.ok(nonce, "a forwarded page must carry a nonce policy");
  assert.equal(forwardedPage.headers.get("x-middleware-request-content-security-policy"), responsePolicy, "the forwarded request must carry the same policy so Next.js can apply its nonce");
  assert.equal(forwardedPage.headers.get("x-middleware-request-x-nonce"), nonce);
  assert.equal(forwardedPage.headers.get("strict-transport-security"), null, "development responses must not send HSTS");
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
console.log("PASS  pages get a per-request nonce CSP without 'unsafe-inline' scripts, API routes a deny-all CSP, and production responses HSTS");

// /api/v1/runtime/health must answer gateway failures with a fixed error code
// and keep the cause (and the shared token) out of the response body.
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
