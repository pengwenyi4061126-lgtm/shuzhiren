import { readFile } from "node:fs/promises";

const [assets, store, route, config] = await Promise.all([
  readFile(new URL("../apps/console/lib/assets.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/lib/control-plane/store.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/app/api/v1/live-runs/[runId]/speech-dispatches/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../config/control-plane.example.env", import.meta.url), "utf8")
]);
for (const expected of ["runtime_voice_id", "runtimeVoiceForRunInTransaction", "Frozen voice asset is not approved for runtime speech"]) {
  if (!assets.includes(expected)) throw new Error(`voice asset binding missing: ${expected}`);
}
if (!store.includes("await runtimeVoiceForRunInTransaction(client, run.revisionId)")) throw new Error("speech dispatch must derive voice from the frozen revision asset");
// H3: the Gateway synthesizes with CosyVoice only for the frozen voice and, for zero-shot models, its checksum.
if (!assets.includes("voiceChecksum: asset.checksum")) throw new Error("the frozen voice binding must carry the voice asset checksum");
if (!store.includes("voiceChecksum: voice.voiceChecksum")) throw new Error("program and speech commands must carry the frozen voice checksum");
if (route.includes("configuredSpeechVoice") || config.includes("RUNTIME_SPEECH_VOICE")) throw new Error("speech dispatch must not use a global runtime voice setting");
console.log("PASS  runtime speech voice is bound to the frozen approved voice asset");
