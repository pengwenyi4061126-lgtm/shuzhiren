#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/runtime-compose.sh"

execute_start=false
stop_after=false
usage() {
  cat <<'EOF'
Usage: bash scripts/acceptance/livetalking-session-zero.sh [--execute] [--stop-after]

Checks the RTMP single-session contract and, with --execute, sends one
start_program command through Runtime Gateway using the exact string session ID
"0". The default mode is read-only. --stop-after sends a separate stop_program
command after the start receipt is accepted.

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
sessions_file="$(mktemp)"
start_file=""
stop_file=""
cleanup() {
  rm -f -- "$sessions_file"
  [[ -z "$start_file" ]] || rm -f -- "$start_file"
  [[ -z "$stop_file" ]] || rm -f -- "$stop_file"
}
trap cleanup EXIT

docker exec "$gateway_container" python3 -c '
import json
import os
import urllib.request

base = os.environ["LIVETALKING_BASE_URL"].rstrip("/")
with urllib.request.urlopen(base + "/api/admin/sessions", timeout=5) as response:
    payload = json.load(response)
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
' > "$sessions_file"
python3 - "$sessions_file" <<'PY'
import json
import sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError) as exc:
    raise SystemExit(f"ERROR  LiveTalking sessions response is invalid: {type(exc).__name__}")
sessions = body.get("data", {}).get("sessions") if isinstance(body.get("data"), dict) else None
if body.get("code") != 0 or not isinstance(sessions, list):
    raise SystemExit("ERROR  LiveTalking sessions endpoint did not return a successful session list")
if len(sessions) != 1 or not isinstance(sessions[0], dict) or sessions[0].get("sessionid") != "0":
    raise SystemExit("ERROR  RTMP single-session mode must expose exactly one session whose ID is the string 0")
print('PASS   LiveTalking exposes exactly one RTMP session with ID "0"')
PY

if ! "$execute_start"; then
  printf 'PASS   session-zero acceptance completed in read-only mode\n'
  exit 0
fi

gateway_url="${RUNTIME_GATEWAY_URL:-http://127.0.0.1:8090}"
shared_token="${RUNTIME_SHARED_TOKEN:-}"
[[ -n "$shared_token" ]] || { printf 'ERROR  RUNTIME_SHARED_TOKEN is required with --execute\n' >&2; exit 1; }
command_id="acceptance_session_zero_$(date -u +%Y%m%dT%H%M%SZ)_$$"
request_body="$(printf '{"command_id":"%s","session_id":"0","action":"start_program"}' "$command_id")"
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
python3 - "$start_file" "$command_id" <<'PY'
import json
import sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError) as exc:
    raise SystemExit(f"ERROR  start_program returned invalid JSON: {type(exc).__name__}")
command_id = sys.argv[2]
receipt = body.get("receipt", {})
if body.get("accepted") is not True or body.get("command_id") != command_id or body.get("session_id") != "0":
    raise SystemExit("ERROR  start_program was not accepted for the exact session ID 0")
if receipt.get("command_id") != command_id or receipt.get("session_id") != "0" or receipt.get("action") != "start_program":
    raise SystemExit("ERROR  start_program receipt did not preserve session ID 0")
print('PASS   start_program accepted and receipt preserved session ID "0"')
PY

if "$stop_after"; then
  stop_id="acceptance_session_zero_stop_$(date -u +%Y%m%dT%H%M%SZ)_$$"
  stop_body="$(printf '{"command_id":"%s","session_id":"0","action":"stop_program"}' "$stop_id")"
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
  python3 - "$stop_file" "$stop_id" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
if body.get("accepted") is not True or body.get("command_id") != sys.argv[2] or body.get("session_id") != "0":
    raise SystemExit("ERROR  stop_program receipt did not preserve session ID 0")
print('PASS   stop_program accepted and receipt preserved session ID "0"')
PY
fi

if [[ -n "${EVIDENCE_FILE:-}" ]]; then
  evidence_dir="$(dirname -- "$EVIDENCE_FILE")"
  mkdir -p -- "$evidence_dir"
  evidence_tmp="${EVIDENCE_FILE}.tmp.$$"
  python3 - "$sessions_file" "$start_file" "${stop_file:-}" > "$evidence_tmp" <<'PY'
import json
import sys
from datetime import datetime, timezone

result = {
    "schema": "livetalking-session-zero-v1",
    "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "sessionId": "0",
    "sessions": json.load(open(sys.argv[1], encoding="utf-8")),
}
if sys.argv[2]:
    result["startProgram"] = json.load(open(sys.argv[2], encoding="utf-8"))
if sys.argv[3]:
    result["stopProgram"] = json.load(open(sys.argv[3], encoding="utf-8"))
json.dump(result, sys.stdout, ensure_ascii=False, sort_keys=True, indent=2)
sys.stdout.write("\n")
PY
  chmod 600 -- "$evidence_tmp"
  mv -- "$evidence_tmp" "$EVIDENCE_FILE"
  printf 'PASS   session-zero evidence written: %s\n' "$EVIDENCE_FILE"
fi
printf 'PASS   LiveTalking session-zero acceptance completed\n'
