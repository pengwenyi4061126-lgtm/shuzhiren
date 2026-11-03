#!/usr/bin/env bash
set -euo pipefail

# Creates a consistent SQLite snapshot of the Gateway command journal. It never
# restores, deletes, rotates, uploads, or overwrites backups.
state_path="${RUNTIME_GATEWAY_STATE_PATH:-}"
backup_dir="${BACKUP_DIR:-${GATEWAY_BACKUP_DIR:-}}"
python_bin="${PYTHON_BIN:-python3}"

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

[[ -n "$state_path" ]] || fail "RUNTIME_GATEWAY_STATE_PATH is required"
[[ "$state_path" = /* ]] || fail "RUNTIME_GATEWAY_STATE_PATH must be an absolute path"
[[ -d "$state_path" ]] || fail "RUNTIME_GATEWAY_STATE_PATH does not exist: $state_path"
[[ -n "$backup_dir" ]] || fail "BACKUP_DIR or GATEWAY_BACKUP_DIR is required and must be an absolute path outside the repository"
[[ "$backup_dir" = /* ]] || fail "BACKUP_DIR must be an absolute path"
command -v "$python_bin" >/dev/null || fail "PYTHON_BIN is unavailable: $python_bin"
command -v sha256sum >/dev/null || fail "sha256sum is required"

source_file="${state_path}/commands.sqlite3"
[[ -r "$source_file" ]] || fail "Gateway command journal is not readable: $source_file"

umask 077
mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="shuzhiren-runtime-gateway-state-${timestamp}"
snapshot="${backup_dir}/${base}.sqlite3"
manifest="${backup_dir}/${base}.manifest"
[[ ! -e "$snapshot" && ! -e "$manifest" ]] || fail "refusing to overwrite an existing backup: $base"
temporary="$(mktemp "${backup_dir}/.${base}.XXXXXX.sqlite3")"
trap 'rm -f "$temporary"' EXIT

journal_rows="$("$python_bin" - "$source_file" "$temporary" <<'PY'
import pathlib
import sqlite3
import sys

source_path = pathlib.Path(sys.argv[1]).resolve()
destination_path = pathlib.Path(sys.argv[2]).resolve()
source = sqlite3.connect(f"{source_path.as_uri()}?mode=ro", uri=True)
destination = sqlite3.connect(destination_path)
try:
    source.backup(destination)
    integrity = destination.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"snapshot integrity check failed: {integrity}")
    table = destination.execute(
        "select 1 from sqlite_master where type = 'table' and name = 'runtime_command_journal'"
    ).fetchone()
    if table is None:
        raise RuntimeError("snapshot does not contain runtime_command_journal")
    print(destination.execute("select count(*) from runtime_command_journal").fetchone()[0])
finally:
    destination.close()
    source.close()
PY
)"

[[ -s "$temporary" ]] || fail "SQLite backup completed without producing a snapshot"
mv "$temporary" "$snapshot"
trap - EXIT
checksum="$(sha256sum "$snapshot" | awk '{print $1}')"
bytes="$(wc -c < "$snapshot" | tr -d '[:space:]')"
{
  printf 'created_at_utc=%s\n' "$timestamp"
  printf 'snapshot=%s\n' "$(basename "$snapshot")"
  printf 'sha256=%s\n' "$checksum"
  printf 'bytes=%s\n' "$bytes"
  printf 'journal_rows=%s\n' "$journal_rows"
  printf 'source=commands.sqlite3\n'
} > "$manifest"

pass "Gateway command journal snapshot created and verified: $snapshot"
pass "Manifest written: $manifest"
printf 'NEXT   Copy both files to approved off-host storage; restore only through the documented isolated drill.\n'
