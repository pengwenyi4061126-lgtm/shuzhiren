import { writeFile } from "node:fs/promises";
import path from "node:path";
import { imageKeys } from "./verify-deployment-images.mjs";

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || options.has(key)) throw new Error("Usage: node scripts/write-release-image-result.mjs --key IMAGE_KEY --repository registry/repository --digest sha256:<64-hex> --revision <40-hex-git-sha> --output /absolute/result.json");
  options.set(key, value);
}
const required = (name) => {
  const value = options.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const key = required("--key");
const repository = required("--repository");
const digest = required("--digest");
const revision = required("--revision");
const output = required("--output");
if (!imageKeys.includes(key)) throw new Error("--key must be one of the ten deployment image keys");
const imageName = repository.slice(repository.lastIndexOf("/") + 1);
if (!repository.includes("/") || repository.includes("@") || imageName.includes(":")) throw new Error("--repository must be an untagged registry/repository name");
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("--digest must be sha256:<64 hexadecimal characters>");
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("--revision must be a full 40-character lowercase git SHA");
if (!path.isAbsolute(output)) throw new Error("--output must be an absolute path");
// schemaVersion 2: the result only names the pushed digest; its attestations are read from the registry when the
// release evidence is assembled (M21).
await writeFile(output, `${JSON.stringify({ schemaVersion: 2, key, image: `${repository}@${digest}`, revision })}\n`, { encoding: "utf8", flag: "wx", mode: 0o640 });
console.log(`PASS  release image result written: ${key}`);
