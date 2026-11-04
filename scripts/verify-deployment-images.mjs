import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const imageKeys = [
  "CONTROL_PLANE_IMAGE",
  "CONTROL_PLANE_MIGRATOR_IMAGE",
  "RUNTIME_GATEWAY_IMAGE",
  "RUNTIME_WORKER_IMAGE",
  "RUNTIME_OBSERVER_IMAGE",
  "OUTPUT_PROBE_IMAGE",
  "CHANNEL_ADAPTER_IMAGE",
  "ALERT_NOTIFIER_IMAGE",
  "LIVETALKING_IMAGE",
  "COSYVOICE_IMAGE"
];

function fail(message) {
  throw new Error(message);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("DEPLOYMENT_RELEASE_MANIFEST must be a JSON object");
  if (!/^[a-f0-9]{40}$/.test(manifest.releaseRevision ?? "")) fail("DEPLOYMENT_RELEASE_MANIFEST releaseRevision must be a full 40-character lowercase git SHA");
  const images = manifest.images;
  if (!images || typeof images !== "object" || Array.isArray(images) || Object.keys(images).length !== imageKeys.length) fail("DEPLOYMENT_RELEASE_MANIFEST must contain exactly ten service images");
  const digests = new Set();
  for (const key of imageKeys) {
    const image = images[key];
    const [repository, digest, ...rest] = typeof image === "string" ? image.split("@") : [];
    const imageName = repository?.slice(repository.lastIndexOf("/") + 1);
    if (rest.length || !repository?.includes("/") || imageName?.includes(":") || !/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) fail(`DEPLOYMENT_RELEASE_MANIFEST ${key} must be an immutable registry/repository@sha256 reference`);
    if (digests.has(digest)) fail(`DEPLOYMENT_RELEASE_MANIFEST reuses image digest ${digest}`);
    digests.add(digest);
  }
}

export function verifyReleaseImages(manifest, inspectImage) {
  validateManifest(manifest);
  for (const key of imageKeys) {
    const image = manifest.images[key];
    const metadata = inspectImage(image);
    if (!Array.isArray(metadata.repoDigests) || !metadata.repoDigests.includes(image)) fail(`${key} local RepoDigests do not include the signed image digest`);
    if (metadata.revision !== manifest.releaseRevision) fail(`${key} OCI org.opencontainers.image.revision does not match the signed release revision`);
  }
  return imageKeys.length;
}

function inspectDockerImage(image) {
  const docker = process.env.DOCKER_BIN || "docker";
  const execute = (format) => {
    const result = spawnSync(docker, ["image", "inspect", "--format", format, image], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) fail(`docker image inspect failed for ${image}: ${(result.stderr || result.stdout || "unknown error").trim()}`);
    return result.stdout.trim();
  };
  let repoDigests;
  try {
    repoDigests = JSON.parse(execute("{{json .RepoDigests}}"));
  } catch (error) {
    fail(`docker image inspect returned invalid RepoDigests for ${image}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  return { repoDigests, revision: execute('{{ index .Config.Labels "org.opencontainers.image.revision" }}') };
}

async function main() {
  const index = process.argv.indexOf("--manifest");
  const manifestPath = index >= 0 ? process.argv[index + 1] : undefined;
  if (!manifestPath || !path.isAbsolute(manifestPath)) fail("Usage: node scripts/verify-deployment-images.mjs --manifest /absolute/deployment-release-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(`Cannot read DEPLOYMENT_RELEASE_MANIFEST: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  const count = verifyReleaseImages(manifest, inspectDockerImage);
  console.log(`PASS  ${count} locally pulled service images match signed RepoDigests and OCI release revision ${manifest.releaseRevision}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ERROR  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
