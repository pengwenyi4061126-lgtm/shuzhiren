#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/runtime-compose.sh"

network_only=false
usage() {
  cat <<'EOF'
Usage: bash scripts/acceptance/runtime-network-isolation.sh [--network-only]

Read-only acceptance for the deployed runtime media network.

Required for the full check:
  RUNTIME_GATEWAY_READ_TOKEN  read-only Gateway token for /v1/observations/<session>
  OUTPUT_PROBE_URL             independent private output-probe URL
  OUTPUT_PROBE_TOKEN           output-probe read token

Optional:
  RUNTIME_REPO_ROOT            repository root containing the Compose file
  RUNTIME_COMPOSE_FILE         runtime Compose file
  RUNTIME_COMPOSE_PROJECT      Compose project name
  RUNTIME_COMPOSE_ENV_FILES    colon-separated Compose env files
  RUNTIME_GATEWAY_URL           Gateway URL (default http://127.0.0.1:8090)
  RUNTIME_SESSION_ID            session to observe (default: first active dynamic session)
  RUNTIME_ACCEPTANCE_RTMP_SINK_NAME
                                explicit local-only SRS sink name for acceptance
  OUTPUT_PROBE_MAX_AV_SYNC_MS   maximum allowed probe sync error (default 120)
  EVIDENCE_FILE                 write redacted JSON observations to this path

--network-only checks health and network isolation but does not query the
runtime observation or output probe. It never changes containers or networks.
EOF
}

while (($#)); do
  case "$1" in
    --network-only) network_only=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'ERROR  unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

runtime_acceptance_init_compose
gateway_container="$(runtime_acceptance_container runtime-gateway)"
project="$(runtime_acceptance_project "$gateway_container")"
media_network="$(runtime_acceptance_network runtime-media "$project")"
egress_network="$(runtime_acceptance_network livetalking-egress "$project")"

[[ "$(docker network inspect -f '{{.Internal}}' "$media_network")" == "true" ]] || {
  printf 'ERROR  Compose network %s must be internal\n' "$media_network" >&2
  exit 1
}
[[ "$(docker network inspect -f '{{.Internal}}' "$egress_network")" == "false" ]] || {
  printf 'ERROR  LiveTalking egress network %s must provide external egress\n' "$egress_network" >&2
  exit 1
}

declare -A media_services=()
while IFS= read -r member; do
  [[ -n "$member" ]] || continue
  service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$member")"
  case "$service" in
    runtime-gateway|livetalking|cosyvoice) media_services["$service"]="$member" ;;
    *) printf 'ERROR  unexpected service %s is attached to internal media network %s\n' "$service" "$media_network" >&2; exit 1 ;;
  esac
done < <(docker network inspect -f '{{range .Containers}}{{println .Name}}{{end}}' "$media_network")

for service in runtime-gateway livetalking cosyvoice; do
  [[ -n "${media_services[$service]:-}" ]] || {
    printf 'ERROR  required service %s is absent from %s\n' "$service" "$media_network" >&2
    exit 1
  }
done
for service in runtime-worker runtime-observer output-probe channel-adapter alert-notifier; do
  if container="$(runtime_acceptance_optional_container "$service")"; then
    if runtime_acceptance_has_network "$container" "$media_network"; then
      printf 'ERROR  service %s is attached to the private media network\n' "$service" >&2
      exit 1
    fi
  fi
done

declare -A egress_services=()
egress_test_sink_name="${RUNTIME_ACCEPTANCE_RTMP_SINK_NAME:-}"
egress_test_sink=""
while IFS= read -r member; do
  [[ -n "$member" ]] || continue
  container_name="$(docker inspect -f '{{.Name}}' "$member" | sed 's#^/##')"
  service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$member")"
  [[ "$service" == "livetalking" ]] || {
    if [[ -z "$egress_test_sink_name" || "$container_name" != "$egress_test_sink_name" ]]; then
      printf 'ERROR  unexpected service %s (container %s) is attached to LiveTalking egress network %s\n' "$service" "$container_name" "$egress_network" >&2
      exit 1
    fi
    [[ -z "$egress_test_sink" ]] || { printf 'ERROR  more than one acceptance RTMP sink is attached to %s\n' "$egress_network" >&2; exit 1; }
    sink_image="$(docker inspect -f '{{.Config.Image}}' "$member")"
    [[ "$sink_image" == "ossrs/srs:5" ]] || { printf 'ERROR  acceptance RTMP sink %s must use ossrs/srs:5; found %s\n' "$container_name" "$sink_image" >&2; exit 1; }
    egress_test_sink="$container_name"
    continue
  }
  egress_services["$service"]="$member"
done < <(docker network inspect -f '{{range .Containers}}{{println .Name}}{{end}}' "$egress_network")
[[ "${egress_services[livetalking]:-}" == "${media_services[livetalking]}" ]] || {
  printf 'ERROR  LiveTalking egress network does not point at the active LiveTalking container\n' >&2
  exit 1
}
[[ -z "$(docker port "${media_services[livetalking]}")" ]] || {
  printf 'ERROR  LiveTalking must not publish a host port\n' >&2
  exit 1
}
[[ -z "$(docker port "${media_services[cosyvoice]}")" ]] || {
  printf 'ERROR  CosyVoice must not publish a host port\n' >&2
  exit 1
}
printf 'PASS   runtime media network is internal and contains only Gateway, LiveTalking and CosyVoice\n'
printf 'PASS   non-media runtime services are absent from the media network\n'
if [[ -n "$egress_test_sink" ]]; then
  printf 'PASS   explicit acceptance RTMP sink %s is allowed on the egress network\n' "$egress_test_sink"
else
  printf 'PASS   LiveTalking alone owns the egress network\n'
fi
printf 'PASS   media services publish no host ports\n'

gateway_url="${RUNTIME_GATEWAY_URL:-http://127.0.0.1:8090}"
session_id="${RUNTIME_SESSION_ID:-}"
health_file="$(mktemp)"
observation_file=""
probe_file=""
cleanup() {
  rm -f -- "$health_file"
  [[ -z "$observation_file" ]] || rm -f -- "$observation_file"
  [[ -z "$probe_file" ]] || rm -f -- "$probe_file"
}
trap cleanup EXIT

health_status="$(curl --silent --show-error --max-time 10 --output "$health_file" --write-out '%{http_code}' "$gateway_url/healthz")" || {
  printf 'ERROR  Gateway /healthz request failed\n' >&2
  exit 1
}
[[ "$health_status" == "200" ]] || {
  printf 'ERROR  Gateway /healthz returned HTTP %s\n' "$health_status" >&2
  exit 1
}
python3 - "$health_file" <<'PY'
import json
import sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError) as exc:
    raise SystemExit(f"ERROR  Gateway /healthz returned invalid JSON: {type(exc).__name__}")
if body.get("status") != "ok":
    raise SystemExit("ERROR  Gateway /healthz is not ok")
for name in ("livetalking", "cosyvoice"):
    dependency = body.get("dependencies", {}).get(name, {})
    if dependency.get("available") is not True:
        raise SystemExit(f"ERROR  Gateway cannot reach {name}")
print("PASS   Gateway health reports LiveTalking and CosyVoice reachable")
PY

if "$network_only"; then
  printf 'PASS   runtime network isolation acceptance completed (network-only)\n'
  exit 0
fi

if [[ -z "$session_id" ]]; then
  session_id="$(docker exec "$gateway_container" python3 -c '
import json
import os
import re
import urllib.request

base = os.environ["LIVETALKING_BASE_URL"].rstrip("/")
with urllib.request.urlopen(base + "/api/admin/sessions", timeout=5) as response:
    payload = json.load(response)
sessions = payload.get("data", {}).get("sessions") if isinstance(payload.get("data"), dict) else None
ids = [item.get("sessionid") for item in sessions or [] if isinstance(item, dict) and isinstance(item.get("sessionid"), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", item["sessionid"])]
if not ids:
    raise SystemExit("no active dynamic LiveTalking session")
print(ids[0])
' 2>/dev/null)" || {
    printf 'ERROR  could not discover an active dynamic LiveTalking session; set RUNTIME_SESSION_ID explicitly\n' >&2
    exit 1
  }
  printf 'PASS   discovered dynamic runtime session %s\n' "$session_id"
fi

read_token="${RUNTIME_GATEWAY_READ_TOKEN:-}"
[[ -n "$read_token" ]] || { printf 'ERROR  RUNTIME_GATEWAY_READ_TOKEN is required for the observation check\n' >&2; exit 1; }
observation_file="$(mktemp)"
observation_status="$(curl --silent --show-error --max-time 10 --output "$observation_file" --write-out '%{http_code}' \
  -H "Authorization: Bearer $read_token" "$gateway_url/v1/observations/$session_id")" || {
  printf 'ERROR  Gateway observation request failed\n' >&2
  exit 1
}
[[ "$observation_status" == "200" ]] || {
  printf 'ERROR  Gateway observation returned HTTP %s\n' "$observation_status" >&2
  exit 1
}
python3 - "$observation_file" "$session_id" <<'PY'
import json
import sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError) as exc:
    raise SystemExit(f"ERROR  Gateway observation returned invalid JSON: {type(exc).__name__}")
session_id = sys.argv[2]
session = body.get("session", {})
quality = body.get("quality", {})
if session.get("id") != session_id or session.get("active") is not True:
    raise SystemExit(f"ERROR  runtime session {session_id!r} is not active")
if quality.get("writer_accepting_frames") is not True:
    raise SystemExit("ERROR  LiveTalking RTMP writer is not accepting frames")
print(f"PASS   runtime session {session_id!r} is active and LiveTalking is accepting frames")
PY

probe_url="${OUTPUT_PROBE_URL:-}"
probe_token="${OUTPUT_PROBE_TOKEN:-}"
[[ -n "$probe_url" ]] || { printf 'ERROR  OUTPUT_PROBE_URL is required for destination output acceptance\n' >&2; exit 1; }
[[ -n "$probe_token" ]] || { printf 'ERROR  OUTPUT_PROBE_TOKEN is required for destination output acceptance\n' >&2; exit 1; }
probe_file="$(mktemp)"
probe_status="$(curl --silent --show-error --max-time 15 --output "$probe_file" --write-out '%{http_code}' \
  -H "Authorization: Bearer $probe_token" "$probe_url")" || {
  printf 'ERROR  output probe request failed\n' >&2
  exit 1
}
[[ "$probe_status" == "200" ]] || {
  printf 'ERROR  output probe returned HTTP %s\n' "$probe_status" >&2
  exit 1
}
max_sync="${OUTPUT_PROBE_MAX_AV_SYNC_MS:-120}"
python3 - "$probe_file" "$max_sync" <<'PY'
import json
import math
import sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
    limit = float(sys.argv[2])
except (OSError, ValueError) as exc:
    raise SystemExit(f"ERROR  output probe returned invalid JSON: {type(exc).__name__}")
if body.get("outputConnected") is not True:
    raise SystemExit("ERROR  output probe reports outputConnected=false")
for key in ("outputFps", "bitrateMbps", "avSyncMs"):
    value = body.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
        raise SystemExit(f"ERROR  output probe field {key} is not a finite non-negative number")
if body["outputFps"] <= 0 or body["bitrateMbps"] <= 0:
    raise SystemExit("ERROR  output probe has no active video bitrate or frame rate")
if body["avSyncMs"] > limit:
    raise SystemExit(f"ERROR  output probe avSyncMs exceeds {limit:g} ms")
print("PASS   independent output probe confirms connected video, bitrate and audio sync")
PY

if [[ -n "${EVIDENCE_FILE:-}" ]]; then
  evidence_dir="$(dirname -- "$EVIDENCE_FILE")"
  mkdir -p -- "$evidence_dir"
  evidence_tmp="${EVIDENCE_FILE}.tmp.$$"
  python3 - "$health_file" "$observation_file" "$probe_file" "$media_network" "$egress_network" "$project" "$session_id" > "$evidence_tmp" <<'PY'
import json
import sys
from datetime import datetime, timezone

health = json.load(open(sys.argv[1], encoding="utf-8"))
observation = json.load(open(sys.argv[2], encoding="utf-8"))
probe = json.load(open(sys.argv[3], encoding="utf-8"))
json.dump({
    "schema": "runtime-network-isolation-v1",
    "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "composeProject": sys.argv[6],
    "mediaNetwork": sys.argv[4],
    "egressNetwork": sys.argv[5],
    "sessionId": sys.argv[7],
    "health": health,
    "observation": observation,
    "outputProbe": probe,
}, sys.stdout, ensure_ascii=False, sort_keys=True, indent=2)
sys.stdout.write("\n")
PY
  chmod 600 -- "$evidence_tmp"
  mv -- "$evidence_tmp" "$EVIDENCE_FILE"
  printf 'PASS   redacted acceptance evidence written: %s\n' "$EVIDENCE_FILE"
fi
printf 'PASS   runtime network isolation acceptance completed\n'
