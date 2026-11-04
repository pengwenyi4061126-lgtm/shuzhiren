#!/usr/bin/env bash
set -euo pipefail

# Read-only Gateway command-journal backup verification. It never starts a
# Gateway, restores a snapshot, deletes data, or alters the source journal.
backup_file="${BACKUP_FILE:-}"
manifest_file="${MANIFEST_FILE:-}"
expected_sha256="${EXPECTED_SHA256:-}"
python_bin="${PYTHON_BIN:-python3}"

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

[[ -n "$backup_file" ]] || fail "BACKUP_FILE is required"
[[ "$backup_file" = /* ]] || fail "BACKUP_FILE must be an absolute path"
[[ -r "$backup_file" ]] || fail "BACKUP_FILE is not readable: $backup_file"
[[ "${backup_file##*.}" == "sqlite3" ]] || fail "BACKUP_FILE must be a .sqlite3 snapshot"
[[ -n "$manifest_file" ]] || manifest_file="${backup_file%.sqlite3}.manifest"
[[ "$manifest_file" = /* ]] || fail "MANIFEST_FILE must be an absolute path"
[[ -r "$manifest_file" ]] || fail "Gateway backup manifest is not readable: $manifest_file"
command -v "$python_bin" >/dev/null || fail "PYTHON_BIN is unavailable: $python_bin"
command -v sha256sum >/dev/null || fail "sha256sum is required"

actual_sha256="$(sha256sum "$backup_file" | awk '{print $1}')"
actual_bytes="$(wc -c < "$backup_file" | tr -d '[:space:]')"
manifest_value() {
  local key="$1"
  local value
  value="$(awk -F= -v key="$key" '$1 == key { count += 1; print substr($0, length(key) + 2) } END { if (count != 1) exit 1 }' "$manifest_file")" || fail "Gateway backup manifest must contain exactly one ${key} entry"
  [[ -n "$value" ]] || fail "Gateway backup manifest ${key} must not be empty"
  printf '%s' "$value"
}
manifest_snapshot="$(manifest_value snapshot)"
manifest_sha256="$(manifest_value sha256)"
manifest_bytes="$(manifest_value bytes)"
manifest_rows="$(manifest_value journal_rows)"
manifest_source="$(manifest_value source)"
manifest_created_at="$(manifest_value created_at_utc)"
[[ "$manifest_snapshot" == "$(basename "$backup_file")" ]] || fail "Gateway backup manifest snapshot does not match BACKUP_FILE"
[[ "$manifest_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "Gateway backup manifest sha256 is invalid"
[[ "$manifest_bytes" =~ ^[0-9]+$ && "$manifest_rows" =~ ^[0-9]+$ ]] || fail "Gateway backup manifest bytes or journal_rows is invalid"
[[ "$manifest_source" == "commands.sqlite3" ]] || fail "Gateway backup manifest source is invalid"
[[ "$manifest_created_at" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "Gateway backup manifest created_at_utc is invalid"
[[ "$actual_sha256" == "$manifest_sha256" ]] || fail "SHA-256 does not match gateway backup manifest"
[[ "$actual_bytes" == "$manifest_bytes" ]] || fail "Gateway backup bytes do not match gateway backup manifest"
[[ -z "$expected_sha256" || "$expected_sha256" == "$manifest_sha256" ]] || fail "EXPECTED_SHA256 does not match gateway backup manifest"

journal_rows="$("$python_bin" - "$backup_file" <<'PY'
import pathlib
import sqlite3
import sys

snapshot_path = pathlib.Path(sys.argv[1]).resolve()
connection = sqlite3.connect(f"{snapshot_path.as_uri()}?mode=ro", uri=True)
try:
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"snapshot integrity check failed: {integrity}")
    table = connection.execute(
        "select 1 from sqlite_master where type = 'table' and name = 'runtime_command_journal'"
    ).fetchone()
    if table is None:
        raise RuntimeError("snapshot does not contain runtime_command_journal")
    print(connection.execute("select count(*) from runtime_command_journal").fetchone()[0])
finally:
    connection.close()
PY
)"

pass "Gateway command journal snapshot is readable: $backup_file"
pass "Manifest verified: $manifest_file"
pass "SHA-256: $actual_sha256"
pass "Journal rows: $journal_rows"
