#!/usr/bin/env bash
set -euo pipefail

# Reproducible short sample trial for the single-4090 profile.
# Creates a real dynamic LiveTalking session, starts the governed program,
# pushes to the configured RTMP sink, records an MP4, and writes evidence.
source "$(cd -- "$(dirname -- "$0")" && pwd)/runtime-compose.sh"

duration="$(printenv SAMPLE_LIVE_TRIAL_SECONDS || true)"
[ -n "$duration" ] || duration=60
voice_id="$(printenv SAMPLE_VOICE_ID || true)"
[ -n "$voice_id" ] || voice_id=p0-test-voice
voice_checksum="$(printenv SAMPLE_VOICE_CHECKSUM || true)"
[ -n "$voice_checksum" ] || voice_checksum=sha256:c7b31d6dbe7cc6a716dded00550db5b50940bf209e424e4ad207b12e657c8ff6
runtime_gateway_url="$(printenv RUNTIME_GATEWAY_URL || true)"
[ -n "$runtime_gateway_url" ] || runtime_gateway_url=http://127.0.0.1:8090
output_dir="$(printenv SAMPLE_LIVE_OUTPUT_DIR || true)"
[ -n "$output_dir" ] || output_dir="$PWD/sample-assets/digital-host"
script_text='你好，欢迎来到数字人直播样片。今天介绍氨基酸洁面慕斯，价格九十九元，氨基酸表活，泡沫细腻，按压泵头方便使用。商品资料显示赠旅行装三件套，并支持四十八小时内发货。以上内容来自已审核资料，实际购买请以商品详情页为准。'

gateway_post() {
  local body="$1" output="$2"
  GATEWAY_URL="$runtime_gateway_url" GATEWAY_TOKEN="$shared_token" GATEWAY_BODY="$body" GATEWAY_OUTPUT="$output" python3 - <<'PY'
import os, sys, urllib.error, urllib.request
request = urllib.request.Request(
    os.environ["GATEWAY_URL"] + "/v1/media",
    data=os.environ["GATEWAY_BODY"].encode("utf-8"),
    headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["GATEWAY_TOKEN"]},
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=120) as response:
        status, payload = response.status, response.read()
except urllib.error.HTTPError as error:
    status, payload = error.code, error.read()
open(os.environ["GATEWAY_OUTPUT"], "wb").write(payload)
print(status)
if status >= 400:
    raise SystemExit(22)
PY
}

[[ "$duration" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR SAMPLE_LIVE_TRIAL_SECONDS must be a positive integer" >&2; exit 1; }
runtime_acceptance_init_compose
gateway_container="$(runtime_acceptance_container runtime-gateway)"
livetalking_container="$(runtime_acceptance_container livetalking)"
mkdir -p -- "$output_dir"

shared_token="$(printenv RUNTIME_SHARED_TOKEN || true)"
if [ -z "$shared_token" ]; then
  shared_token="$(docker inspect "$gateway_container" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^RUNTIME_SHARED_TOKEN=//p')"
fi
[ -n "$shared_token" ] || { echo "ERROR RUNTIME_SHARED_TOKEN unavailable" >&2; exit 1; }

avatar_id="$(printenv SAMPLE_RUNTIME_AVATAR_ID || true)"
if [ -z "$avatar_id" ]; then
  avatar_id="$(docker inspect "$livetalking_container" --format '{{json .Config.Cmd}}' | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a[a.index("--avatar_id")+1])')"
fi
[[ "$avatar_id" =~ ^sr_[0-9a-f]{32}$ ]] || { echo "ERROR invalid runtime avatar id" >&2; exit 1; }

before_file="$(mktemp)"
after_file="$(mktemp)"
offer_file="$(mktemp)"
offer_error_file="$(mktemp)"
metrics_file="$(mktemp)"
probe_file="$(mktemp)"
start_file="$(mktemp)"
stop_file="$(mktemp)"
helper_pid_file="/tmp/shuziren-sample-live-$(date -u +%Y%m%dT%H%M%SZ)-$$.pid"
offer_pid=""
session_id=""
stop_sent=false
recording_path=""

cleanup() {
  if [ -n "$session_id" ] && [ "$stop_sent" != true ]; then
    cleanup_id="sample_live_cleanup_$(date -u +%Y%m%dT%H%M%SZ)_$$"
    cleanup_body="$(python3 - "$cleanup_id" "$session_id" <<'PY'
import json,sys
print(json.dumps({"command_id":sys.argv[1],"session_id":sys.argv[2],"action":"stop_program"},separators=(",",":")))
PY
)"
    gateway_post "$cleanup_body" /tmp/shuziren-sample-live-cleanup.json >/dev/null 2>&1 || true
  fi
  helper_container_pid="$(docker exec "$livetalking_container" sh -c 'cat "$1" 2>/dev/null || true' sh "$helper_pid_file" 2>/dev/null || true)"
  if [[ "$helper_container_pid" =~ ^[0-9]+$ ]]; then
    docker exec "$livetalking_container" kill -TERM "$helper_container_pid" >/dev/null 2>&1 || true
    sleep 1
    docker exec "$livetalking_container" kill -KILL "$helper_container_pid" >/dev/null 2>&1 || true
    docker exec "$livetalking_container" rm -f "$helper_pid_file" >/dev/null 2>&1 || true
  fi
  [ -z "$offer_pid" ] || kill "$offer_pid" >/dev/null 2>&1 || true
  rm -f "$before_file" "$after_file" "$offer_file" "$offer_error_file" "$metrics_file" "$probe_file" "$start_file" "$stop_file"
}
trap cleanup EXIT

docker exec "$livetalking_container" python3 -c '
import json
from pathlib import Path
root=Path("/app/data/record")
items=[]
for path in sorted(root.glob("*.mp4")) if root.exists() else []:
    try: stat=path.stat()
    except FileNotFoundError: continue
    items.append({"path":str(path),"size":stat.st_size,"mtime_ns":stat.st_mtime_ns})
print(json.dumps(items,separators=(",",":")))
' > "$before_file"

docker exec -e "SHUZIREN_ACCEPTANCE_PID_FILE=$helper_pid_file" "$livetalking_container" python3 -c '
import asyncio,json,os,urllib.request
from pathlib import Path
from aiortc import RTCPeerConnection,RTCSessionDescription
async def main():
    pid=Path(os.environ["SHUZIREN_ACCEPTANCE_PID_FILE"])
    pid.write_text(str(os.getpid()),encoding="ascii")
    pc=RTCPeerConnection()
    connected=asyncio.Event()
    @pc.on("connectionstatechange")
    async def state():
        if pc.connectionState in ("connected","failed","closed"): connected.set()
    try:
        pc.addTransceiver("audio",direction="recvonly")
        pc.addTransceiver("video",direction="recvonly")
        await pc.setLocalDescription(await pc.createOffer())
        body=json.dumps({"sdp":pc.localDescription.sdp,"type":pc.localDescription.type}).encode()
        req=urllib.request.Request("http://127.0.0.1:8010/offer",data=body,headers={"content-type":"application/json"},method="POST")
        with urllib.request.urlopen(req,timeout=30) as response: answer=json.load(response)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"],type=answer["type"]))
        await asyncio.wait_for(connected.wait(),timeout=30)
        if pc.connectionState != "connected": raise RuntimeError("WebRTC did not connect")
        print(json.dumps(answer,separators=(",",":")),flush=True)
        await asyncio.sleep(600)
    finally:
        await pc.close()
        try: pid.unlink()
        except FileNotFoundError: pass
asyncio.run(main())
' > "$offer_file" 2> "$offer_error_file" &
offer_pid="$!"

for _ in $(seq 1 60); do
  [ -s "$offer_file" ] && break
  if ! kill -0 "$offer_pid" 2>/dev/null; then cat "$offer_error_file" >&2 || true; exit 1; fi
  sleep 0.5
done
[ -s "$offer_file" ] || { cat "$offer_error_file" >&2 || true; echo "ERROR WebRTC offer timeout" >&2; exit 1; }
session_id="$(python3 - "$offer_file" <<'PY'
import json,re,sys
body=json.load(open(sys.argv[1],encoding="utf-8"))
sid=body.get("sessionid")
if not isinstance(sid,str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}",sid): raise SystemExit("ERROR invalid session id")
print(sid)
PY
)"
echo "PASS dynamic session=$session_id avatar=$avatar_id"

segment_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
start_id="sample_live_start_$(date -u +%Y%m%dT%H%M%SZ)_$$"
start_body="$(python3 - "$start_id" "$session_id" "$segment_id" "$script_text" "$voice_id" "$voice_checksum" "$avatar_id" <<'PY'
import hashlib,json,sys
command_id,session_id,segment_id,script,voice,checksum,avatar=sys.argv[1:]
print(json.dumps({"command_id":command_id,"session_id":session_id,"action":"start_program","program_segment_id":segment_id,"program_script":script,"script_sha256":hashlib.sha256(script.encode()).hexdigest(),"runtime_voice_id":voice,"voice_checksum":checksum,"runtime_avatar_id":avatar},ensure_ascii=False,separators=(",",":")))
PY
)"
start_status="$(gateway_post "$start_body" "$start_file")" || start_status=0
[ "$start_status" = 200 ] || { cat "$start_file" >&2; echo "ERROR start_program HTTP $start_status" >&2; exit 1; }
python3 - "$start_file" "$start_id" "$session_id" <<'PY'
import json,sys
body=json.load(open(sys.argv[1],encoding="utf-8"))
if body.get("accepted") is not True or body.get("command_id") != sys.argv[2] or body.get("session_id") != sys.argv[3]: raise SystemExit("ERROR start receipt mismatch")
print("PASS start_program accepted")
PY

for _ in $(seq 1 30); do
  if docker exec "$gateway_container" python3 -c '
import os,urllib.request
base=os.environ["LIVETALKING_BASE_URL"].rstrip("/")
with urllib.request.urlopen(base+"/api/admin/runtime-metrics",timeout=5) as response: print(response.read().decode())
' > "$metrics_file" 2>/dev/null; then
    if python3 - "$metrics_file" "$session_id" <<'PY'
import json,sys
body=json.load(open(sys.argv[1],encoding="utf-8")); data=body.get("data",{})
sessions=data.get("sessions",[]) if isinstance(data,dict) else []
session=next((x for x in sessions if isinstance(x,dict) and x.get("sessionid")==sys.argv[2]),None)
metrics=session.get("metrics",{}) if isinstance(session,dict) else {}
aigc=data.get("aigc_label",{}) if isinstance(data,dict) else {}
if metrics.get("output_connected") is True and float(metrics.get("output_fps") or 0)>0 and aigc.get("enabled") is True and int(aigc.get("frames_labelled") or 0)>0 and aigc.get("frames_dropped")==0 and aigc.get("last_error") is None:
    print("PASS output connected and AIGC frames labelled")
    raise SystemExit(0)
raise SystemExit(1)
PY
    then break; fi
  fi
  sleep 1
done
echo "WAIT streaming and recording $duration""s"
sleep "$duration"

stop_id="sample_live_stop_$(date -u +%Y%m%dT%H%M%SZ)_$$"
stop_body="$(python3 - "$stop_id" "$session_id" <<'PY'
import json,sys
print(json.dumps({"command_id":sys.argv[1],"session_id":sys.argv[2],"action":"stop_program"},separators=(",",":")))
PY
)"
stop_status="$(gateway_post "$stop_body" "$stop_file")" || stop_status=0
[ "$stop_status" = 200 ] || { cat "$stop_file" >&2; echo "ERROR stop_program HTTP $stop_status" >&2; exit 1; }
stop_sent=true
echo "PASS stop_program accepted"

for _ in $(seq 1 40); do
  docker exec "$livetalking_container" python3 -c '
import json
from pathlib import Path
root=Path("/app/data/record")
items=[]
for path in sorted(root.glob("*.mp4")) if root.exists() else []:
    try: stat=path.stat()
    except FileNotFoundError: continue
    items.append({"path":str(path),"size":stat.st_size,"mtime_ns":stat.st_mtime_ns})
print(json.dumps(items,separators=(",",":")))
' > "$after_file" 2>/dev/null || true
  recording_path="$(python3 - "$before_file" "$after_file" <<'PY'
import json,sys
before={x.get("path") for x in json.load(open(sys.argv[1])) if isinstance(x,dict)}
after=[x for x in json.load(open(sys.argv[2])) if isinstance(x,dict) and x.get("path") not in before and int(x.get("size",0))>0]
if after: print(max(after,key=lambda x:(int(x.get("mtime_ns",0)),int(x.get("size",0))))["path"])
PY
)"
  [ -n "$recording_path" ] && break
  sleep 1
done
[ -n "$recording_path" ] || { echo "ERROR no finalized MP4 recording" >&2; exit 1; }
docker exec "$livetalking_container" ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,sample_rate,channels -show_entries format=duration,size -of json "$recording_path" > "$probe_file"
docker cp "$livetalking_container:$recording_path" "$output_dir/live-trial.mp4" >/dev/null
python3 - "$probe_file" "$metrics_file" "$session_id" "$duration" "$output_dir/sample-live-trial-evidence.json" <<'PY'
import json,sys
from datetime import datetime,timezone
probe=json.load(open(sys.argv[1],encoding="utf-8"))
metrics=json.load(open(sys.argv[2],encoding="utf-8"))
evidence={"schema":"shuzhiren-sample-live-trial-v1","observedAt":datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),"sessionId":sys.argv[3],"requestedDurationSeconds":int(sys.argv[4]),"recording":{"file":"live-trial.mp4","ffprobe":probe},"runtimeMetrics":metrics}
json.dump(evidence,open(sys.argv[5],"w",encoding="utf-8"),ensure_ascii=False,indent=2)
print(json.dumps({"sessionId":sys.argv[3],"format":probe.get("format",{})},ensure_ascii=False))
PY
echo "PASS evidence=$output_dir/sample-live-trial-evidence.json"
