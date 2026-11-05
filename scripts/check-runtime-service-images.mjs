import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { gatewayLockViolations, nodeMajorViolations, pinViolations, pythonLockViolations, releaseDockerfiles } from "./lib/dockerfile-refs.mjs";
import { checkDockerignore } from "./lib/dockerignore.mjs";
import { engineMinVersion, NODE_LTS_MAJOR, versionMajor } from "./lib/node-runtime.mjs";
const repoFile = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
// Node.js runtime (Requirement 27): engines, the lock root and every node base image use NODE_LTS_MAJOR.
const nodeProblems = [];
const rootPackage = JSON.parse(await repoFile("package.json"));
const lock = JSON.parse(await repoFile("package-lock.json"));
try {
  const minimum = engineMinVersion(rootPackage.engines?.node);
  if (minimum.split(".")[0] !== String(NODE_LTS_MAJOR)) nodeProblems.push(`package.json engines.node ${rootPackage.engines.node} must start at Node.js ${NODE_LTS_MAJOR}`);
} catch (error) {
  nodeProblems.push(`package.json ${error.message}`);
}
if (lock.packages?.[""]?.engines?.node !== rootPackage.engines?.node) nodeProblems.push(`package-lock.json packages[""].engines.node ${JSON.stringify(lock.packages?.[""]?.engines?.node)} must equal package.json engines.node ${JSON.stringify(rootPackage.engines?.node)}`);
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (key.startsWith("apps/") && !key.includes("node_modules")) {
    for (const field of ["dependencies", "devDependencies"]) {
      const spec = entry?.[field]?.["@types/node"];
      if (spec !== undefined && versionMajor(spec) !== String(NODE_LTS_MAJOR)) nodeProblems.push(`${key}/package.json ${field} @types/node ${spec} must be a Node.js ${NODE_LTS_MAJOR} version`);
    }
  } else if (key.endsWith("node_modules/@types/node") && versionMajor(entry?.version) !== String(NODE_LTS_MAJOR)) {
    nodeProblems.push(`package-lock.json ${key} ${entry?.version} must be a Node.js ${NODE_LTS_MAJOR} version`);
  }
}
const imageDockerfiles = releaseDockerfiles(yaml.load(await repoFile(".github/workflows/release.yml")));
const dockerfileText = Object.fromEntries(await Promise.all(imageDockerfiles.map(async (file) => [file, await repoFile(file)])));
for (const [file, text] of Object.entries(dockerfileText)) {
  for (const problem of nodeMajorViolations(file, text, NODE_LTS_MAJOR)) nodeProblems.push(`${problem.file}:${problem.line} ${problem.ref} ${problem.reason}`);
}
if (nodeProblems.length > 0) {
  for (const problem of nodeProblems) console.error(`ERROR  ${problem}`);
  throw new Error(`Node.js runtime must be ${NODE_LTS_MAJOR} LTS everywhere (${nodeProblems.length} problem(s) above)`);
}
// Supply chain (Requirement 35): digest-pinned base images, hashed Gateway lock.
const pinProblems = Object.entries(dockerfileText).flatMap(([file, text]) => pinViolations(file, text));
pinProblems.push(...gatewayLockViolations("runtime/gateway/Dockerfile", dockerfileText["runtime/gateway/Dockerfile"] ?? ""));
for (const message of pythonLockViolations(await repoFile("runtime/gateway/requirements.lock"), await repoFile("runtime/gateway/requirements.txt"))) {
  pinProblems.push({ file: "runtime/gateway/requirements.lock", line: 1, ref: "lock", reason: message });
}
if (pinProblems.length > 0) {
  for (const { file, line, ref, reason } of pinProblems) console.error(`ERROR  ${file}:${line} ${ref} ${reason}`);
  throw new Error(`Release images must use digest-pinned base images and hashed dependency locks (${pinProblems.length} problem(s) above)`);
}

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

console.log(`PASS  runtime service images use deterministic, non-root production builds (${imageDockerfiles.length} release Dockerfiles on digest-pinned base images, Node.js ${NODE_LTS_MAJOR}, hashed Gateway lock)`);
