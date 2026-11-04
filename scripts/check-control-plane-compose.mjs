import { readFile } from "node:fs/promises";

const [nextConfig, dockerfile, dockerignore, compose, environment, migrator, integrity, baseliner] = await Promise.all([
  readFile(new URL("../apps/console/next.config.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/Dockerfile", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/Dockerfile.dockerignore", import.meta.url), "utf8"),
  readFile(new URL("../infra/compose/docker-compose.control-plane.yml", import.meta.url), "utf8"),
  readFile(new URL("../config/control-plane-compose.example.env", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/scripts/migrate.mjs", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/scripts/migration-integrity.mjs", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/scripts/baseline-migration-checksums.mjs", import.meta.url), "utf8")
]);

for (const source of ['output: "standalone"']) {
  if (!nextConfig.includes(source)) throw new Error(`Console build must retain ${source}`);
}
for (const source of ["FROM dependencies AS build", "FROM node:20-alpine AS runner", ".next/standalone", ".next/static", "USER console", 'CMD ["node", "server.js"]']) {
  if (!dockerfile.includes(source)) throw new Error(`Console Dockerfile must retain a production standalone runtime: ${source}`);
}
for (const source of ["node_modules", "vendor", "apps/*/.next", ".env", ".env.*", "secrets", "config", "models", "weights", "recordings", "exports", "cache", "logs"]) {
  if (!dockerignore.includes(source)) throw new Error(`Console Docker build context must exclude local runtime artifacts: ${source}`);
}
for (const source of ["control-plane:", "control-plane-migrate:", "profiles: [\"migrate\"]", "${CONTROL_PLANE_ENV_FILE:?set-in-control-plane-compose-env}", '"${CONSOLE_HOST_BIND:-127.0.0.1}:${CONSOLE_PORT:-3000}:3000"', "restart: \"no\"", "image: ${CONTROL_PLANE_IMAGE:?set-in-control-plane-compose-env}", "image: ${CONTROL_PLANE_MIGRATOR_IMAGE:?set-in-control-plane-compose-env}", "command: [\"node\", \"scripts/migrate.mjs\"]"]) {
  if (!compose.includes(source)) throw new Error(`Control-plane Compose must retain private deployment behavior: ${source}`);
}
if (compose.includes("build:")) throw new Error("Control-plane production Compose must not build mutable local images");
for (const source of ["CONTROL_PLANE_ENV_FILE=/srv/shuzhiren/control.env", "CONSOLE_HOST_BIND=127.0.0.1", "CONSOLE_PORT=3000", "CONTROL_PLANE_IMAGE=", "CONTROL_PLANE_MIGRATOR_IMAGE="]) {
  if (!environment.includes(source)) throw new Error(`Control-plane Compose environment template must document ${source}`);
}
for (const source of ["pg_try_advisory_lock", "pg_advisory_unlock", "another schema migration is already running"]) {
  if (!migrator.includes(source)) throw new Error(`Control-plane migrations must retain concurrent deployment protection: ${source}`);
}
for (const source of ["checksum", "migration checksum drift detected", "schema_migrations_checksum_format"]) if (!integrity.includes(source)) throw new Error(`Control-plane migrations must retain checksum integrity: ${source}`);
for (const source of ["--approve-current-files", "refusing baseline", "baselined"]) if (!baseliner.includes(source)) throw new Error(`Control-plane migration baseline must require explicit approval: ${source}`);

console.log("PASS  control-plane standalone image and private Compose deployment are configured");
