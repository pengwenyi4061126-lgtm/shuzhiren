#!/usr/bin/env bash
set -euo pipefail

# Read-only 4090 host preflight. It never installs packages, pulls images, or changes Docker state.
required_gpu_name="${REQUIRED_GPU_NAME:-RTX 4090}"
minimum_gpu_memory_mib="${MIN_GPU_MEMORY_MIB:-22000}"
minimum_free_gib="${MIN_FREE_GIB:-150}"
workspace_root="${WORKSPACE_ROOT:-$PWD}"
required_storage_paths="${REQUIRED_STORAGE_PATHS:-$workspace_root}"
run_container_smoke=false

usage() {
  cat <<'EOF'
Usage: bash scripts/check-runtime-host.sh [--container-smoke]

Environment:
  WORKSPACE_ROOT         Repository root to use for the disk-space check (default: current directory)
  REQUIRED_STORAGE_PATHS Colon-separated host paths that each require MIN_FREE_GIB free (default: WORKSPACE_ROOT)
  REQUIRED_GPU_NAME      Required GPU name substring (default: RTX 4090)
  MIN_GPU_MEMORY_MIB     Minimum GPU memory in MiB (default: 22000)
  MIN_FREE_GIB           Minimum free disk space in GiB (default: 150)
  GPU_SMOKE_IMAGE        Immutable local image reference required by --container-smoke

The optional --container-smoke only runs an already-present image. GPU_SMOKE_IMAGE
must be pinned by digest; the script never pulls an image from a registry.
EOF
}

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

while (($#)); do
  case "$1" in
    --container-smoke) run_container_smoke=true ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

command -v nvidia-smi >/dev/null || fail "nvidia-smi unavailable; install a working NVIDIA driver first"
command -v docker >/dev/null || fail "docker unavailable; install Docker Engine first"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin unavailable"

gpu_rows="$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits)"
[[ -n "$gpu_rows" ]] || fail "nvidia-smi reported no GPU"
selected_gpu="$(printf '%s\n' "$gpu_rows" | awk -F ',' -v expected="$required_gpu_name" -v minimum="$minimum_gpu_memory_mib" '
  {
    for (i = 1; i <= NF; i++) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
    }
    if (index($1, expected) > 0 && ($3 + 0) >= minimum) {
      print $1 ", driver " $2 ", memory " $3 " MiB"
      exit
    }
  }
')"
[[ -n "$selected_gpu" ]] || fail "no GPU matches ${required_gpu_name} with at least ${minimum_gpu_memory_mib} MiB; detected: ${gpu_rows//$'\n'/; }"
pass "GPU accepted: $selected_gpu"

docker_runtimes="$(docker info --format '{{range $name, $_ := .Runtimes}}{{$name}} {{end}}' 2>/dev/null || true)"
[[ " $docker_runtimes " == *" nvidia "* ]] || fail "Docker nvidia runtime unavailable; install/configure NVIDIA Container Toolkit"
pass "Docker nvidia runtime available"

IFS=':' read -r -a storage_paths <<< "$required_storage_paths"
for storage_path in "${storage_paths[@]}"; do
  [[ -n "$storage_path" ]] || fail "REQUIRED_STORAGE_PATHS contains an empty path"
  [[ -d "$storage_path" ]] || fail "required storage path does not exist: $storage_path"
  free_gib="$(df -Pk "$storage_path" | awk 'NR == 2 { print int($4 / 1024 / 1024) }')"
  [[ "$free_gib" =~ ^[0-9]+$ ]] || fail "cannot determine free disk space for $storage_path"
  (( free_gib >= minimum_free_gib )) || fail "only ${free_gib} GiB free at $storage_path; at least ${minimum_free_gib} GiB is required"
  pass "disk capacity accepted: ${free_gib} GiB free at $storage_path"
done

if "$run_container_smoke"; then
  smoke_image="${GPU_SMOKE_IMAGE:-}"
  [[ "$smoke_image" == *@sha256:* ]] || fail "--container-smoke requires GPU_SMOKE_IMAGE pinned by @sha256 digest"
  docker image inspect "$smoke_image" >/dev/null 2>&1 || fail "GPU_SMOKE_IMAGE is not already local; pull and verify it separately before this read-only check"
  docker run --rm --pull=never --gpus all "$smoke_image" nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits
  pass "container can access the NVIDIA GPU"
fi

pass "4090 host preflight completed"
