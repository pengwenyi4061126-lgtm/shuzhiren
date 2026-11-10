#!/usr/bin/env bash
set -euo pipefail

# Prepare only the private host paths used by the 4090 runtime.  This script
# never installs software, downloads models, creates secrets, starts Docker,
# or modifies a Git checkout.  It is deliberately fixed to /srv/shuzhiren so
# a privileged invocation cannot be redirected at an arbitrary path.
runtime_root="/srv/shuzhiren"
verify_only=false

usage() {
  cat <<'EOF'
Usage: sudo bash scripts/provision-runtime-host-paths.sh [--verify-only]

Creates or verifies the least-privilege directory tree required by the runtime:
  /srv/shuzhiren/{models,cosyvoice-models,avatars,avatar-candidates,recordings,
                   voices,runtime-gateway-state,overlay-assets,observer-config,
                   release,secrets,evidence,backups/{postgres,runtime-gateway}}

The command is intentionally limited to /srv/shuzhiren. It does not create
model weights, avatar assets, voice material, stream keys, environment files,
or Docker containers.

--verify-only  Check owners, groups, and modes without changing the host.
EOF
}

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

while (($#)); do
  case "$1" in
    --verify-only) verify_only=true ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

command -v getent >/dev/null || fail "getent is required"
command -v install >/dev/null || fail "install is required"
command -v stat >/dev/null || fail "stat is required"

if ! "$verify_only"; then
  [[ "$(id -u)" == "0" ]] || fail "run this provisioning command through sudo"
fi

deploy_user="${DEPLOY_USER:-${SUDO_USER:-}}"
[[ -n "$deploy_user" ]] || fail "DEPLOY_USER or SUDO_USER is required to own deployment-private paths"
[[ "$deploy_user" != "root" ]] || fail "DEPLOY_USER must name the non-root deployment account"
getent passwd "$deploy_user" >/dev/null || fail "DEPLOY_USER does not resolve: $deploy_user"
deploy_uid="$(id -u "$deploy_user")"
deploy_gid="$(id -g "$deploy_user")"

backup_group="shuzhiren-backup"
if ! getent group "$backup_group" >/dev/null; then
  if "$verify_only"; then
    fail "backup group is missing: $backup_group"
  fi
  groupadd --system "$backup_group"
fi
backup_gid="$(getent group "$backup_group" | awk -F: 'NR == 1 { print $3 }')"
[[ "$backup_gid" =~ ^[0-9]+$ ]] || fail "cannot resolve gid for $backup_group"

declare -a paths=(
  "$runtime_root|0|0|0750|runtime root"
  "$runtime_root/models|10002|10002|0750|LiveTalking model volume"
  "$runtime_root/cosyvoice-models|10003|10003|0750|CosyVoice model volume"
  "$runtime_root/avatars|10002|10002|0750|published avatar volume"
  "$runtime_root/avatar-candidates|10002|10002|0700|avatar candidate volume"
  "$runtime_root/recordings|10002|10002|0700|LiveTalking recording volume"
  "$runtime_root/voices|10001|10001|0750|Gateway read-only voice library"
  "$runtime_root/runtime-gateway-state|10001|$backup_gid|2750|Gateway command journal"
  "$runtime_root/overlay-assets|10002|10002|0750|LiveTalking overlay assets"
  "$runtime_root/observer-config|$deploy_uid|$deploy_gid|0700|observer configuration"
  "$runtime_root/release|$deploy_uid|$deploy_gid|0700|release evidence"
  "$runtime_root/secrets|$deploy_uid|$deploy_gid|0700|runtime secrets"
  "$runtime_root/evidence|$deploy_uid|$deploy_gid|0700|acceptance evidence"
  "$runtime_root/backups|0|$backup_gid|2750|backup root"
  "$runtime_root/backups/postgres|0|$backup_gid|2750|PostgreSQL backups"
  "$runtime_root/backups/runtime-gateway|0|$backup_gid|2750|Gateway state backups"
)

for item in "${paths[@]}"; do
  IFS='|' read -r path owner group mode description <<<"$item"
  if ! "$verify_only"; then
    install -d -m "$mode" -o "$owner" -g "$group" -- "$path"
  fi
  [[ -d "$path" ]] || fail "$description directory is missing: $path"
  actual="$(stat -c '%u:%g:%a' -- "$path")"
  expected="$owner:$group:${mode#0}"
  [[ "$actual" == "$expected" ]] || fail "$description must be $expected; found $actual at $path"
  pass "$description accepted: $path ($actual)"
done

pass "runtime host paths are ready under $runtime_root"
