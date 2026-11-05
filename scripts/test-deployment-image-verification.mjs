import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { gatewayLockViolations, imageRefs, nodeMajorViolations, pinViolations, pythonLockViolations, releaseDockerfiles } from "./lib/dockerfile-refs.mjs";
import { consoleRunnerStage, engineMinVersion, NODE_LTS_MAJOR } from "./lib/node-runtime.mjs";
import { npmCiCopyViolations, npmLockViolations } from "./lib/npm-lock.mjs";
import { imageKeys, verifyReleaseImages } from "./verify-deployment-images.mjs";

const revision = "a".repeat(40);
const images = Object.fromEntries(imageKeys.map((key, index) => [key, `registry.internal/shuzhiren/${key.toLowerCase()}@sha256:${(index + 1).toString(16).repeat(64)}`]));
const manifest = { releaseRevision: revision, images };
const inspect = (image) => ({ repoDigests: [image], revision });

assert.equal(verifyReleaseImages(manifest, inspect), 10);
assert.throws(() => verifyReleaseImages(manifest, (image) => image === images.COSYVOICE_IMAGE ? { repoDigests: [], revision } : inspect(image)), /COSYVOICE_IMAGE local RepoDigests/);
assert.throws(() => verifyReleaseImages(manifest, (image) => image === images.LIVETALKING_IMAGE ? { repoDigests: [image], revision: "b".repeat(40) } : inspect(image)), /LIVETALKING_IMAGE OCI/);
assert.throws(() => verifyReleaseImages({ ...manifest, releaseRevision: "short" }, inspect), /full 40-character/);

console.log("PASS  deployment image verification requires ten signed RepoDigests and matching OCI revision labels");

// Base images of the release Dockerfiles (runtime:images:check, control-plane:compose:check).
const repoText = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const releaseFiles = releaseDockerfiles(yaml.load(await repoText(".github/workflows/release.yml")));
assert.equal(releaseFiles.length, 9, "release.yml builds nine distinct Dockerfiles");

// Node.js 24 (M9, Requirement 27).
assert.equal(NODE_LTS_MAJOR, 24);
assert.equal(engineMinVersion("^24.11.0"), "24.11.0");
for (const range of [">=20.9.0", ">=24.11.0", "24.x", "^24.11"]) assert.throws(() => engineMinVersion(range), /\^MAJOR\.MINOR\.PATCH/, range);
for (const ref of ["node:20-alpine", "node:lts-alpine", "node:alpine", "node", "docker.io/library/node:22-bookworm-slim", "library/node:current"]) {
  assert.equal(nodeMajorViolations("Dockerfile", `FROM ${ref}\n`, 24).length, 1, ref);
}
for (const ref of ["node:24-alpine", "node:24.11.1-alpine3.22", "node:24-bookworm-slim", "python:3.12-slim"]) {
  assert.deepEqual(nodeMajorViolations("Dockerfile", `FROM ${ref}\n`, 24), [], ref);
}
assert.deepEqual(nodeMajorViolations("Dockerfile", "FROM node:24-alpine AS deps\nFROM deps AS build\nCOPY --from=deps /a /b\nFROM node:20-alpine AS runner\n", 24).map(({ line }) => line), [4], "a later stage on Node 20 is reported at its own line");
assert.deepEqual(nodeMajorViolations("Dockerfile", "# FROM node:20-alpine\nFROM \\\n  node:20-alpine\n", 24).map(({ line }) => line), [2], "a continued FROM counts, a commented one does not");
assert.ok(consoleRunnerStage(24).test("FROM node:24-alpine AS runner"));
assert.ok(consoleRunnerStage(24).test(`FROM node:24.11.1-alpine3.22@sha256:${"a".repeat(64)} AS runner`));
for (const line of ["FROM node:20-alpine AS runner", "FROM node:24-bookworm-slim AS runner", "FROM node:lts-alpine AS runner", "FROM node:240-alpine AS runner"]) assert.ok(!consoleRunnerStage(24).test(line), line);
for (const file of releaseFiles) assert.deepEqual(nodeMajorViolations(file, await repoText(file), NODE_LTS_MAJOR), [], file);
assert.deepEqual(imageRefs("FROM scratch\nCOPY --from=0 /a /b\n").map(({ internal }) => internal), [true, true]);
console.log(`PASS  release Dockerfiles use Node.js ${NODE_LTS_MAJOR} base images`);

// Digest-pinned base images and the hashed Gateway lock (M24, Requirement 35).
const digest = "a".repeat(64);
const pinned = `node:24-alpine@sha256:${digest}`;
assert.deepEqual(pinViolations("Dockerfile", `FROM ${pinned} AS deps\nFROM deps AS build\nCOPY --from=build /a /b\nCOPY --from=0 /a /b\nFROM scratch\n`), [], "pinned, internal stages and scratch pass");
assert.deepEqual(pinViolations("Dockerfile", `FROM --platform=linux/amd64 registry.example.com:5000/team/base:1.2@sha256:${digest}\n`), [], "registry ports and --platform are accepted");
const unpinned = [
  ["node:24-alpine", "no digest"],
  [`node:24-alpine@sha256:${"A".repeat(64)}`, "upper-case digest"],
  [`node:24-alpine@sha256:${"a".repeat(63)}`, "63-hex digest"],
  [`node@sha256:${digest}`, "digest without tag"],
  ["node:latest", "moving tag"],
  ["${BASE}", "build variable"],
  [`registry.example.com:5000/team/base@sha256:${digest}`, "registry port mistaken for a tag"]
];
for (const [ref, label] of unpinned) assert.equal(pinViolations("Dockerfile", `FROM ${ref}\n`).length, 1, label);
assert.deepEqual(pinViolations("Dockerfile", `# FROM node:20\nFROM ${pinned} AS build\nRUN true\nCOPY \\\n  --from=alpine:3.20 /bin/sh /bin/sh\n`).map(({ line, ref }) => `${line} ${ref}`), ["4 alpine:3.20"], "an external COPY --from is reported at its starting line");
for (const file of releaseFiles) assert.deepEqual(pinViolations(file, await repoText(file)), [], `${file} pins every base image`);

const gatewayDockerfile = (install) => `FROM python:3.12-slim@sha256:${digest}\nCOPY requirements.lock .\nRUN ${install}\n`;
assert.deepEqual(gatewayLockViolations("Dockerfile", gatewayDockerfile("pip install --no-cache-dir --require-hashes -r requirements.lock")), []);
for (const [install, label] of [
  ["pip install --no-cache-dir -r requirements.lock", "no --require-hashes"],
  ["pip install --no-cache-dir --require-hashes -r requirements.txt", "unhashed input file"],
  ["pip install --require-hashes -r requirements.lock && pip install uvicorn", "a second pip install"],
  ["pip install --require-hashes -r requirements.lock uvicorn", "an extra package argument"]
]) assert.ok(gatewayLockViolations("Dockerfile", gatewayDockerfile(install)).length > 0, label);
assert.ok(gatewayLockViolations("Dockerfile", `FROM python:3.12-slim@sha256:${digest}\nCOPY requirements.txt .\nRUN pip install --require-hashes -r requirements.lock\n`).length > 0, "copying requirements.txt without the lock");
assert.deepEqual(gatewayLockViolations("runtime/gateway/Dockerfile", await repoText("runtime/gateway/Dockerfile")), []);

const hash = (char) => `--hash=sha256:${char.repeat(64)}`;
const goodLock = `# generated\nfastapi==0.1.0 \\\n    ${hash("a")} \\\n    ${hash("b")}\n    # via -r requirements.txt\nuvicorn==0.2.0 ; python_version >= '3.12' \\\n    ${hash("c")}\n`;
assert.deepEqual(pythonLockViolations(goodLock, "fastapi==0.1.0\nuvicorn[standard]==0.2.0\n"), []);
for (const [lock, label] of [
  ["fastapi==0.1.0\n", "missing hash"],
  [`fastapi>=0.1.0 \\\n    ${hash("a")}\n`, "range instead of =="],
  [`fastapi \\\n    ${hash("a")}\n`, "no version"],
  [`fastapi==0.1.0 \\\n    --hash=sha256:${"a".repeat(63)}\n`, "short hash"],
  [`--find-links https://example.invalid/\nfastapi==0.1.0 \\\n    ${hash("a")}\n`, "--find-links"],
  [`--extra-index-url https://example.invalid/simple\nfastapi==0.1.0 \\\n    ${hash("a")}\n`, "unlisted index"],
  [`-e ./local\nfastapi==0.1.0 \\\n    ${hash("a")}\n`, "editable"],
  [`fastapi==0.2.0 \\\n    ${hash("a")}\n`, "top-level version differs from requirements.txt"],
  [`starlette==0.1.0 \\\n    ${hash("a")}\n`, "top-level requirement missing"]
]) assert.ok(pythonLockViolations(lock, "fastapi==0.1.0\n").length > 0, label);
assert.ok(pythonLockViolations(goodLock, "fastapi>=0.1.0\n").length > 0, "an unpinned top-level input is rejected");
assert.deepEqual(pythonLockViolations(await repoText("runtime/gateway/requirements.lock"), await repoText("runtime/gateway/requirements.txt")), []);
console.log("PASS  release Dockerfiles pin base images by digest and the Gateway installs only its hashed lock");

// package-lock.json matches what npm ci installs in the Linux images (L17).
const integrity = `sha512-${"A".repeat(86)}==`;
const registryEntry = (name, version, extra = {}) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity, ...extra });
const workspace = { "apps/web": { name: "@x/web", dependencies: { next: "1.0.0" } } };
const sampleLock = () => ({
  lockfileVersion: 3,
  packages: {
    "": { name: "x", workspaces: ["apps/*"] },
    "apps/web": { name: "@x/web", dependencies: { next: "1.0.0" } },
    "node_modules/@x/web": { resolved: "apps/web", link: true },
    "node_modules/next": registryEntry("next", "1.0.0", { optionalDependencies: { "@next/swc-linux-x64-musl": "1.0.0", "@next/swc-win32-x64-msvc": "1.0.0" } }),
    "node_modules/@next/swc-linux-x64-musl": registryEntry("@next/swc-linux-x64-musl", "1.0.0", { optional: true, os: ["linux"], cpu: ["x64"], libc: ["musl"] }),
    "node_modules/@next/swc-win32-x64-msvc": registryEntry("@next/swc-win32-x64-msvc", "1.0.0", { optional: true, os: ["win32"], cpu: ["x64"] })
  }
});
assert.deepEqual(npmLockViolations(sampleLock(), workspace), []);
const lockCases = [
  ["only the Windows binary is locked", (lock) => delete lock.packages["node_modules/@next/swc-linux-x64-musl"], /@next\/swc-linux-x64-musl has no lock entry/],
  ["an entry without integrity", (lock) => delete lock.packages["node_modules/next"].integrity, /node_modules\/next must have a sha512 integrity/],
  ["an entry without resolved", (lock) => delete lock.packages["node_modules/next"].resolved, /node_modules\/next must have a resolved/],
  ["a non-registry tarball", (lock) => (lock.packages["node_modules/next"].resolved = "https://mirror.example.com/next-1.0.0.tgz"), /must have a resolved https:\/\/registry\.npmjs\.org\//],
  ["workspace drift from package.json", (lock) => (lock.packages["apps/web"].dependencies.next = "0.9.0"), /apps\/web dependencies/],
  ["a missing workspace dependency", (lock) => delete lock.packages["node_modules/next"], /apps\/web dependencies next has no lock entry/],
  ["lockfileVersion 2", (lock) => (lock.lockfileVersion = 2), /lockfileVersion must be 3/]
];
for (const [label, edit, pattern] of lockCases) {
  const lock = sampleLock();
  edit(lock);
  const problems = npmLockViolations(lock, workspace);
  assert.ok(problems.some((problem) => pattern.test(problem)), `${label}: ${problems.join("; ")}`);
}
const npmCiDockerfile = `FROM ${pinned} AS deps\nCOPY package.json package-lock.json ./\nCOPY apps/web/package.json apps/web/package.json\nRUN npm ci\nFROM deps AS build\nRUN npm ci --omit=dev\n`;
assert.deepEqual(npmCiCopyViolations("Dockerfile", npmCiDockerfile, ["apps/web"]), [], "a later stage inherits the copied manifests of its parent stage");
assert.deepEqual(npmCiCopyViolations("Dockerfile", npmCiDockerfile, ["apps/web", "apps/api"]), ["Dockerfile:4 npm ci runs before COPY apps/api/package.json", "Dockerfile:6 npm ci runs before COPY apps/api/package.json"]);
assert.deepEqual(npmCiCopyViolations("Dockerfile", `FROM ${pinned}\nCOPY package.json ./\nRUN npm ci\n`, []), ["Dockerfile:3 npm ci runs before COPY package-lock.json"]);
const repoLock = JSON.parse(await repoText("package-lock.json"));
const repoWorkspaces = Object.keys(repoLock.packages).filter((key) => /^apps\/[^/]+$/.test(key));
assert.equal(repoWorkspaces.length, 6);
const repoManifests = Object.fromEntries(await Promise.all(repoWorkspaces.map(async (dir) => [dir, JSON.parse(await repoText(`${dir}/package.json`))])));
assert.deepEqual(npmLockViolations(repoLock, repoManifests), []);
for (const binary of ["@next/swc-linux-x64-musl", "@next/swc-linux-x64-gnu", "@img/sharp-linuxmusl-x64", "@img/sharp-linux-x64"]) assert.ok(repoLock.packages[`node_modules/${binary}`], `package-lock.json locks ${binary} for the Linux images`);
for (const file of releaseFiles) assert.deepEqual(npmCiCopyViolations(file, await repoText(file), repoWorkspaces), [], file);
console.log("PASS  package-lock.json is fully resolved with integrity for every platform and matches the npm ci workspaces");
