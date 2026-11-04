import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
