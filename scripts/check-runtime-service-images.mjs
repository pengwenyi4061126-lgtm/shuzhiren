import { readFile } from "node:fs/promises";
import { checkDockerignore } from "./lib/dockerignore.mjs";

const files = {
  console: "../apps/console/Dockerfile",
  worker: "../apps/runtime-worker/Dockerfile",
  observer: "../apps/runtime-observer/Dockerfile",
  probe: "../apps/output-probe/Dockerfile",
  adapter: "../apps/channel-adapter/Dockerfile",
  notifier: "../apps/alert-notifier/Dockerfile",
  cosyvoice: "../runtime/cosyvoice/Dockerfile",
  workerIgnore: "../apps/runtime-worker/Dockerfile.dockerignore",
  observerIgnore: "../apps/runtime-observer/Dockerfile.dockerignore",
  probeIgnore: "../apps/output-probe/Dockerfile.dockerignore",
  adapterIgnore: "../apps/channel-adapter/Dockerfile.dockerignore",
  notifierIgnore: "../apps/alert-notifier/Dockerfile.dockerignore",
  cosyvoiceIgnore: "../runtime/cosyvoice/Dockerfile.dockerignore"
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
for (const source of ["COPY --chown=cosyvoice:cosyvoice vendor/CosyVoice /opt/CosyVoice/CosyVoice", "MINIFORGE_SHA256", "sha256sum -c", "USER cosyvoice", "LABEL org.opencontainers.image.revision"]) {
  if (!contents.cosyvoice.includes(source)) throw new Error(`CosyVoice image must retain controlled source, digest metadata, and non-root execution: ${source}`);
}
for (const source of ["FROM dependencies AS migrator", "migration-integrity.mjs", "infra/postgres/migrations", "CMD [\"node\", \"scripts/migrate.mjs\"]"]) {
  if (!contents.console.includes(source)) throw new Error(`Control-plane image must retain isolated migration artifact: ${source}`);
}
for (const name of ["workerIgnore", "observerIgnore", "probeIgnore", "adapterIgnore", "notifierIgnore"]) {
  for (const source of ["node_modules", "vendor", "apps/*/.next", ".env", ".env.*", "secrets", "config", "models", "weights", "recordings", "exports", "cache", "logs"]) {
    if (!contents[name].includes(source)) throw new Error(`Runtime image build context must exclude local artifacts: ${name} ${source}`);
  }
}
const cosyvoiceContext = checkDockerignore(contents.cosyvoiceIgnore, {
  mustExclude: [
    ".git/config", ".env", "config/runtime.example.env", "secrets/stream-key", "apps/console/package.json", "vendor/LiveTalking/app.py", "runtime/patches/livetalking-observability.patch",
    "vendor/CosyVoice/.git", "vendor/CosyVoice/.git/config", "vendor/CosyVoice/third_party/Matcha-TTS/.git", "vendor/CosyVoice/.env", "vendor/CosyVoice/third_party/Matcha-TTS/.env",
    "vendor/CosyVoice/pretrained_models/Fun-CosyVoice3-0.5B-2512/llm.pt", "vendor/CosyVoice/secrets/token", "vendor/CosyVoice/weights/model.pt", "vendor/CosyVoice/logs/run.txt", "vendor/CosyVoice/server.log"
  ],
  mustInclude: ["vendor/CosyVoice/requirements.txt", "vendor/CosyVoice/runtime/python/fastapi/server.py", "vendor/CosyVoice/cosyvoice/cli/cosyvoice.py", "vendor/CosyVoice/third_party/Matcha-TTS/matcha/__init__.py"]
});
for (const file of cosyvoiceContext.leaked) throw new Error(`CosyVoice build context must exclude local artifacts: ${file}`);
for (const file of cosyvoiceContext.missing) throw new Error(`CosyVoice build context must include the locked source: ${file}`);

console.log("PASS  runtime service images use deterministic, non-root production builds");
