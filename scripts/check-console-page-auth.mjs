import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";

const [proxy, pageContext] = await Promise.all([
  readFile(new URL("../apps/console/proxy.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/lib/control-plane/page-context.ts", import.meta.url), "utf8")
]);

for (const source of ["api/health(?:/.*)?", "_next/static", "_next/image", "favicon.ico"]) {
  if (!proxy.includes(source)) throw new Error(`Console proxy must explicitly exclude unauthenticated infrastructure route: ${source}`);
}
if (!proxy.includes('matcher: ["/((?!api/health(?:/.*)?|_next/static|_next/image|favicon.ico).*)"]')) {
  throw new Error("Console proxy must authenticate both pages and API routes before rendering data");
}
if (!pageContext.includes("requestContextFrom")) throw new Error("Server-rendered pages must retain request-context authorization");
for (const source of ["const remoteJwks = new Map", "jwksFor(jwksUrl)", "timeoutDuration: 5_000"]) {
  if (!proxy.includes(source)) throw new Error(`Console proxy must cache bounded remote JWKS verification: ${source}`);
}

console.log("PASS  console pages and API routes share the production authentication boundary");

// Behavioral checks of the development request-header identity switch, loaded
// from the TypeScript sources (no database or OIDC issuer is contacted).
register("./lib/console-ts-loader.mjs", import.meta.url);
const devIdentity = await import("../apps/console/lib/control-plane/dev-identity.ts");
const authContext = await import("../apps/console/lib/control-plane/auth-context.ts");
const serviceAuth = await import("../apps/console/lib/runtime-service-auth.ts");
const { proxy: runProxy } = await import("../apps/console/proxy.ts");
const { NextRequest } = await import("next/server.js");

const managedVariables = ["CONTROL_PLANE_DEV_HEADER_IDENTITY", "NODE_ENV", "HOSTNAME", "RUNTIME_TELEMETRY_TENANT_TOKENS"];
async function withEnv(values, action) {
  const previous = Object.fromEntries(managedVariables.map((name) => [name, process.env[name]]));
  for (const name of managedVariables) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  try { return await action(); } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
const rejectedWith = (status, statusText) => (error) => error instanceof Response && error.status === status && (statusText === undefined || error.statusText === statusText);
const devHeaders = { "x-tenant-id": "tenant_header", "x-actor-id": "header-actor", "x-actor-name": "Header Actor", "x-actor-role": "admin" };

// The switch is on only for the exact value "true".
for (const value of [undefined, "", "TRUE", "True", "1", "yes", " true", "true ", "false"]) {
  assert.equal(devIdentity.devHeaderIdentityEnabled({ CONTROL_PLANE_DEV_HEADER_IDENTITY: value }), false, `CONTROL_PLANE_DEV_HEADER_IDENTITY=${JSON.stringify(value)} must keep header identity off`);
}
assert.equal(devIdentity.devHeaderIdentityEnabled({ CONTROL_PLANE_DEV_HEADER_IDENTITY: "true" }), true);
for (let sample = 0; sample < 500; sample += 1) {
  const value = Array.from({ length: sample % 7 }, () => "trueTRUE01 \t-"[Math.floor(Math.random() * 13)]).join("");
  assert.equal(devIdentity.devHeaderIdentityEnabled({ CONTROL_PLANE_DEV_HEADER_IDENTITY: value }), value === "true", `CONTROL_PLANE_DEV_HEADER_IDENTITY=${JSON.stringify(value)}`);
}

// Loopback and production rules for the switch.
const devEnv = (hostname) => ({ CONTROL_PLANE_DEV_HEADER_IDENTITY: "true", NODE_ENV: "development", ...(hostname === undefined ? {} : { HOSTNAME: hostname }) });
for (const host of ["127.0.0.1", "127.255.0.9", "localhost", "LOCALHOST", "::1", "[::1]", "0:0:0:0:0:0:0:1"]) {
  assert.equal(devIdentity.devIdentityViolation({ env: devEnv(host), argv: [] }), null, `HOSTNAME=${host} must be accepted as loopback`);
  assert.equal(devIdentity.devIdentityViolation({ env: devEnv(undefined), argv: ["next", "dev", "-H", host] }), null, `-H ${host} must be accepted as loopback`);
}
for (const host of ["0.0.0.0", "::", "192.168.1.5", "128.0.0.1", "example.com"]) {
  assert.match(devIdentity.devIdentityViolation({ env: devEnv(host), argv: [] }) ?? "", new RegExp(host.replace(/[.:]/g, "\\$&")), `HOSTNAME=${host} must be rejected`);
  for (const argv of [["-H", host], [`-H${host}`], ["--hostname", host], [`--hostname=${host}`]]) {
    assert.ok(devIdentity.devIdentityViolation({ env: devEnv("127.0.0.1"), argv }), `${argv.join(" ")} must be rejected`);
  }
}
assert.ok(devIdentity.devIdentityViolation({ env: devEnv(undefined), argv: [] }), "a missing hostname means all interfaces and must be rejected");
assert.match(devIdentity.devIdentityViolation({ env: { ...devEnv("127.0.0.1"), NODE_ENV: "production" }, argv: [] }) ?? "", /NODE_ENV=production/);
assert.match(devIdentity.devIdentityViolation({ env: devEnv("127.0.0.1"), argv: [], listening: ["::"] }) ?? "", /::/, "an actual non-loopback listener must be rejected");
assert.equal(devIdentity.devIdentityViolation({ env: { NODE_ENV: "production", HOSTNAME: "0.0.0.0" }, argv: [] }), null, "the rules apply only while the switch is on");

// Switch off: request headers never establish an identity, whatever NODE_ENV says.
for (const nodeEnv of ["development", "test", "production"]) {
  await withEnv({ NODE_ENV: nodeEnv, HOSTNAME: "127.0.0.1" }, async () => {
    await assert.rejects(authContext.requestContextFrom(new Request("http://console.internal/api/v1/alerts", { headers: devHeaders })), rejectedWith(401), `NODE_ENV=${nodeEnv} without the switch must require a bearer token`);
    const response = await runProxy(new NextRequest("http://console.internal/api/v1/alerts", { headers: devHeaders }));
    assert.equal(response.status, 401, `the proxy must reject header identity under NODE_ENV=${nodeEnv}`);
    assert.deepEqual(await response.json(), { error: "missing_bearer_token" });
    assert.equal(response.headers.get("x-middleware-next"), null, "a rejected request must not continue to rendering");
    const cookieRequest = new NextRequest("http://console.internal/api/v1/alerts", { method: "POST", headers: { cookie: "shuzhiren_access_token=cookie-token", origin: "https://attacker.example", host: "console.internal" } });
    const csrf = await runProxy(cookieRequest);
    assert.equal(csrf.status, 403, `cookie-authenticated unsafe requests from an untrusted origin must be rejected under NODE_ENV=${nodeEnv}`);
    assert.throws(() => serviceAuth.requireRuntimeService(new Request("http://console.internal", { headers: { authorization: "Bearer demo-runtime-token" } }), "tenant_demo"), rejectedWith(503), `the built-in development service token must be unavailable without the switch under NODE_ENV=${nodeEnv}`);
  });
}

// Switch on, loopback, not production: the development headers apply.
await withEnv({ CONTROL_PLANE_DEV_HEADER_IDENTITY: "true", NODE_ENV: "development", HOSTNAME: "127.0.0.1" }, async () => {
  assert.deepEqual(await authContext.requestContextFrom(new Request("http://127.0.0.1/api/v1/alerts", { headers: devHeaders })), { tenantId: "tenant_header", actorId: "header-actor", actorName: "Header Actor", role: "admin" });
  assert.deepEqual(await authContext.requestContextFrom(new Request("http://127.0.0.1/api/v1/alerts", { headers: { ...devHeaders, "x-actor-id": "" } })), authContext.demoRequestContext);
  await assert.rejects(authContext.requestContextFrom(new Request("http://127.0.0.1/api/v1/alerts", { headers: { ...devHeaders, "x-actor-role": "owner" } })), rejectedWith(403));
  assert.doesNotThrow(() => serviceAuth.requireRuntimeService(new Request("http://127.0.0.1", { headers: { authorization: "Bearer demo-runtime-token" } }), "tenant_demo"));
});
for (const values of [{ NODE_ENV: "production", HOSTNAME: "127.0.0.1" }, { NODE_ENV: "development", HOSTNAME: "0.0.0.0" }]) {
  await withEnv({ CONTROL_PLANE_DEV_HEADER_IDENTITY: "true", ...values }, () => assert.rejects(authContext.requestContextFrom(new Request("http://127.0.0.1/api/v1/alerts", { headers: devHeaders })), rejectedWith(503, "dev_identity_forbidden"), `the switch must be refused with ${JSON.stringify(values)}`));
}
const instrumentation = await readFile(new URL("../apps/console/instrumentation.ts", import.meta.url), "utf8");
if (!instrumentation.includes("enforceDevIdentityStartupGuard()")) throw new Error("the control plane must refuse to start with the development identity switch outside loopback development");

console.log("PASS  development header identity requires CONTROL_PLANE_DEV_HEADER_IDENTITY=true on a loopback, non-production server");
