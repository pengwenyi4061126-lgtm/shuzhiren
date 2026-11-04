import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageKeys } from "./verify-deployment-images.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-release-evidence-"));
const resultDirectory = path.join(fixture, "results");
const revision = "c".repeat(40);
await mkdir(resultDirectory);
for (const [index, key] of imageKeys.entries()) {
  execFileSync(process.execPath, [path.join(root, "scripts", "write-release-image-result.mjs"), "--key", key, "--repository", `registry.internal:5443/shuzhiren/${key.toLowerCase()}`, "--digest", `sha256:${(index + 1).toString(16).repeat(64)}`, "--revision", revision, "--output", path.join(resultDirectory, `${key}.json`)], { cwd: root, stdio: "pipe" });
}
const imagesOutput = path.join(fixture, "images.json");
const sbomOutput = path.join(fixture, "release-sbom-index.json");
const provenanceOutput = path.join(fixture, "release-provenance-index.json");
const args = [path.join(root, "scripts", "assemble-release-evidence.mjs"), "--input-dir", resultDirectory, "--revision", revision, "--source", "https://github.com/shuzizhibo/shuzizhibo", "--images-output", imagesOutput, "--sbom-output", sbomOutput, "--provenance-output", provenanceOutput];
execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" });
const images = JSON.parse(await readFile(imagesOutput, "utf8"));
const sbom = JSON.parse(await readFile(sbomOutput, "utf8"));
const provenance = JSON.parse(await readFile(provenanceOutput, "utf8"));
assert.deepEqual(Object.keys(images), imageKeys);
assert.equal(sbom.artifactType, "oci-buildx-sbom-index");
assert.equal(provenance.artifactType, "oci-buildx-provenance-index");
assert.equal(provenance.releaseRevision, revision);
await writeFile(path.join(resultDirectory, "duplicate.json"), JSON.stringify({ schemaVersion: 1, key: imageKeys[0], image: images[imageKeys[0]], revision, sbom: "oci-buildx-attached", provenance: "oci-buildx-attached" }));
assert.throws(() => execFileSync(process.execPath, [...args.slice(0, -6), "--images-output", path.join(fixture, "duplicate-images.json"), "--sbom-output", path.join(fixture, "duplicate-sbom.json"), "--provenance-output", path.join(fixture, "duplicate-provenance.json")], { cwd: root, stdio: "pipe" }), (error) => {
  assert.match(String(error.stderr), /exactly ten files/);
  return true;
});
console.log("PASS  release evidence assembly binds exactly ten Buildx-attested image results to one revision");
