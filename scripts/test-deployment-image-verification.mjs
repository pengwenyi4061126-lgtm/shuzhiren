import assert from "node:assert/strict";
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
