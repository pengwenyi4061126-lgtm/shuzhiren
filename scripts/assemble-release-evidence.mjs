import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assembleReleaseEvidence, ReleaseEvidenceError, releaseImagesFromResults } from "./lib/release-evidence.mjs";
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
const images = releaseImagesFromResults(results, imageKeys, revision);
// M21: the indexes used to assert constant "oci-buildx-attached" fields without reading anything from the
// registry. Every image's SBOM and provenance attestation is now read by digest from the registry and bound to
// its linux/amd64 image; nothing is written unless all ten succeed.
let evidence;
try {
  evidence = await assembleReleaseEvidence({
    images,
    revision,
    source,
    registry: process.env.RELEASE_REGISTRY || undefined,
    credentials: { username: process.env.REGISTRY_READ_USERNAME, password: process.env.REGISTRY_READ_PASSWORD }
  });
} catch (error) {
  if (!(error instanceof ReleaseEvidenceError)) throw error;
  console.error(error.message);
  process.exit(1);
}
const documents = [
  [imagesOutput, evidence.images],
  [sbomOutput, evidence.sbomIndex],
  [provenanceOutput, evidence.provenanceIndex]
];
const temporary = documents.map(([output]) => `${output}.${process.pid}.tmp`);
try {
  for (const [index, [, value]] of documents.entries()) await writeFile(temporary[index], `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o640 });
  for (const [index, [output]] of documents.entries()) await rename(temporary[index], output);
} catch (error) {
  await Promise.all([...temporary, ...documents.map(([output]) => output)].map((file) => rm(file, { force: true })));
  throw error;
}
console.log("PASS  release evidence indexes bind ten images to the SBOM and provenance attestations read from the registry");