import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageKeys } from "./verify-deployment-images.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-release-evidence-"));
const revision = "c".repeat(40);
const source = "https://github.com/shuzizhibo/shuzizhibo";
const exists = (file) => access(file).then(() => true, () => false);
try {
  // M21: the assembler wrote SBOM and provenance indexes from constant "oci-buildx-attached" fields without
  // reading anything from the registry. With a registry that cannot be reached it must now fail for every image
  // and write no evidence file.
  const resultDirectory = path.join(fixture, "results");
  await mkdir(resultDirectory);
  for (const [index, key] of imageKeys.entries()) {
    execFileSync(process.execPath, [path.join(root, "scripts", "write-release-image-result.mjs"), "--key", key, "--repository", `127.0.0.1:9/shuzhiren/${key.toLowerCase().replaceAll("_", "-")}`, "--digest", `sha256:${(index + 1).toString(16).repeat(64)}`, "--revision", revision, "--output", path.join(resultDirectory, `${key}.json`)], { cwd: root, stdio: "pipe" });
  }
  const written = JSON.parse(await readFile(path.join(resultDirectory, `${imageKeys[0]}.json`), "utf8"));
  assert.deepEqual(Object.keys(written).sort(), ["image", "key", "revision", "schemaVersion"], "a build result names only the pushed digest, not attestation claims");
  const outputs = { images: path.join(fixture, "images.json"), sbom: path.join(fixture, "release-sbom-index.json"), provenance: path.join(fixture, "release-provenance-index.json") };
  const args = (directory, out) => [path.join(root, "scripts", "assemble-release-evidence.mjs"), "--input-dir", directory, "--revision", revision, "--source", source, "--images-output", out.images, "--sbom-output", out.sbom, "--provenance-output", out.provenance];
  const env = { ...process.env };
  for (const name of ["RELEASE_REGISTRY", "REGISTRY_READ_USERNAME", "REGISTRY_READ_PASSWORD"]) delete env[name];
  const unreachable = spawnSync(process.execPath, args(resultDirectory, outputs), { cwd: root, env, encoding: "utf8" });
  assert.notEqual(unreachable.status, 0, "release evidence must not be assembled without reading the attestations from the registry");
  for (const key of imageKeys) assert.match(unreachable.stderr, new RegExp(`^ERROR  ${key} registry_request_failed`, "m"), `the failure of ${key} must be listed`);
  for (const file of Object.values(outputs)) assert.equal(await exists(file), false, `${path.basename(file)} must not be written when an image's attestations cannot be read`);

  await writeFile(path.join(resultDirectory, "duplicate.json"), JSON.stringify(written));
  const duplicate = spawnSync(process.execPath, args(resultDirectory, outputs), { cwd: root, env, encoding: "utf8" });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /exactly ten files/);
  await rm(path.join(resultDirectory, "duplicate.json"));

  await assertRegistryAttestationsAreVerified();
  console.log("PASS  release evidence assembly reads each image's SBOM and provenance attestation from the registry and binds it to the linux/amd64 digest (M21)");
} finally {
  await rm(fixture, { recursive: true, force: true });
}

async function assertRegistryAttestationsAreVerified() {
  const { assembleReleaseEvidence, ReleaseEvidenceError } = await import("./lib/release-evidence.mjs");
  const host = "registry.internal:5443";
  const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const json = (value) => Buffer.from(JSON.stringify(value));

  // Builds a Buildx-shaped image index per key; `mutate(key, parts)` can damage one image's parts.
  function registry(mutate = () => undefined, { requireToken = false } = {}) {
    const objects = new Map();
    const requests = [];
    const put = (repository, kind, bytes, contentType) => { const digest = sha(bytes); objects.set(`/v2/${repository}/${kind}/${digest}`, { bytes, contentType }); return digest; };
    const images = {};
    for (const key of imageKeys) {
      const repository = `shuzhiren/${key.toLowerCase().replaceAll("_", "-")}`;
      const platform = put(repository, "manifests", json({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", layers: [], key }), "application/vnd.oci.image.manifest.v1+json");
      const parts = {
        sbomStatement: { _type: "https://in-toto.io/Statement/v0.1", predicateType: "https://spdx.dev/Document", subject: [{ name: repository, digest: { sha256: platform.slice(7) } }], predicate: { spdxVersion: "SPDX-2.3" } },
        provenanceStatement: { _type: "https://in-toto.io/Statement/v0.1", predicateType: "https://slsa.dev/provenance/v0.2", subject: [{ name: repository, digest: { sha256: platform.slice(7) } }], predicate: { builder: { id: "buildx" } } },
        sbomPredicate: "https://spdx.dev/Document",
        provenancePredicate: "https://slsa.dev/provenance/v0.2",
        tamperBlob: false,
        indexMediaType: "application/vnd.oci.image.index.v1+json",
        attestationReference: platform
      };
      mutate(key, parts);
      const sbomBytes = json(parts.sbomStatement);
      const provenanceBytes = json(parts.provenanceStatement);
      const sbomDigest = put(repository, "blobs", sbomBytes, "application/vnd.in-toto+json");
      const provenanceDigest = put(repository, "blobs", provenanceBytes, "application/vnd.in-toto+json");
      if (parts.tamperBlob) objects.get(`/v2/${repository}/blobs/${sbomDigest}`).bytes = Buffer.concat([sbomBytes, Buffer.from(" ")]);
      const layers = [];
      if (parts.sbomPredicate) layers.push({ mediaType: "application/vnd.in-toto+json", digest: sbomDigest, size: sbomBytes.length, annotations: { "in-toto.io/predicate-type": parts.sbomPredicate } });
      if (parts.provenancePredicate) layers.push({ mediaType: "application/vnd.in-toto+json", digest: provenanceDigest, size: provenanceBytes.length, annotations: { "in-toto.io/predicate-type": parts.provenancePredicate } });
      const attestation = put(repository, "manifests", json({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", layers }), "application/vnd.oci.image.manifest.v1+json");
      const manifests = [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: platform, platform: { os: "linux", architecture: "amd64" } }];
      if (parts.attestationReference) manifests.push({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: attestation, platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": parts.attestationReference } });
      const index = put(repository, "manifests", json({ schemaVersion: 2, mediaType: parts.indexMediaType, manifests }), parts.indexMediaType);
      images[key] = `${host}/${repository}@${index}`;
    }
    const fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({ url: url.toString(), authorization: init.headers?.authorization });
      if (url.pathname === "/token") {
        assert.equal(init.headers?.authorization, `Basic ${Buffer.from("reader:read-secret").toString("base64")}`, "the read credentials go to the registry's own token endpoint");
        return new Response(JSON.stringify({ token: "pull-token" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requireToken && init.headers?.authorization !== "Bearer pull-token") return new Response("", { status: 401, headers: { "www-authenticate": `Bearer realm="https://${host}/token",service="${host}",scope="repository:x:pull"` } });
      const object = objects.get(url.pathname);
      if (!object) return new Response("", { status: 404 });
      return new Response(object.bytes, { status: 200, headers: { "content-type": object.contentType } });
    };
    return { images, fetch, requests };
  }
  const assemble = (setup, options = {}) => assembleReleaseEvidence({ images: setup.images, revision, source, fetch: setup.fetch, ...options });
  const failuresOf = async (setup, options) => {
    try { await assemble(setup, options); } catch (error) { assert.ok(error instanceof ReleaseEvidenceError, String(error)); return error.failures; }
    assert.fail("release evidence must be rejected");
  };

  const healthy = registry(undefined, { requireToken: true });
  const evidence = await assemble(healthy, { registry: host, credentials: { username: "reader", password: "read-secret" } });
  assert.equal(evidence.sbomIndex.schemaVersion, 2);
  assert.equal(evidence.sbomIndex.artifactType, "oci-buildx-sbom-index");
  assert.equal(evidence.provenanceIndex.builder, "github-actions-buildx");
  assert.equal("attestationTransport" in evidence.sbomIndex, false);
  assert.deepEqual(Object.keys(evidence.sbomIndex.attestations), imageKeys);
  for (const key of imageKeys) {
    for (const [index, predicate] of [[evidence.sbomIndex, "https://spdx.dev/Document"], [evidence.provenanceIndex, "https://slsa.dev/provenance/v0.2"]]) {
      const entry = index.attestations[key];
      assert.equal(entry.platform, "linux/amd64");
      assert.equal(entry.predicateType, predicate);
      for (const field of ["platformManifestDigest", "attestationManifestDigest", "digest"]) assert.match(entry[field], /^sha256:[a-f0-9]{64}$/);
    }
  }
  assert.ok(healthy.requests.every((request) => new URL(request.url).host === host), "only the trusted registry is contacted");

  const cases = [
    ["missing attestation manifest", (key, parts) => { if (key === imageKeys[1]) parts.attestationReference = null; }, "attestation_manifest_not_unique"],
    ["attestation for another image", (key, parts) => { if (key === imageKeys[1]) parts.attestationReference = `sha256:${"0".repeat(64)}`; }, "attestation_manifest_not_unique"],
    ["no SBOM", (key, parts) => { if (key === imageKeys[1]) parts.sbomPredicate = null; }, "sbom_layer_not_unique"],
    ["no provenance", (key, parts) => { if (key === imageKeys[1]) parts.provenancePredicate = null; }, "provenance_layer_not_unique"],
    ["subject of another image", (key, parts) => { if (key === imageKeys[1]) parts.sbomStatement.subject = [{ name: "other", digest: { sha256: "f".repeat(64) } }]; }, "subject_mismatch"],
    ["statement type differs from layer", (key, parts) => { if (key === imageKeys[1]) parts.provenanceStatement.predicateType = "https://slsa.dev/provenance/v1"; }, "predicate_type_mismatch"],
    ["tampered blob", (key, parts) => { if (key === imageKeys[1]) parts.tamperBlob = true; }, "digest_mismatch"],
    ["not an index", (key, parts) => { if (key === imageKeys[1]) parts.indexMediaType = "application/vnd.oci.image.manifest.v1+json"; }, "not_an_image_index"]
  ];
  for (const [label, mutate, reason] of cases) {
    const failures = await failuresOf(registry(mutate));
    assert.deepEqual(failures.map((failure) => failure.key), [imageKeys[1]], `${label}: only the damaged image fails`);
    assert.match(failures[0].reason, new RegExp(`^${reason}`), `${label}: reason`);
  }
  const twoBroken = await failuresOf(registry((key, parts) => { if (key === imageKeys[2] || key === imageKeys[7]) parts.sbomPredicate = null; }));
  assert.deepEqual(twoBroken.map((failure) => failure.key), [imageKeys[2], imageKeys[7]], "every failed image is listed");

  const elsewhere = registry();
  elsewhere.images[imageKeys[3]] = elsewhere.images[imageKeys[3]].replace(host, "attacker.example");
  const untrusted = await failuresOf(elsewhere, { registry: host, credentials: { username: "reader", password: "read-secret" } });
  assert.deepEqual(untrusted.map((failure) => [failure.key, failure.reason]), [[imageKeys[3], "registry_not_trusted: attacker.example"]]);
  assert.ok(elsewhere.requests.every((request) => new URL(request.url).host === host), "an untrusted registry is never contacted");
}
