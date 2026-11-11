import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  isVerifiedStudioSamplePhoto,
  isVerifiedStudioSampleScript,
  isVerifiedStudioSampleVoice,
  readVerifiedStudioSampleMedia,
  verifiedStudioSample,
  verifiedStudioSamplePhoto,
  verifiedStudioSampleVoice
} from "../lib/verified-studio-sample.ts";

function checksum(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

test("4090 verified Studio sample media matches its frozen metadata", async () => {
  const [photo, voice] = await Promise.all([
    readVerifiedStudioSampleMedia("photo"),
    readVerifiedStudioSampleMedia("voice")
  ]);
  assert.equal(photo.byteLength, verifiedStudioSamplePhoto.bytes);
  assert.equal(checksum(photo), verifiedStudioSamplePhoto.checksum);
  assert.equal(voice.byteLength, verifiedStudioSampleVoice.bytes);
  assert.equal(checksum(voice), verifiedStudioSampleVoice.fileChecksum);
});

test("verified Studio sample guards the exact asset and script tuple", () => {
  assert.equal(isVerifiedStudioSamplePhoto({ id: verifiedStudioSamplePhoto.assetId, objectKey: verifiedStudioSamplePhoto.objectKey, checksum: verifiedStudioSamplePhoto.checksum.toUpperCase() }), true);
  assert.equal(isVerifiedStudioSampleVoice({ id: verifiedStudioSampleVoice.assetId, runtimeVoiceId: verifiedStudioSampleVoice.runtimeVoiceId, checksum: verifiedStudioSampleVoice.runtimeChecksum.toUpperCase() }), true);
  assert.equal(isVerifiedStudioSampleScript(` ${verifiedStudioSample.script} `), true);
  assert.equal(isVerifiedStudioSampleScript(`${verifiedStudioSample.script}（已改）`), false);
});
