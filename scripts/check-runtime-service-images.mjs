import { readFile } from "node:fs/promises";

const files = {
  console: "../apps/console/Dockerfile",
  worker: "../apps/runtime-worker/Dockerfile",
  observer: "../apps/runtime-observer/Dockerfile",
  probe: "../apps/output-probe/Dockerfile",
  adapter: "../apps/channel-adapter/Dockerfile",
  notifier: "../apps/alert-notifier/Dockerfile",
  workerIgnore: "../apps/runtime-worker/Dockerfile.dockerignore",
  observerIgnore: "../apps/runtime-observer/Dockerfile.dockerignore",
  probeIgnore: "../apps/output-probe/Dockerfile.dockerignore",
  adapterIgnore: "../apps/channel-adapter/Dockerfile.dockerignore",
  notifierIgnore: "../apps/alert-notifier/Dockerfile.dockerignore"
};
const contents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readFile(new URL(file, import.meta.url), "utf8")])));

for (const source of ["npm ci --omit=dev --workspace @shuzhiren/runtime-worker", "USER node", 'CMD ["node", "index.mjs"]']) {
  if (!contents.worker.includes(source)) throw new Error(`Runtime worker image must retain deterministic non-root execution: ${source}`);
}
for (const [name, source] of [["observer", contents.observer], ["probe", contents.probe]]) {
  if (!source.includes("USER node")) throw new Error(`Runtime ${name} image must not run as root`);
}
for (const [name, source] of [["adapter", contents.adapter], ["notifier", contents.notifier]]) {
  for (const expected of ["npm ci --omit=dev", "USER node"]) {
    if (!source.includes(expected)) throw new Error(`Runtime ${name} image must retain deterministic non-root execution: ${expected}`);
  }
}
for (const source of ["FROM dependencies AS migrator", "migration-integrity.mjs", "infra/postgres/migrations", "CMD [\"node\", \"scripts/migrate.mjs\"]"]) {
  if (!contents.console.includes(source)) throw new Error(`Control-plane image must retain isolated migration artifact: ${source}`);
}
for (const name of ["workerIgnore", "observerIgnore", "probeIgnore", "adapterIgnore", "notifierIgnore"]) {
  for (const source of ["node_modules", "vendor", "apps/*/.next", ".env", ".env.*", "secrets", "config", "models", "weights", "recordings", "exports", "cache", "logs"]) {
    if (!contents[name].includes(source)) throw new Error(`Runtime image build context must exclude local artifacts: ${name} ${source}`);
  }
}

console.log("PASS  runtime service images use deterministic, non-root production builds");
