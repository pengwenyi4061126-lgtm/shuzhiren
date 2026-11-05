import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";

const proxy = await readFile(new URL("../apps/console/proxy.ts", import.meta.url), "utf8");
const serviceAuth = await readFile(new URL("../apps/console/lib/runtime-service-auth.ts", import.meta.url), "utf8");
const protectedServiceRoutes = [
  ["/api/v1/runtime/telemetry", "../apps/console/app/api/v1/runtime/telemetry/route.ts", "requireRuntimeService(request, body.tenantId)"],
  ["/api/v1/runtime/program-output-observations", "../apps/console/app/api/v1/runtime/program-output-observations/route.ts", "requireProgramOutputObservationService(request, tenantId)"],
  ["/api/v1/runtime/recordings", "../apps/console/app/api/v1/runtime/recordings/route.ts", "requireRuntimeRecordingService(request, body.tenantId)"],
  ["/api/v1/integrations/product-facts", "../apps/console/app/api/v1/integrations/product-facts/route.ts", "requirePimIngestService(request, body.tenantId)"],
  ["/api/v1/runtime/channel-interactions", "../apps/console/app/api/v1/runtime/channel-interactions/route.ts", "requireChannelIngestService(request, body.tenantId)"],
  ["/api/v1/runtime/channel-commerce", "../apps/console/app/api/v1/runtime/channel-commerce/route.ts", "requireChannelCommerceService(request, body.tenantId)"],
  ["/api/v1/runtime/settlement-batches", "../apps/console/app/api/v1/runtime/settlement-batches/route.ts", "requireSettlementIngestService(request, body.tenantId)"]
];

for (const [path, routePath, serviceGuard] of protectedServiceRoutes) {
  if (!proxy.includes(`request.nextUrl.pathname === "${path}"`)) throw new Error(`${path} must bypass OIDC proxy authentication for its service-token boundary`);
  const route = await readFile(new URL(routePath, import.meta.url), "utf8");
  if (!route.includes(serviceGuard)) throw new Error(`${path} must enforce tenant-scoped service authentication inside the route`);
}

console.log("PASS  private ingest routes use dedicated tenant service-token boundaries");

// Behavioral checks of the tenant service-token boundary, loaded from the TypeScript source.
register("./lib/console-ts-loader.mjs", import.meta.url);
const serviceAuthModule = await import("../apps/console/lib/runtime-service-auth.ts");
const tenantId = "00000000-0000-4000-8000-000000000001";
const tenantToken = "t".repeat(40);

if (!serviceAuth.includes("timingSafeEqual")) throw new Error("tenant service tokens must be compared in constant time");
if (/authorization\s*!==?\s*`Bearer/.test(serviceAuth)) throw new Error("tenant service tokens must not be compared with string equality");
assert.equal(serviceAuthModule.tokenMatches(`Bearer ${tenantToken}`, tenantToken), true, "the configured token must match");
for (const [label, header] of [["missing", null], ["empty", ""], ["shorter", `Bearer ${tenantToken.slice(1)}`], ["longer", `Bearer ${tenantToken}x`], ["same-length but different", `Bearer ${"u".repeat(40)}`], ["non-ASCII", `Bearer ${tenantToken.slice(0, 38)}\u00c3\u00a9`], ["scheme-less", tenantToken]]) {
  assert.equal(serviceAuthModule.tokenMatches(header, tenantToken), false, `a ${label} authorization header must not match`);
}

function serviceRequest(authorization) {
  return new Request("http://control-plane.internal/api/v1/runtime/telemetry", { method: "POST", headers: authorization ? { authorization } : {} });
}
function rejectedWith(status) {
  return (error) => error instanceof Response && error.status === status;
}
process.env.RUNTIME_TELEMETRY_TENANT_TOKENS = JSON.stringify({ [tenantId]: tenantToken });
assert.doesNotThrow(() => serviceAuthModule.requireRuntimeService(serviceRequest(`Bearer ${tenantToken}`), tenantId), "the configured tenant token must authorize its tenant");
assert.throws(() => serviceAuthModule.requireRuntimeService(serviceRequest(`Bearer ${"u".repeat(40)}`), tenantId), rejectedWith(401), "a wrong token of the same length must be rejected");
assert.throws(() => serviceAuthModule.requireRuntimeService(serviceRequest(null), tenantId), rejectedWith(401), "a missing token must be rejected");
assert.throws(() => serviceAuthModule.requireRuntimeService(serviceRequest(`Bearer ${tenantToken}`), "00000000-0000-4000-8000-000000000009"), rejectedWith(401), "a token must not authorize a tenant it is not configured for");

console.log("PASS  tenant service tokens are compared in constant time and reject missing, mismatched, and foreign-tenant tokens");

// A tenant token map with any malformed entry is rejected as a whole, with a
// message that names the variable and entry but never a tenant id or token.
const sentinel = "sentinel-tenant-token-map-value";
const validEntries = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`10000000-0000-4000-8000-00000000000${index}`, `${sentinel}-${index}`.padEnd(40, "v")]));
for (const [label, raw, reason, entryIndex] of [
  ["syntax error", `{"${tenantId}": "${sentinel}`, "invalid_json"],
  ["array", "[]", "not_object"],
  ["null", "null", "not_object"],
  ["number", "1", "not_object"],
  ["string", '"x"', "not_object"],
  ["empty object", "{}", "empty_object"],
  ["empty tenant id", JSON.stringify({ "": tenantToken }), "key_empty", 1],
  ["201-character tenant id", JSON.stringify({ ["k".repeat(201)]: tenantToken }), "key_too_long", 1],
  ["numeric token", JSON.stringify({ [tenantId]: 12345678901234567890123456789012345 }), "value_not_string", 1],
  ["31-character token", JSON.stringify({ [tenantId]: "s".repeat(31) }), "value_too_short", 1],
  ["token with a space", JSON.stringify({ [tenantId]: `${"s".repeat(20)} ${"s".repeat(20)}` }), "value_whitespace", 1],
  ["nine valid entries and one short token", JSON.stringify({ ...validEntries, [tenantId]: "s".repeat(31) }), "value_too_short", 10]
]) {
  const result = serviceAuthModule.parseTenantTokenMap(raw);
  assert.equal(result.ok, false, `a ${label} tenant token map must be rejected`);
  assert.equal(result.reason, reason, `a ${label} tenant token map must report ${reason}`);
  assert.equal(result.entryIndex, entryIndex, `a ${label} tenant token map must report entry ${entryIndex}`);
  const messages = serviceAuthModule.validateTenantTokenEnvironment({ CHANNEL_COMMERCE_TENANT_TOKENS: raw });
  assert.equal(messages.length, 1, `a ${label} tenant token map must produce one startup error`);
  assert.match(messages[0], /^CHANNEL_COMMERCE_TENANT_TOKENS is invalid: /);
  for (const secret of [sentinel, tenantId, tenantToken, "s".repeat(20), "k".repeat(201)]) assert.ok(!messages[0].includes(secret), `the ${label} startup error must not quote configuration values`);
}
const exactMinimum = serviceAuthModule.parseTenantTokenMap(JSON.stringify({ [tenantId]: "s".repeat(32) }));
assert.equal(exactMinimum.ok, true, "a 32-character token must be accepted");
assert.deepEqual(serviceAuthModule.validateTenantTokenEnvironment({ RUNTIME_TELEMETRY_TENANT_TOKENS: "", PIM_INGEST_TENANT_TOKENS: JSON.stringify(validEntries) }), [], "unset or valid tenant token maps must pass startup validation");
process.env.RUNTIME_TELEMETRY_TENANT_TOKENS = JSON.stringify({ [tenantId]: tenantToken, "00000000-0000-4000-8000-000000000009": "short" });
assert.throws(() => serviceAuthModule.requireRuntimeService(serviceRequest(`Bearer ${tenantToken}`), tenantId), rejectedWith(503), "a tenant token map with a malformed entry must not authorize any tenant");
const instrumentation = await readFile(new URL("../apps/console/instrumentation.ts", import.meta.url), "utf8");
if (!instrumentation.includes("enforceTenantTokenEnvironment()")) throw new Error("the control plane must validate tenant token maps at startup");

console.log("PASS  malformed tenant token maps are rejected as a whole at startup and per request without echoing configuration values");
