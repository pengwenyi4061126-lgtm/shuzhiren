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

// JWT hardening: every token goes to both the proxy and the route-side
// requestContextFrom. tenant_id is never a UUID here, so a token that passes
// verification stops at 403 invalid_tenant_subject before any database access.
const { SignJWT, exportJWK, generateKeyPair } = await import("jose");
const http = await import("node:http");
const rsa = await generateKeyPair("RS256");
const ec = await generateKeyPair("ES256");
const jwks = { keys: [{ ...(await exportJWK(rsa.publicKey)), kid: "rs", alg: "RS256", use: "sig" }, { ...(await exportJWK(ec.publicKey)), kid: "es", alg: "ES256", use: "sig" }] };
const jwksServer = http.createServer((request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(jwks)); });
await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
const issuer = "https://issuer.jwt-hardening.test";
const audience = "shuzhiren-jwt-hardening";
const oidcEnv = { OIDC_ISSUER_URL: issuer, OIDC_AUDIENCE: audience, OIDC_JWKS_URL: `http://127.0.0.1:${jwksServer.address().port}/jwks` };
const now = Math.floor(Date.now() / 1000);
async function operatorToken({ alg = "RS256", typ, claims = {} } = {}) {
  const header = { alg, kid: alg === "RS256" ? "rs" : "es", ...(typ === undefined ? {} : { typ }) };
  return new SignJWT({ tenant_id: "not-a-uuid", exp: now + 300, ...claims }).setProtectedHeader(header).setSubject("jwt-hardening").setIssuer(issuer).setAudience(audience).setIssuedAt(now).sign(alg === "RS256" ? rsa.privateKey : ec.privateKey);
}
async function outcomes(token) {
  const proxyResponse = await runProxy(new NextRequest("http://console.internal/api/v1/alerts", { headers: { authorization: `Bearer ${token}` } }));
  const proxyBody = await proxyResponse.json().catch(() => null);
  let route;
  try {
    await authContext.requestContextFrom(new Request("http://console.internal/api/v1/alerts", { headers: { authorization: `Bearer ${token}` } }));
    route = "accepted";
  } catch (error) {
    route = error instanceof Response ? `${error.status}` : `error: ${error.message}`;
  }
  return { proxy: `${proxyResponse.status} ${proxyBody?.error ?? ""}`.trim(), proxyContinues: proxyResponse.headers.get("x-middleware-next") !== null, route };
}
const oidcModule = await import("../apps/console/lib/control-plane/oidc.ts");
try {
  const rejected = { proxy: "401 bearer_token_verification_failed", proxyContinues: false, route: "401" };
  const verifiedButNoTenant = { proxy: "403 invalid_tenant_subject", proxyContinues: false, route: "403" };
  await withEnv({ NODE_ENV: "production" }, async () => {
    Object.assign(process.env, oidcEnv, { OIDC_ALLOWED_ALGORITHMS: "RS256" });
    assert.deepEqual(await outcomes(await operatorToken()), verifiedButNoTenant, "a well-formed RS256 token must pass verification");
    for (const [label, token] of [
      ["without exp", await new SignJWT({ tenant_id: "not-a-uuid" }).setProtectedHeader({ alg: "RS256", kid: "rs" }).setSubject("jwt-hardening").setIssuer(issuer).setAudience(audience).sign(rsa.privateKey)],
      ["with a string exp", await operatorToken({ claims: { exp: "9999999999" } })],
      ["expiring now", await operatorToken({ claims: { exp: Math.floor(Date.now() / 1000) } })],
      ["expired a minute ago", await operatorToken({ claims: { exp: now - 60 } })],
      ["signed with ES256 outside the allowlist", await operatorToken({ alg: "ES256" })]
    ]) assert.deepEqual(await outcomes(token), rejected, `a token ${label} must be rejected`);

    process.env.OIDC_EXPECTED_TYP = "at+jwt";
    for (const [label, typ] of [["without typ", undefined], ["with typ JWT", "JWT"]]) assert.deepEqual(await outcomes(await operatorToken({ typ })), rejected, `a token ${label} must be rejected when at+jwt is expected`);
    for (const typ of ["application/at+jwt", "AT+JWT", "at+jwt"]) assert.deepEqual(await outcomes(await operatorToken({ typ })), verifiedButNoTenant, `typ ${typ} must satisfy at+jwt`);
    delete process.env.OIDC_EXPECTED_TYP;

    for (const value of ["", " , ", "HS256", "RS256,none"]) {
      process.env.OIDC_ALLOWED_ALGORITHMS = value;
      assert.deepEqual(await outcomes(await operatorToken()), { proxy: "503 oidc_algorithms_not_configured", proxyContinues: false, route: "503" }, `OIDC_ALLOWED_ALGORITHMS=${JSON.stringify(value)} must leave verification unconfigured`);
    }
    delete process.env.OIDC_ALLOWED_ALGORITHMS;
    assert.deepEqual(oidcModule.oidcVerificationConfig(process.env).algorithms, [...oidcModule.supportedOidcAlgorithms], "an unset allowlist must default to the asymmetric algorithms");
    assert.deepEqual(await outcomes(await operatorToken({ alg: "ES256" })), verifiedButNoTenant, "the default allowlist must accept asymmetric algorithms");
    for (const name of ["OIDC_ISSUER_URL", "OIDC_AUDIENCE", "OIDC_JWKS_URL"]) delete process.env[name];
    assert.deepEqual(await outcomes(await operatorToken()), { proxy: "503 oidc_configuration_missing", proxyContinues: false, route: "503" }, "missing OIDC configuration must answer 503 rather than 500");
  });
} finally {
  for (const name of ["OIDC_ISSUER_URL", "OIDC_AUDIENCE", "OIDC_JWKS_URL", "OIDC_ALLOWED_ALGORITHMS", "OIDC_EXPECTED_TYP"]) delete process.env[name];
  await new Promise((resolve) => jwksServer.close(resolve));
}

console.log("PASS  operator JWTs require an allowlisted asymmetric alg, a numeric unexpired exp, and the configured typ in the proxy and route handlers");
