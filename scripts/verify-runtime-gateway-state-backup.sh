#!/usr/bin/env bash
set -euo pipefail

# Read-only Gateway command-journal backup verification. It never starts a
# Gateway, restores a snapshot, deletes data, or alters the source journal.
backup_file="${BACKUP_FILE:-}"
expected_sha256="${EXPECTED_SHA256:-}"
python_bin="${PYTHON_BIN:-python3}"

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

[[ -n "$backup_file" ]] || fail "BACKUP_FILE is required"
[[ "$backup_file" = /* ]] || fail "BACKUP_FILE must be an absolute path"
[[ -r "$backup_file" ]] || fail "BACKUP_FILE is not readable: $backup_file"
command -v "$python_bin" >/dev/null || fail "PYTHON_BIN is unavailable: $python_bin"
command -v sha256sum >/dev/null || fail "sha256sum is required"

actual_sha256="$(sha256sum "$backup_file" | awk '{print $1}')"
if [[ -n "$expected_sha256" && "$actual_sha256" != "$expected_sha256" ]]; then
  fail "SHA-256 does not match EXPECTED_SHA256"
fi

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
pass "SHA-256: $actual_sha256"
pass "Journal rows: $journal_rows"
