import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageKeys } from "./verify-deployment-images.mjs";

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || options.has(key)) throw new Error("Usage: node scripts/assemble-release-evidence.mjs --input-dir /absolute/results --revision <40-hex-git-sha> --source https://github.com/owner/repository --sbom-output /absolute/release-sbom-index.json --provenance-output /absolute/release-provenance-index.json --images-output /absolute/images.json");
  options.set(key, value);
}
const required = (name) => {
  const value = options.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const inputDir = required("--input-dir");
const revision = required("--revision");
const source = required("--source");
const sbomOutput = required("--sbom-output");
const provenanceOutput = required("--provenance-output");
const imagesOutput = required("--images-output");
for (const [name, value] of [["--input-dir", inputDir], ["--sbom-output", sbomOutput], ["--provenance-output", provenanceOutput], ["--images-output", imagesOutput]]) if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("--revision must be a full 40-character lowercase git SHA");
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) throw new Error("--source must be the HTTPS GitHub repository URL without credentials");
const outputs = [sbomOutput, provenanceOutput, imagesOutput];
if (new Set(outputs).size !== outputs.length) throw new Error("release evidence output paths must be distinct");
const files = (await readdir(inputDir)).filter((file) => file.endsWith(".json"));
const results = [];
for (const file of files) results.push(JSON.parse(await readFile(path.join(inputDir, file), "utf8")));
if (results.length !== imageKeys.length) throw new Error("release image results must contain exactly ten files");
const byKey = new Map();
for (const result of results) {
  if (!result || result.schemaVersion !== 1 || !imageKeys.includes(result.key) || typeof result.image !== "string" || result.revision !== revision || result.sbom !== "oci-buildx-attached" || result.provenance !== "oci-buildx-attached") throw new Error("release image result is invalid or was built from a different revision");
  if (byKey.has(result.key)) throw new Error(`duplicate release image result: ${result.key}`);
  byKey.set(result.key, result.image);
}
if (imageKeys.some((key) => !byKey.has(key))) throw new Error("release image results are missing a required service");
const images = Object.fromEntries(imageKeys.map((key) => [key, byKey.get(key)]));
const index = { schemaVersion: 1, releaseRevision: revision, source, images, attestationTransport: "oci-buildx-attached" };
await Promise.all([
  writeFile(imagesOutput, `${JSON.stringify(images, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o640 }),
  writeFile(sbomOutput, `${JSON.stringify({ ...index, artifactType: "oci-buildx-sbom-index" }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o640 }),
  writeFile(provenanceOutput, `${JSON.stringify({ ...index, artifactType: "oci-buildx-provenance-index", builder: "github-actions-buildx" }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o640 })
]);
console.log("PASS  release evidence indexes bind ten Buildx-attested image digests to one revision");
