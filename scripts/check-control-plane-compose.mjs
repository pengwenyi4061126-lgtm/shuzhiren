import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { interpolate } from "./lib/compose-interpolation.mjs";

const [nextConfig, dockerfile, dockerignore, compose, environment, migrator, integrity, baseliner, runtimeCompose, prometheus] = await Promise.all([
  readFile(new URL("../apps/console/next.config.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/Dockerfile", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/Dockerfile.dockerignore", import.meta.url), "utf8"),
  readFile(new URL("../infra/compose/docker-compose.control-plane.yml", import.meta.url), "utf8"),
  readFile(new URL("../config/control-plane-compose.example.env", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/scripts/migrate.mjs", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/scripts/migration-integrity.mjs", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/scripts/baseline-migration-checksums.mjs", import.meta.url), "utf8"),
  readFile(new URL("../infra/compose/docker-compose.runtime.yml", import.meta.url), "utf8"),
  readFile(new URL("../infra/observability/prometheus.example.yml", import.meta.url), "utf8")
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

// Prometheus example targets must name a real Compose service and its container port (L13).
function defaultsOnly(value) {
  try {
    return interpolate(String(value), new Map());
  } catch {
    return undefined;
  }
}
function containerPorts(service) {
  const ports = new Set();
  for (const entry of service?.ports ?? []) {
    const rendered = typeof entry === "object" && entry !== null ? String(entry.target ?? "") : defaultsOnly(entry);
    const containerSide = rendered?.split(":").pop()?.split("/")[0];
    if (containerSide && /^\d+$/.test(containerSide)) ports.add(containerSide);
  }
  for (const entry of service?.expose ?? []) {
    const rendered = defaultsOnly(entry)?.split("/")[0];
    if (rendered && /^\d+$/.test(rendered)) ports.add(rendered);
  }
  const environmentPort = defaultsOnly(service?.environment?.PORT ?? "");
  if (environmentPort && /^\d+$/.test(environmentPort)) ports.add(environmentPort);
  return ports;
}
const composeServices = { ...yaml.load(runtimeCompose)?.services, ...yaml.load(compose)?.services };
const scrapeConfigs = yaml.load(prometheus)?.scrape_configs;
if (!Array.isArray(scrapeConfigs) || scrapeConfigs.length === 0) throw new Error("Prometheus example must define scrape_configs");
for (const scrape of scrapeConfigs) {
  for (const staticConfig of scrape?.static_configs ?? []) {
    for (const target of staticConfig?.targets ?? []) {
      const match = /^([a-z0-9-]+):(\d+)$/.exec(String(target));
      if (!match) throw new Error(`Prometheus example target ${target} must be <compose-service>:<container-port>`);
      const [, serviceName, port] = match;
      if (!Object.hasOwn(composeServices, serviceName)) throw new Error(`Prometheus example target ${target} does not name a Compose service`);
      const ports = containerPorts(composeServices[serviceName]);
      if (!ports.has(port)) throw new Error(`Prometheus example target ${target} does not match the ${serviceName} container port (${[...ports].join(", ") || "none"})`);
    }
  }
}

console.log("PASS  control-plane standalone image and private Compose deployment are configured");
