import { readFile } from "node:fs/promises";

const [nextConfig, dockerfile, dockerignore, compose, environment] = await Promise.all([
  readFile(new URL("../apps/console/next.config.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/Dockerfile", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/Dockerfile.dockerignore", import.meta.url), "utf8"),
  readFile(new URL("../infra/compose/docker-compose.control-plane.yml", import.meta.url), "utf8"),
  readFile(new URL("../config/control-plane-compose.example.env", import.meta.url), "utf8")
]);

for (const source of ['output: "standalone"']) {
  if (!nextConfig.includes(source)) throw new Error(`Console build must retain ${source}`);
}
for (const source of ["FROM dependencies AS build", "FROM node:20-alpine AS runner", ".next/standalone", ".next/static", "USER console", 'CMD ["node", "server.js"]']) {
  if (!dockerfile.includes(source)) throw new Error(`Console Dockerfile must retain a production standalone runtime: ${source}`);
}
for (const source of ["node_modules", "vendor", "apps/*/.next"]) {
  if (!dockerignore.includes(source)) throw new Error(`Console Docker build context must exclude local runtime artifacts: ${source}`);
}
for (const source of ["control-plane:", "control-plane-migrate:", "profiles: [\"migrate\"]", "${CONTROL_PLANE_ENV_FILE:?set-in-control-plane-compose-env}", '"${CONSOLE_HOST_BIND:-127.0.0.1}:${CONSOLE_PORT:-3000}:3000"', "restart: \"no\""]) {
  if (!compose.includes(source)) throw new Error(`Control-plane Compose must retain private deployment behavior: ${source}`);
}
for (const source of ["CONTROL_PLANE_ENV_FILE=/srv/shuzhiren/control.env", "CONSOLE_HOST_BIND=127.0.0.1", "CONSOLE_PORT=3000"]) {
  if (!environment.includes(source)) throw new Error(`Control-plane Compose environment template must document ${source}`);
}

console.log("PASS  control-plane standalone image and private Compose deployment are configured");
