#!/usr/bin/env bash
set -euo pipefail

# Restores one verified Gateway command-journal snapshot only into an empty
# isolation directory. It never starts Gateway, overwrites runtime state, or
# deletes the source snapshot.
backup_file="${BACKUP_FILE:-}"
manifest_file="${MANIFEST_FILE:-}"
drill_state_path="${DRILL_GATEWAY_STATE_PATH:-}"
evidence_file="${DRILL_EVIDENCE_FILE:-}"
confirmation="${RESTORE_DRILL_CONFIRM:-}"
workspace_root="${WORKSPACE_ROOT:-$PWD}"
python_bin="${PYTHON_BIN:-python3}"
gateway_uid="${DRILL_GATEWAY_UID:-}"
gateway_backup_group="${DRILL_GATEWAY_BACKUP_GROUP:-}"

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

[[ -n "$backup_file" && "$backup_file" = /* && -r "$backup_file" ]] || fail "BACKUP_FILE must be an absolute readable SQLite snapshot"
[[ -n "$drill_state_path" && "$drill_state_path" = /* ]] || fail "DRILL_GATEWAY_STATE_PATH must be an absolute isolation directory"
[[ -d "$drill_state_path" ]] || fail "DRILL_GATEWAY_STATE_PATH does not exist: $drill_state_path"
[[ -n "$evidence_file" && "$evidence_file" = /* ]] || fail "DRILL_EVIDENCE_FILE must be an absolute path outside the isolation directory"
[[ "$evidence_file" != "$drill_state_path"/* ]] || fail "DRILL_EVIDENCE_FILE must be outside DRILL_GATEWAY_STATE_PATH"
[[ -n "$manifest_file" ]] || manifest_file="${backup_file%.sqlite3}.manifest"
[[ "$manifest_file" = /* && -r "$manifest_file" ]] || fail "MANIFEST_FILE must be an absolute readable manifest"
[[ "$gateway_uid" =~ ^[0-9]+$ ]] || fail "DRILL_GATEWAY_UID must be the numeric Gateway service UID"
[[ "$gateway_backup_group" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ || "$gateway_backup_group" =~ ^[0-9]+$ ]] || fail "DRILL_GATEWAY_BACKUP_GROUP must be a group name or numeric GID"
command -v "$python_bin" >/dev/null || fail "PYTHON_BIN is unavailable: $python_bin"
command -v sha256sum >/dev/null || fail "sha256sum is required"
command -v chown >/dev/null || fail "chown is required"
command -v stat >/dev/null || fail "stat is required"

production_state_path="${RUNTIME_GATEWAY_STATE_PATH:-}"
[[ -z "$production_state_path" || "$drill_state_path" != "$production_state_path" ]] || fail "DRILL_GATEWAY_STATE_PATH must not equal RUNTIME_GATEWAY_STATE_PATH"
[[ "$drill_state_path" != "$workspace_root" && "$drill_state_path" != "$workspace_root"/* ]] || fail "DRILL_GATEWAY_STATE_PATH must be outside WORKSPACE_ROOT"
[[ -z "$(find "$drill_state_path" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail "DRILL_GATEWAY_STATE_PATH must be empty"
[[ ! -e "$evidence_file" ]] || fail "refusing to overwrite existing DRILL_EVIDENCE_FILE"

checksum="$(sha256sum "$backup_file" | awk '{print $1}')"
[[ "$confirmation" == "restore-${checksum}" ]] || fail "RESTORE_DRILL_CONFIRM must equal restore-${checksum} for this exact snapshot"

BACKUP_FILE="$backup_file" MANIFEST_FILE="$manifest_file" PYTHON_BIN="$python_bin" bash "$workspace_root/scripts/verify-runtime-gateway-state-backup.sh" >/dev/null

target_file="${drill_state_path}/commands.sqlite3"
[[ ! -e "$target_file" ]] || fail "DRILL_GATEWAY_STATE_PATH already contains commands.sqlite3"
temporary="$(mktemp "${drill_state_path}/.commands.sqlite3.restore.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
cp "$backup_file" "$temporary"
mv "$temporary" "$target_file"
trap - EXIT
chown "${gateway_uid}:${gateway_backup_group}" "$target_file"
chmod 0640 "$target_file"

journal_counts="$("$python_bin" - "$target_file" <<'PY'
import pathlib
import sqlite3
import sys

target_path = pathlib.Path(sys.argv[1]).resolve()
connection = sqlite3.connect(f"{target_path.as_uri()}?mode=ro", uri=True)
try:
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"restored journal integrity check failed: {integrity}")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(runtime_command_journal)")}
    required = {"command_id", "kind", "identity_sha256", "state", "response_json", "created_at", "completed_at"}
    missing = sorted(required - columns)
    if missing:
        raise RuntimeError(f"restored journal is missing Gateway command columns: {', '.join(missing)}")
    journal_rows = connection.execute("select count(*) from runtime_command_journal").fetchone()[0]
    completed_rows = connection.execute(
        "select count(*) from runtime_command_journal where state = 'completed' and response_json is not null"
    ).fetchone()[0]
    print(journal_rows, completed_rows)
finally:
    connection.close()
PY
)"
read -r journal_rows completed_rows <<< "$journal_counts"

umask 077
mkdir -p "$(dirname "$evidence_file")"
evidence_temporary="$(mktemp "$(dirname "$evidence_file")/.gateway-restore-drill.XXXXXX")"
trap 'rm -f "$evidence_temporary"' EXIT
{
  printf 'completed_at_utc=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)"
  printf 'snapshot=%s\n' "$(basename "$backup_file")"
  printf 'manifest=%s\n' "$(basename "$manifest_file")"
  printf 'snapshot_sha256=%s\n' "$checksum"
  printf 'target_state_path=%s\n' "$drill_state_path"
  printf 'target_file=commands.sqlite3\n'
  printf 'target_file_mode=%s\n' "$(stat -c '%u:%g:%a' "$target_file")"
  printf 'journal_rows=%s\n' "$journal_rows"
  printf 'completed_command_rows=%s\n' "$completed_rows"
  printf 'gateway_started=false\n'
} > "$evidence_temporary"
mv "$evidence_temporary" "$evidence_file"
trap - EXIT

pass "Gateway command journal restored into isolated state directory: $drill_state_path"
pass "Restore drill evidence written: $evidence_file"
printf 'NEXT   Start a separate Gateway instance against this isolation directory and retry a completed command; record that it returns the stored result without a downstream call. Do not point a running production Gateway at this directory.\n'
