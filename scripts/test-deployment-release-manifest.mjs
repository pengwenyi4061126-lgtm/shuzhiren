import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-release-manifest-"));
const script = path.join(root, "scripts", "create-deployment-release-manifest.mjs");
const keyPair = generateKeyPairSync("ed25519");
const images = Object.fromEntries([
  "CONTROL_PLANE_IMAGE", "CONTROL_PLANE_MIGRATOR_IMAGE", "RUNTIME_GATEWAY_IMAGE", "RUNTIME_WORKER_IMAGE", "RUNTIME_OBSERVER_IMAGE", "OUTPUT_PROBE_IMAGE", "CHANNEL_ADAPTER_IMAGE", "ALERT_NOTIFIER_IMAGE", "LIVETALKING_IMAGE", "COSYVOICE_IMAGE"
].map((key, index) => [key, `registry.internal/shuzhiren/${key.toLowerCase()}@sha256:${(index + 1).toString(16).repeat(64)}`]));
const imagesPath = path.join(fixture, "images.json");
const sbomPath = path.join(fixture, "release-sbom.json");
const provenancePath = path.join(fixture, "release-provenance.json");
const privateKeyPath = path.join(fixture, "release-private.pem");
const outputPath = path.join(fixture, "deployment-release-manifest.json");
await writeFile(imagesPath, JSON.stringify(images));
await writeFile(sbomPath, '{"schemaVersion":1,"images":10}\n');
await writeFile(provenancePath, '{"schemaVersion":1,"builder":"fixture"}\n');
await writeFile(privateKeyPath, keyPair.privateKey.export({ type: "pkcs8", format: "pem" }));

const args = [script, "--images", imagesPath, "--sbom", sbomPath, "--provenance", provenancePath, "--private-key", privateKeyPath, "--issuer", "release_issuer", "--key-id", "fixture-2026", "--revision", "a".repeat(40), "--output", outputPath, "--issued-at", "2026-11-04T00:00:00.000Z", "--expires-at", "2026-11-05T00:00:00.000Z"];
execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" });
const manifest = JSON.parse(await readFile(outputPath, "utf8"));
assert.equal(manifest.releaseRevision, "a".repeat(40));
assert.equal(Object.keys(manifest.images).length, 10);
const unsigned = { ...manifest };
delete unsigned.signature;
const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}` : JSON.stringify(value);
assert.equal(verify(null, Buffer.from(canonicalJson(unsigned)), keyPair.publicKey, Buffer.from(manifest.signature.value, "base64")), true);
const rejected = (candidateArgs, expected) => assert.throws(
  () => execFileSync(process.execPath, candidateArgs, { cwd: root, stdio: "pipe" }),
  (error) => {
    assert.match(String(error.stderr), expected);
    return true;
  }
);
rejected(args, /already exists/);
await writeFile(path.join(fixture, "duplicate-images.json"), JSON.stringify({ ...images, COSYVOICE_IMAGE: images.RUNTIME_GATEWAY_IMAGE }));
const duplicateArgs = [...args];
duplicateArgs[duplicateArgs.indexOf("--images") + 1] = path.join(fixture, "duplicate-images.json");
duplicateArgs[duplicateArgs.indexOf("--output") + 1] = path.join(fixture, "duplicate-manifest.json");
rejected(duplicateArgs, /must not reuse digest/);
// L6: the generator and Deploy_Check share the 30-day validity limit.
const validityArgs = (expiresAt, output) => {
  const candidate = [...args];
  candidate[candidate.indexOf("--expires-at") + 1] = expiresAt;
  candidate[candidate.indexOf("--output") + 1] = output;
  return candidate;
};
const issuedAtMs = Date.parse("2026-11-04T00:00:00.000Z");
const thirtyDayOutput = path.join(fixture, "thirty-day-manifest.json");
execFileSync(process.execPath, validityArgs(new Date(issuedAtMs + 30 * 24 * 60 * 60 * 1000).toISOString(), thirtyDayOutput), { cwd: root, stdio: "pipe" });
assert.equal(JSON.parse(await readFile(thirtyDayOutput, "utf8")).expiresAt, "2026-12-04T00:00:00.000Z", "a 30-day validity window must be accepted");
const overlongOutput = path.join(fixture, "overlong-manifest.json");
rejected(validityArgs(new Date(issuedAtMs + 30 * 24 * 60 * 60 * 1000 + 1).toISOString(), overlongOutput), /no more than 30 days/);
await assert.rejects(readFile(overlongOutput), { code: "ENOENT" }, "a rejected validity window must not write a manifest");
console.log("PASS  release manifest generator signs complete immutable image sets and rejects overwrite or digest reuse");
