import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = await readFile(path.join(root, "infra/postgres/migrations/054_governed_membership_authorization.sql"), "utf8");
const authContext = await readFile(path.join(root, "apps/console/lib/control-plane/auth-context.ts"), "utf8");
const proxy = await readFile(path.join(root, "apps/console/proxy.ts"), "utf8");
const routesRoot = path.join(root, "apps/console/app/api/v1");

for (const source of ["add column if not exists status", "memberships_protect_last_admin", "cannot remove the last active tenant admin", "requested_role is deliberately ignored"]) {
  if (!migration.includes(source)) throw new Error(`governed membership migration missing: ${source}`);
}
if (migration.includes("insert into memberships (tenant_id, user_id, role)\n  values (requested_tenant_id")) throw new Error("sync_control_plane_actor must not provision or overwrite memberships");
for (const source of ["resolveActiveMembership", "m.status = 'active'", "return resolveActiveMembership(tenantId, actorId)"]) {
  if (!authContext.includes(source)) throw new Error(`production request context must resolve active database membership: ${source}`);
}
for (const source of ["stringClaim(payload, \"role\")", "requiredRoles("]) {
  if (proxy.includes(source)) throw new Error(`proxy must not authorize from JWT role claims: ${source}`);
}

const exempt = new Set([
  "integrations/product-facts/route.ts",
  "runtime/channel-commerce/route.ts",
  "runtime/channel-interactions/route.ts",
  "runtime/recordings/route.ts",
  "runtime/settlement-batches/route.ts",
  "runtime/telemetry/route.ts",
  "runtime/program-output-observations/route.ts"
]);
const routeFiles = await collectRoutes(routesRoot);
for (const file of routeFiles) {
  const relative = path.relative(routesRoot, file).replaceAll("\\", "/");
  if (exempt.has(relative)) continue;
  const source = await readFile(file, "utf8");
  const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
  for (let index = 0; index < handlers.length; index += 1) {
    const start = handlers[index].index;
    const end = handlers[index + 1]?.index ?? source.length;
    const handler = source.slice(start, end);
    if (!handler.includes("requestContextFrom") || !handler.includes("requireRole(")) throw new Error(`human API handler must enforce database-derived roles: ${handlers[index][1]} ${relative}`);
  }
}

console.log(`PASS  governed database memberships authorize ${routeFiles.length - exempt.size} human API routes; JWT roles cannot restore access`);

// A thrown Response built as new Response(message, { status }) has an empty
// statusText, so mapping it with { error: error.statusText } alone answers
// 401/403 with an empty error code. Every mapping needs a non-empty fallback.
for (const file of routeFiles) {
  const source = await readFile(file, "utf8");
  if (/\{\s*error:\s*error\.statusText\s*\}/.test(source)) throw new Error(`API error responses must fall back to a non-empty error code: ${path.relative(routesRoot, file).replaceAll("\\", "/")}`);
}
console.log(`PASS  ${routeFiles.length} API route files map thrown responses to non-empty error codes`);

// Behavioral check: an analyst (dev header identity, no database) is refused by
// the mutating handlers that used to answer { "error": "" }.
register("./lib/console-ts-loader.mjs", import.meta.url);
Object.assign(process.env, { CONTROL_PLANE_DEV_HEADER_IDENTITY: "true", NODE_ENV: "development", HOSTNAME: "127.0.0.1" });
const analystHeaders = { "x-tenant-id": "tenant_demo", "x-actor-id": "analyst-check", "x-actor-name": "Analyst Check", "x-actor-role": "analyst", "content-type": "application/json" };
const id = "00000000-0000-4000-8000-000000000001";
for (const [route, params, expected] of [
  ["channels/connections", {}, "channel_connection_rejected"],
  ["channels/connections/[connectionId]/verify", { connectionId: id }, "channel_verification_rejected"],
  ["assets/[assetId]/approve", { assetId: id }, "media_asset_rejected"],
  ["products", {}, "product_rejected"],
  ["products/[productId]/versions", { productId: id }, "product_version_rejected"],
  ["products/[productId]/versions/[versionId]/approve", { productId: id, versionId: id }, "product_version_rejected"],
  ["releases", {}, "model_release_rejected"],
  ["releases/[releaseId]/approve", { releaseId: id }, "model_release_rejected"]
]) {
  const { POST } = await import(pathToFileURL(path.join(routesRoot, route, "route.ts")).href);
  const response = await POST(new Request(`http://127.0.0.1/api/v1/${route}`, { method: "POST", headers: analystHeaders, body: "{}" }), { params: Promise.resolve(params) });
  assert.equal(response.status, 403, `an analyst must be refused by POST /api/v1/${route}`);
  assert.deepEqual(await response.json(), { error: expected }, `POST /api/v1/${route} must answer a non-empty error code`);
}
console.log("PASS  refused mutations answer 403 with a non-empty error code");

async function collectRoutes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectRoutes(fullPath));
    else if (entry.name === "route.ts") files.push(fullPath);
  }
  return files;
}
