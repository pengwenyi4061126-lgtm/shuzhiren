#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/runtime-compose.sh"

execute_start=false
stop_after=false
usage() {
  cat <<'EOF'
Usage: bash scripts/acceptance/livetalking-session-zero.sh [--execute] [--stop-after]

Checks the LiveTalking dynamic-session contract. The RTMP deployment creates the
project session from a WebRTC offer; it no longer exposes a fixed session ID
"0". The default mode only reads the currently exposed sessions. --execute
creates one synthetic WebRTC offer inside the LiveTalking container, starts the
program through Runtime Gateway using the returned session ID, and optionally
stops it with --stop-after.

Required with --execute:
  RUNTIME_GATEWAY_URL     Gateway URL (default http://127.0.0.1:8090)
  RUNTIME_SHARED_TOKEN    command-scope Gateway token

Optional Compose variables are shared with runtime-network-isolation.sh:
  RUNTIME_REPO_ROOT, RUNTIME_COMPOSE_FILE, RUNTIME_COMPOSE_PROJECT,
  RUNTIME_COMPOSE_ENV_FILES, EVIDENCE_FILE
EOF
}

while (($#)); do
  case "$1" in
    --execute) execute_start=true ;;
    --stop-after) stop_after=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'ERROR  unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done
if "$stop_after" && ! "$execute_start"; then
  printf 'ERROR  --stop-after requires --execute\n' >&2
  exit 1
fi

runtime_acceptance_init_compose
gateway_container="$(runtime_acceptance_container runtime-gateway)"
livetalking_container="$(runtime_acceptance_container livetalking)"
sessions_file="$(mktemp)"
offer_file=""
offer_error_file=""
offer_pid=""
start_file=""
stop_file=""
metrics_file=""
recordings_before_file=""
recordings_after_file=""
recording_probe_file=""
recording_path=""
helper_pid_file=""
offer_helper_stopped=false

cleanup_offer_helper() {
  if "$offer_helper_stopped"; then
    return 0
  fi
  offer_helper_stopped=true

  # The Python WebRTC helper is a child process inside the LiveTalking
  # container. Killing the host-side `docker exec` client alone does not
  # necessarily close the PeerConnection, so terminate the recorded
  # container PID first. Every docker operation is bounded: cleanup must not
  # turn a failed acceptance run into another hung run.
  if [[ -n "$helper_pid_file" ]]; then
    helper_container_pid="$(timeout 5s docker exec "$livetalking_container" sh -c 'cat "$1" 2>/dev/null || true' sh "$helper_pid_file" 2>/dev/null || true)"
    if [[ "$helper_container_pid" =~ ^[0-9]+$ ]]; then
      timeout 5s docker exec "$livetalking_container" kill -TERM "$helper_container_pid" >/dev/null 2>&1 || true
      for _ in $(seq 1 40); do
        if ! timeout 3s docker exec "$livetalking_container" kill -0 "$helper_container_pid" >/dev/null 2>&1; then
          break
        fi
        sleep 0.25
      done
      if timeout 3s docker exec "$livetalking_container" kill -0 "$helper_container_pid" >/dev/null 2>&1; then
        timeout 5s docker exec "$livetalking_container" kill -KILL "$helper_container_pid" >/dev/null 2>&1 || true
      fi
    fi
    timeout 5s docker exec "$livetalking_container" rm -f -- "$helper_pid_file" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  cleanup_offer_helper
  if [[ -n "$offer_pid" ]]; then
    kill "$offer_pid" 2>/dev/null || true
    wait "$offer_pid" 2>/dev/null || true
  fi
  rm -f -- "$sessions_file"
  [[ -z "$offer_file" ]] || rm -f -- "$offer_file"
  [[ -z "$offer_error_file" ]] || rm -f -- "$offer_error_file"
  [[ -z "$start_file" ]] || rm -f -- "$start_file"
  [[ -z "$stop_file" ]] || rm -f -- "$stop_file"
  [[ -z "$metrics_file" ]] || rm -f -- "$metrics_file"
  [[ -z "$recordings_before_file" ]] || rm -f -- "$recordings_before_file"
  [[ -z "$recordings_after_file" ]] || rm -f -- "$recordings_after_file"
  [[ -z "$recording_probe_file" ]] || rm -f -- "$recording_probe_file"
}
trap cleanup EXIT

if "$execute_start"; then
  recordings_before_file="$(mktemp)"
  docker exec "$livetalking_container" python3 -c '
import json
from pathlib import Path

root = Path("/app/data/record")
items = []
if root.exists():
    for path in sorted(root.glob("*.mp4")):
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        items.append({"path": str(path), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns})
print(json.dumps(items, ensure_ascii=False, separators=(",", ":")))
' > "$recordings_before_file"
  offer_file="$(mktemp)"
  offer_error_file="$(mktemp)"
  helper_pid_file="/tmp/shuziren-acceptance-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}.pid"
  # Generate a real offer with audio/video receive transceivers. LiveTalking's
  # /offer route creates the Avatar session and returns its dynamic session ID.
  # Keep the RTCPeerConnection alive until start/stop have completed. If this
  # helper exits immediately, LiveTalking correctly removes the session and
  # the RTMP acceptance test observes a false 502 at end_record.
  docker exec -e "SHUZIREN_ACCEPTANCE_PID_FILE=$helper_pid_file" "$livetalking_container" python3 -c '
import asyncio
import json
import os
import urllib.request
from pathlib import Path
from aiortc import RTCPeerConnection, RTCSessionDescription

async def main():
    pid_file = Path(os.environ["SHUZIREN_ACCEPTANCE_PID_FILE"])
    pid_file.write_text(str(os.getpid()), encoding="ascii")
    pc = None
    connected = asyncio.Event()

    try:
        pc = RTCPeerConnection()

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if pc.connectionState == "connected":
                connected.set()
            elif pc.connectionState in ("failed", "closed"):
                connected.set()

        pc.addTransceiver("audio", direction="recvonly")
        pc.addTransceiver("video", direction="recvonly")
        await pc.setLocalDescription(await pc.createOffer())
        body = json.dumps({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}).encode()
        request = urllib.request.Request(
            "http://127.0.0.1:8010/offer",
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=payload["sdp"], type=payload["type"])
        )
        await asyncio.wait_for(connected.wait(), timeout=30)
        if pc.connectionState != "connected":
            raise RuntimeError(f"WebRTC connection state is {pc.connectionState}")
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)
        await asyncio.sleep(600)
    finally:
        if pc is not None:
            await pc.close()
        try:
            pid_file.unlink()
        except FileNotFoundError:
            pass

asyncio.run(main())
' > "$offer_file" 2> "$offer_error_file" &
  offer_pid="$!"

  offer_ready=false
  for _ in $(seq 1 60); do
    if [[ -s "$offer_file" ]]; then
      offer_ready=true
      break
    fi
    if ! kill -0 "$offer_pid" 2>/dev/null; then
      wait "$offer_pid" 2>/dev/null || true
      printf 'ERROR  LiveTalking WebRTC helper exited before returning an offer\n' >&2
      [[ ! -s "$offer_error_file" ]] || cat "$offer_error_file" >&2
      exit 1
    fi
    sleep 0.5
  done
  if ! "$offer_ready"; then
    printf 'ERROR  Timed out waiting for LiveTalking WebRTC offer\n' >&2
    [[ ! -s "$offer_error_file" ]] || cat "$offer_error_file" >&2
    exit 1
  fi

  session_id="$(python3 - "$offer_file" <<'PY'
import json
import re
import sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError) as exc:
    raise SystemExit(f"ERROR  LiveTalking offer response is invalid: {type(exc).__name__}")
if not isinstance(body, dict) or body.get("type") != "answer" or not isinstance(body.get("sdp"), str):
    raise SystemExit("ERROR  LiveTalking offer response did not contain an SDP answer")
session_id = body.get("sessionid")
if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", session_id):
    raise SystemExit("ERROR  LiveTalking offer response did not contain a valid dynamic session ID")
print(session_id)
PY
  )"
  printf 'PASS   WebRTC offer created dynamic LiveTalking session: %s\n' "$session_id"
else
  session_id=""
fi

docker exec "$gateway_container" python3 -c '
import json
import os
import urllib.request

base = os.environ["LIVETALKING_BASE_URL"].rstrip("/")
with urllib.request.urlopen(base + "/api/admin/sessions", timeout=5) as response:
    payload = json.load(response)
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
' > "$sessions_file"
python3 - "$sessions_file" "$session_id" "$execute_start" <<'PY'
import json
import re
import sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError) as exc:
    raise SystemExit(f"ERROR  LiveTalking sessions response is invalid: {type(exc).__name__}")
sessions = body.get("data", {}).get("sessions") if isinstance(body.get("data"), dict) else None
if body.get("code") != 0 or not isinstance(sessions, list):
    raise SystemExit("ERROR  LiveTalking sessions endpoint did not return a successful session list")
requested = sys.argv[2]
executing = sys.argv[3] == "true"
valid = [item for item in sessions if isinstance(item, dict) and isinstance(item.get("sessionid"), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", item["sessionid"])]
if executing:
    if not requested or not any(item.get("sessionid") == requested for item in valid):
        raise SystemExit("ERROR  WebRTC-created session was not present in LiveTalking session list")
    print(f'PASS   LiveTalking exposes the created dynamic session "{requested}"')
elif not valid:
    raise SystemExit('ERROR  LiveTalking has no active dynamic session; rerun with --execute to create one')
else:
    print(f"PASS   LiveTalking exposes {len(valid)} dynamic session(s)")
PY

if ! "$execute_start"; then
  printf 'PASS   dynamic-session acceptance completed in read-only mode\n'
  exit 0
fi

gateway_url="${RUNTIME_GATEWAY_URL:-http://127.0.0.1:8090}"
shared_token="${RUNTIME_SHARED_TOKEN:-}"
[[ -n "$shared_token" ]] || { printf 'ERROR  RUNTIME_SHARED_TOKEN is required with --execute\n' >&2; exit 1; }
command_id="acceptance_dynamic_session_$(date -u +%Y%m%dT%H%M%SZ)_$$"
request_body="$(python3 - "$command_id" "$session_id" <<'PY'
import json
import sys
print(json.dumps({"command_id": sys.argv[1], "session_id": sys.argv[2], "action": "start_program"}, separators=(",", ":")))
PY
)"
start_file="$(mktemp)"
curl_config="$(mktemp)"
printf 'header = "Authorization: Bearer %s"\n' "$shared_token" > "$curl_config"
chmod 600 -- "$curl_config"
start_status="$(curl --silent --show-error --max-time 30 --config "$curl_config" --output "$start_file" --write-out '%{http_code}' \
  -H 'content-type: application/json' --data "$request_body" "$gateway_url/v1/media")" || {
  rm -f -- "$curl_config"
  printf 'ERROR  Runtime Gateway start_program request failed\n' >&2
  exit 1
}
rm -f -- "$curl_config"
[[ "$start_status" == "200" ]] || {
  printf 'ERROR  Runtime Gateway start_program returned HTTP %s\n' "$start_status" >&2
  exit 1
}
python3 - "$start_file" "$command_id" "$session_id" <<'PY'
import json
import sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError) as exc:
    raise SystemExit(f"ERROR  start_program returned invalid JSON: {type(exc).__name__}")
command_id, session_id = sys.argv[2:]
receipt = body.get("receipt", {})
if body.get("accepted") is not True or body.get("command_id") != command_id or body.get("session_id") != session_id:
    raise SystemExit("ERROR  start_program was not accepted for the created dynamic session")
if receipt.get("command_id") != command_id or receipt.get("session_id") != session_id or receipt.get("action") != "start_program":
    raise SystemExit("ERROR  start_program receipt did not preserve the dynamic session ID")
print(f'PASS   start_program accepted and receipt preserved session ID "{session_id}"')
PY

metrics_file="$(mktemp)"
metrics_ready=false
printf 'WAIT   waiting for RTMP output metrics (up to 30s)\n'
for _ in $(seq 1 30); do
  if docker exec "$gateway_container" python3 -c '
import json
import os
import urllib.request

base = os.environ["LIVETALKING_BASE_URL"].rstrip("/")
with urllib.request.urlopen(base + "/api/admin/runtime-metrics", timeout=5) as response:
    print(response.read().decode("utf-8"))
' > "$metrics_file" 2>/dev/null; then
    if python3 - "$metrics_file" "$session_id" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
sessions = body.get("data", {}).get("sessions") if isinstance(body.get("data"), dict) else None
if body.get("code") != 0 or not isinstance(sessions, list):
    raise SystemExit(1)
session = next((item for item in sessions if isinstance(item, dict) and item.get("sessionid") == sys.argv[2]), None)
metrics = session.get("metrics") if isinstance(session, dict) and isinstance(session.get("metrics"), dict) else {}
output_fps = metrics.get("output_fps")
if metrics.get("output_connected") is not True or not isinstance(output_fps, (int, float)) or output_fps <= 0 or metrics.get("last_output_at") is None:
    raise SystemExit(1)
aigc = body.get("data", {}).get("aigc_label") if isinstance(body.get("data"), dict) else None
if not isinstance(aigc, dict) or aigc.get("enabled") is not True or not isinstance(aigc.get("text"), str) or not aigc.get("text") or not isinstance(aigc.get("frames_labelled"), int) or aigc.get("frames_labelled") <= 0 or aigc.get("frames_dropped") != 0 or aigc.get("last_error") is not None:
    raise SystemExit(1)
print(f"PASS   RTMP output connected=true output_fps={output_fps} last_output_at={metrics['last_output_at']}")
print(f"PASS   AIGC label enabled=true text={aigc['text']!r} frames_labelled={aigc['frames_labelled']} frames_dropped={aigc['frames_dropped']}")
PY
    then
      metrics_ready=true
      break
    fi
  fi
  sleep 1
done
if ! "$metrics_ready"; then
  printf 'ERROR  RTMP output metrics did not reach connected/fps state for session "%s"\n' "$session_id" >&2
  [[ ! -s "$metrics_file" ]] || cat "$metrics_file" >&2
  exit 1
fi

if "$stop_after"; then
  stop_id="acceptance_dynamic_session_stop_$(date -u +%Y%m%dT%H%M%SZ)_$$"
  stop_body="$(python3 - "$stop_id" "$session_id" <<'PY'
import json
import sys
print(json.dumps({"command_id": sys.argv[1], "session_id": sys.argv[2], "action": "stop_program"}, separators=(",", ":")))
PY
)"
  stop_file="$(mktemp)"
  curl_config="$(mktemp)"
  printf 'header = "Authorization: Bearer %s"\n' "$shared_token" > "$curl_config"
  chmod 600 -- "$curl_config"
  stop_status="$(curl --silent --show-error --max-time 30 --config "$curl_config" --output "$stop_file" --write-out '%{http_code}' \
    -H 'content-type: application/json' --data "$stop_body" "$gateway_url/v1/media")" || {
    rm -f -- "$curl_config"
    printf 'ERROR  Runtime Gateway stop_program request failed\n' >&2
    exit 1
  }
  rm -f -- "$curl_config"
  [[ "$stop_status" == "200" ]] || {
    printf 'ERROR  Runtime Gateway stop_program returned HTTP %s\n' "$stop_status" >&2
    exit 1
  }
  python3 - "$stop_file" "$stop_id" "$session_id" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
if body.get("accepted") is not True or body.get("command_id") != sys.argv[2] or body.get("session_id") != sys.argv[3]:
    raise SystemExit("ERROR  stop_program receipt did not preserve the dynamic session ID")
print(f'PASS   stop_program accepted and receipt preserved session ID "{sys.argv[3]}"')
PY

  recordings_after_file="$(mktemp)"
  recording_ready=false
  printf 'WAIT   waiting for finalized recording (up to 30s)\n'
  for _ in $(seq 1 30); do
    if docker exec "$livetalking_container" python3 -c '
import json
from pathlib import Path

root = Path("/app/data/record")
items = []
if root.exists():
    for path in sorted(root.glob("*.mp4")):
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        items.append({"path": str(path), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns})
print(json.dumps(items, ensure_ascii=False, separators=(",", ":")))
' > "$recordings_after_file" 2>/dev/null; then
      recording_path="$(python3 - "$recordings_before_file" "$recordings_after_file" <<'PY'
import json
import sys

before = {item.get("path") for item in json.load(open(sys.argv[1], encoding="utf-8")) if isinstance(item, dict)}
after = [
    item for item in json.load(open(sys.argv[2], encoding="utf-8"))
    if isinstance(item, dict)
    and isinstance(item.get("path"), str)
    and item.get("path") not in before
    and int(item.get("size", 0)) > 0
]
if after:
    print(max(after, key=lambda item: (int(item.get("mtime_ns", 0)), int(item.get("size", 0))))["path"])
PY
      )"
      if [[ -n "$recording_path" ]]; then
        recording_ready=true
        break
      fi
    fi
    sleep 1
  done
  if ! "$recording_ready"; then
    printf 'ERROR  stop_program completed but no new MP4 recording appeared\n' >&2
    exit 1
  fi

  recording_probe_file="$(mktemp)"
  docker exec "$livetalking_container" ffprobe -v error \
    -show_entries stream=codec_type,codec_name,width,height,sample_rate,channels \
    -show_entries format=duration,size \
    -of json "$recording_path" > "$recording_probe_file" || {
      printf 'ERROR  finalized recording could not be inspected with ffprobe: %s\n' "$recording_path" >&2
      exit 1
    }
  python3 - "$recording_probe_file" "$recording_path" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
streams = body.get("streams") if isinstance(body.get("streams"), list) else []
video = next((item for item in streams if isinstance(item, dict) and item.get("codec_type") == "video"), None)
audio = next((item for item in streams if isinstance(item, dict) and item.get("codec_type") == "audio"), None)
duration = float((body.get("format") or {}).get("duration") or 0)
if not video or not audio or duration <= 0:
    raise SystemExit("ERROR  recording must contain a video stream, an audio stream, and a positive duration")
print(f"PASS   recording ffprobe verified path={sys.argv[2]} video={video.get('codec_name')} {video.get('width')}x{video.get('height')} audio={audio.get('codec_name')} duration={duration:.3f}s")
PY

  cleanup_offer_helper
  session_cleanup_ready=false
  printf 'WAIT   waiting for LiveTalking session cleanup (up to 30s)\n'
  for _ in $(seq 1 30); do
    if docker exec "$gateway_container" python3 -c '
import json
import os
import urllib.request

base = os.environ["LIVETALKING_BASE_URL"].rstrip("/")
with urllib.request.urlopen(base + "/api/admin/sessions", timeout=5) as response:
    payload = json.load(response)
sessions = payload.get("data", {}).get("sessions") if isinstance(payload.get("data"), dict) else None
if payload.get("code") != 0 or not isinstance(sessions, list) or sessions:
    raise SystemExit(1)
' >/dev/null 2>&1; then
      session_cleanup_ready=true
      break
    fi
    sleep 1
  done
  if ! "$session_cleanup_ready"; then
    printf 'ERROR  LiveTalking session was not removed after WebRTC helper cleanup\n' >&2
    exit 1
  fi
  printf 'PASS   LiveTalking session list is empty after helper cleanup\n'
fi

if [[ -n "${EVIDENCE_FILE:-}" ]]; then
  evidence_dir="$(dirname -- "$EVIDENCE_FILE")"
  mkdir -p -- "$evidence_dir"
  evidence_tmp="${EVIDENCE_FILE}.tmp.$$"
  python3 - "$sessions_file" "$offer_file" "$start_file" "${stop_file:-}" "$metrics_file" "$recording_path" "$recording_probe_file" "$session_id" > "$evidence_tmp" <<'PY'
import json
import sys
from datetime import datetime, timezone

result = {
    "schema": "livetalking-dynamic-session-v2",
    "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "sessionId": sys.argv[8] or None,
    "sessions": json.load(open(sys.argv[1], encoding="utf-8")),
}
if sys.argv[2]:
    result["offer"] = json.load(open(sys.argv[2], encoding="utf-8"))
if sys.argv[3]:
    result["startProgram"] = json.load(open(sys.argv[3], encoding="utf-8"))
if sys.argv[4]:
    result["stopProgram"] = json.load(open(sys.argv[4], encoding="utf-8"))
if sys.argv[5]:
    result["runtimeMetrics"] = json.load(open(sys.argv[5], encoding="utf-8"))
if sys.argv[6] and sys.argv[7]:
    result["recording"] = {"path": sys.argv[6], "ffprobe": json.load(open(sys.argv[7], encoding="utf-8"))}
json.dump(result, sys.stdout, ensure_ascii=False, sort_keys=True, indent=2)
sys.stdout.write("\n")
PY
  chmod 600 -- "$evidence_tmp"
  mv -- "$evidence_tmp" "$EVIDENCE_FILE"
  printf 'PASS   dynamic-session evidence written: %s\n' "$EVIDENCE_FILE"
fi
printf 'PASS   LiveTalking dynamic-session acceptance completed\n'
