import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { imageRefs, nodeMajorViolations, releaseDockerfiles } from "./lib/dockerfile-refs.mjs";
import { consoleRunnerStage, engineMinVersion, NODE_LTS_MAJOR } from "./lib/node-runtime.mjs";
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
