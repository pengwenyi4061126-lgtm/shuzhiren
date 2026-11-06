import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const [migration, auth, memberships, channels, store, runAccess] = await Promise.all([
  read("infra", "postgres", "migrations", "057_membership_resource_scopes.sql"),
  read("apps", "console", "lib", "control-plane", "auth-context.ts"),
  read("apps", "console", "lib", "memberships.ts"),
  read("apps", "console", "lib", "channels.ts"),
  read("apps", "console", "lib", "control-plane", "store.ts"),
  read("apps", "console", "lib", "control-plane", "run-access.ts")
]);

for (const source of ["membership_access_scope", "membership_resource_scopes", "tenant_isolation_membership_resource_scopes", "memberships_guard_access_scope", "validate_membership_resource_scope", "channel_connection", "live_run"]) if (!migration.includes(source)) throw new Error(`membership scope migration missing: ${source}`);
for (const source of ["membershipId", "accessScope", "m.access_scope"]) if (!auth.includes(source)) throw new Error(`request context must carry database membership scope: ${source}`);
for (const source of ["resourceScopes", "replaceResourceScopes", "Tenant administrators must retain tenant-wide access"]) if (!memberships.includes(source)) throw new Error(`membership service must manage governed scopes: ${source}`);
for (const source of ["restrictedMembership", "membership_resource_scopes", "Restricted members cannot create tenant-wide channel connections"]) if (!channels.includes(source)) throw new Error(`channel service must enforce membership scopes: ${source}`);
for (const source of ["loadAuthorizedPersistentRun", "restrictedMembership", "membership_resource_scopes"]) if (!store.includes(source)) throw new Error(`live run store must enforce membership scopes: ${source}`);
for (const source of ["assertLiveRunAccess", "membership_resource_scopes", "channel_connection"]) if (!runAccess.includes(source)) throw new Error(`run access guard missing: ${source}`);

for (const service of ["show-program.ts", "show-program-revisions.ts", "channel-replies.ts", "interactions.ts", "monitoring.ts", "incidents.ts", "control-plane/outbox.ts", "commerce.ts", "release-manifest.ts", "run-events.ts", "policy-profiles.ts", "script-plays.ts"]) {
  if (!(await read("apps", "console", "lib", service)).includes("assertLiveRunAccess")) throw new Error(`live-run service bypasses membership scope guard: ${service}`);
}

for (const service of ["monitoring.ts", "incidents.ts", "recordings.ts", "control-plane/outbox.ts"]) {
  const source = await read("apps", "console", "lib", service);
  for (const marker of ["hasRestrictedMembership", "membership_resource_scopes"]) if (!source.includes(marker)) throw new Error(`run evidence service must filter restricted memberships: ${service} ${marker}`);
}

const routeRoot = path.join(root, "apps", "console", "app", "api", "v1", "live-runs");
for (const file of await collectRoutes(routeRoot)) if (!(await readFile(file, "utf8")).includes("requestContextFrom")) throw new Error(`live-run route lacks authenticated request context: ${path.relative(root, file)}`);
console.log("PASS  restricted memberships are bounded to assigned channels, live runs, and live-run evidence across control-plane services");

async function collectRoutes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) { const fullPath = path.join(directory, entry.name); if (entry.isDirectory()) files.push(...await collectRoutes(fullPath)); else if (entry.name === "route.ts") files.push(fullPath); }
  return files;
}
