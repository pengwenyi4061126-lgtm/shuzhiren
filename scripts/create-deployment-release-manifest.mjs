import { createHash, createPrivateKey, sign } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
// Release manifests are signed over Canonical_JSON rule 2 (keys in code-point order, no locale dependence).
import { canonicalJson } from "../apps/console/lib/canonical-json.mjs";

const imageKeys = [
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

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || options.has(key)) fail("Usage: node scripts/create-deployment-release-manifest.mjs --images /absolute/images.json --sbom /absolute/release-sbom.json --provenance /absolute/release-provenance.json --private-key /absolute/release-ed25519-private.pem --issuer release_issuer --key-id key-id --revision <40-hex-git-sha> --output /absolute/deployment-release-manifest.json [--issued-at ISO-8601] [--expires-at ISO-8601]");
  options.set(key, value);
}

function fail(message) {
  console.error(`ERROR  ${message}`);
  process.exit(1);
}

function required(name) {
  const value = options.get(name);
  if (!value) fail(`Missing ${name}`);
  return value;
}

function absoluteFile(name) {
  const value = required(name);
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  return value;
}

async function jsonFile(file, name) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error) {
    fail(`${name} must be a readable JSON object: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

async function sha256(file, name) {
  try {
    return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
  } catch (error) {
    fail(`${name} must be readable: ${error instanceof Error ? error.message : "unreadable"}`);
  }
}

function timestamp(name, fallback) {
  const raw = options.get(name) ?? fallback.toISOString();
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime()) || value.toISOString() !== raw) fail(`${name} must be a canonical ISO-8601 UTC timestamp`);
  return value;
}

const imagesPath = absoluteFile("--images");
const sbomPath = absoluteFile("--sbom");
const provenancePath = absoluteFile("--provenance");
const privateKeyPath = absoluteFile("--private-key");
const outputPath = absoluteFile("--output");
const issuer = required("--issuer");
const keyId = required("--key-id");
const releaseRevision = required("--revision");
if (!/^[a-z][a-z0-9_-]{1,63}$/.test(issuer)) fail("--issuer must contain 2-64 lowercase letters, digits, underscores, or hyphens");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId)) fail("--key-id is invalid");
if (!/^[a-f0-9]{40}$/.test(releaseRevision)) fail("--revision must be a full 40-character lowercase git SHA");

const issuedAt = timestamp("--issued-at", new Date());
const expiresAt = timestamp("--expires-at", new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000));
if (expiresAt <= issuedAt || expiresAt.getTime() - issuedAt.getTime() > 30 * 24 * 60 * 60 * 1000) fail("--expires-at must be after --issued-at and no more than 30 days later");

const images = await jsonFile(imagesPath, "--images");
if (Object.keys(images).length !== imageKeys.length || imageKeys.some((key) => typeof images[key] !== "string")) fail(`--images must contain exactly these image keys: ${imageKeys.join(", ")}`);
const imageDigests = new Set();
for (const key of imageKeys) {
  const image = images[key];
  const [repository, digest, ...remainder] = image.split("@");
  const imageName = repository.slice(repository.lastIndexOf("/") + 1);
  if (remainder.length || !repository.includes("/") || imageName.includes(":") || !/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) fail(`--images ${key} must be an immutable registry/repository@sha256 reference`);
  if (imageDigests.has(digest)) fail(`--images must not reuse digest ${digest}`);
  imageDigests.add(digest);
}

let privateKey;
try {
  privateKey = createPrivateKey(await readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
} catch (error) {
  fail(`--private-key must be a readable Ed25519 private key: ${error instanceof Error ? error.message : "invalid key"}`);
}

try {
  await access(path.dirname(outputPath));
} catch {
  fail("--output parent directory must already exist");
}
try {
  await access(outputPath);
  fail("--output already exists; refusing to overwrite a release manifest");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const unsigned = {
  schemaVersion: 1,
  releaseRevision,
  issuedAt: issuedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
  images,
  sbomSha256: await sha256(sbomPath, "--sbom"),
  provenanceSha256: await sha256(provenancePath, "--provenance")
};
const manifest = {
  ...unsigned,
  signature: {
    issuer,
    keyId,
    value: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64")
  }
};
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o640 });
console.log(`PASS  deployment release manifest written: ${outputPath}`);
console.log(`PASS  release revision: ${releaseRevision}`);
console.log(`PASS  images: ${imageKeys.length}; SBOM: ${unsigned.sbomSha256}; provenance: ${unsigned.provenanceSha256}`);
