import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("runtime acceptance scripts are present and read-only by default", async () => {
  const [compose, network, session] = await Promise.all([
    read("scripts/acceptance/runtime-compose.sh"),
    read("scripts/acceptance/runtime-network-isolation.sh"),
    read("scripts/acceptance/livetalking-session-zero.sh")
  ]);

  for (const source of [compose, network, session]) assert.match(source, /^#!\/usr\/bin\/env bash/m);
  assert.match(compose, /docker compose/);
  assert.match(compose, /com\.docker\.compose\.project/);
  assert.match(network, /\/healthz/);
  assert.match(network, /runtime-media/);
  assert.match(network, /livetalking-egress/);
  assert.match(network, /OUTPUT_PROBE_URL/);
  assert.match(network, /first active dynamic session/);
  assert.match(network, /LIVETALKING_BASE_URL/);
  assert.match(network, /discovered dynamic runtime session/);
  assert.match(network, /RUNTIME_ACCEPTANCE_RTMP_SINK_NAME/);
  assert.match(network, /ossrs\/srs:5/);
  assert.doesNotMatch(network, /session_id=\"\$\{RUNTIME_SESSION_ID:-0\}\"/);
  assert.match(network, /--network-only/);
  assert.doesNotMatch(network, /docker\s+(?:compose\s+)?(?:up|down|rm|network\s+connect|network\s+disconnect)\b/);
  assert.match(session, /\/api\/admin\/sessions/);
  assert.match(session, /RTCPeerConnection/);
  assert.match(session, /addTransceiver\("audio", direction="recvonly"\)/);
  assert.match(session, /addTransceiver\("video", direction="recvonly"\)/);
  assert.match(session, /dynamic session/i);
  assert.doesNotMatch(session, /session_id":"0"/);
  assert.match(session, /--execute/);
  assert.match(session, /start_program/);
  assert.match(session, /stop_program/);
  assert.match(session, /await asyncio\.sleep\(600\)/);
  assert.match(session, /RTMP output metrics/);
  assert.match(session, /output_connected/);
  assert.match(session, /output_fps/);
  assert.match(session, /last_output_at/);
  assert.match(session, /aigc_label/);
  assert.match(session, /frames_labelled/);
  assert.match(session, /ffprobe/);
  assert.match(session, /video stream/);
  assert.match(session, /audio stream/);
  assert.match(session, /finalized recording/);
  assert.doesNotMatch(session, /docker\s+(?:compose\s+)?(?:up|down|rm|network\s+connect|network\s+disconnect)\b/);
});

console.log("PASS  runtime acceptance script contracts are present and read-only by default");
