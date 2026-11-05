#!/usr/bin/env bash
set -euo pipefail

# Creates a consistent SQLite snapshot of the Gateway command journal. It never
# restores, deletes, rotates, uploads, or overwrites backups, and it never
# writes into the Gateway state directory, which may be mounted read-only.
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

# Until both final files are in place, any exit removes every file this run
# created, so a failed run leaves nothing in BACKUP_DIR.
temporary=""
manifest_temporary=""
published_snapshot=""
cleanup() {
  if [[ -n "$temporary" ]]; then
    rm -f "$temporary" "${temporary}-wal" "${temporary}-shm" "${temporary}-journal"
  fi
  if [[ -n "$manifest_temporary" ]]; then
    rm -f "$manifest_temporary"
  fi
  if [[ -n "$published_snapshot" ]]; then
    rm -f "$published_snapshot"
  fi
}
trap cleanup EXIT
temporary="$(mktemp "${backup_dir}/.${base}.XXXXXX.sqlite3")"
manifest_temporary="$(mktemp "${backup_dir}/.${base}.XXXXXX.manifest")"

journal_rows="$("$python_bin" - "$source_file" "$temporary" <<'PY'
import hashlib
import os
import pathlib
import sqlite3
import sys
import time

ATTEMPTS = 3
WAL_WITHOUT_SHM = (
    "WAL file exists but -shm is missing and the state directory is read-only; "
    "start the Gateway once or run the backup with write access"
)
CHANGED_DURING_COPY = "WAL database without -shm changed during read-only copy; retry when the Gateway is idle"

source_path = pathlib.Path(sys.argv[1]).resolve()
destination_path = pathlib.Path(sys.argv[2]).resolve()
wal_path = pathlib.Path(f"{source_path}-wal")
shm_path = pathlib.Path(f"{source_path}-shm")


class SnapshotError(Exception):
    pass


def is_wal_database() -> bool:
    # Bytes 18 and 19 of the SQLite header are the file format versions; 2 means WAL.
    with source_path.open("rb") as handle:
        header = handle.read(20)
    return len(header) == 20 and header.startswith(b"SQLite format 3\x00") and 2 in (header[18], header[19])


def online_backup() -> None:
    source = sqlite3.connect(f"{source_path.as_uri()}?mode=ro", uri=True)
    try:
        destination = sqlite3.connect(destination_path)
        try:
            source.backup(destination)
        finally:
            destination.close()
    finally:
        source.close()


def stat_key(path: pathlib.Path) -> tuple[int, int, int, int]:
    status = path.stat()
    return (status.st_ino, status.st_size, status.st_mtime_ns, status.st_ctime_ns)


def sidecars_absent() -> bool:
    return not wal_path.exists() and not shm_path.exists()


def source_digest() -> str:
    digest = hashlib.sha256()
    with source_path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def quiescent_copy() -> bool:
    # Without -wal every committed transaction is in the main file. A Gateway
    # connection that opens or checkpoints during the copy changes the sidecars,
    # the file metadata, or the content, and the copy is then discarded.
    if not sidecars_absent():
        return False
    before = stat_key(source_path)
    digest = hashlib.sha256()
    with source_path.open("rb") as source, destination_path.open("wb") as destination:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
            destination.write(block)
        destination.flush()
        os.fsync(destination.fileno())
    if not sidecars_absent() or stat_key(source_path) != before:
        return False
    return source_digest() == digest.hexdigest()


def take_snapshot() -> None:
    reason = CHANGED_DURING_COPY
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(1)
        if not is_wal_database():
            online_backup()
            return
        if sidecars_absent():
            # Idle Gateway: copy the file instead of opening it, because a
            # read-only SQLite connection would need to create -shm in the
            # state directory and would leave -wal and -shm behind.
            if quiescent_copy():
                return
            reason = CHANGED_DURING_COPY
            continue
        if shm_path.exists() or os.access(source_path.parent, os.W_OK):
            online_backup()
            return
        reason = WAL_WITHOUT_SHM
    raise SnapshotError(reason)


def finish_snapshot() -> int:
    connection = sqlite3.connect(destination_path)
    try:
        # A rollback-journal snapshot opens with mode=ro without -wal or -shm,
        # so it can be verified and restored from read-only storage.
        journal_mode = connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
        if str(journal_mode).lower() != "delete":
            raise SnapshotError(f"snapshot journal mode is {journal_mode}, expected delete")
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise SnapshotError(f"snapshot integrity check failed: {integrity}")
        table = connection.execute(
            "select 1 from sqlite_master where type = 'table' and name = 'runtime_command_journal'"
        ).fetchone()
        if table is None:
            raise SnapshotError("snapshot does not contain runtime_command_journal")
        return connection.execute("select count(*) from runtime_command_journal").fetchone()[0]
    finally:
        connection.close()


try:
    take_snapshot()
    print(finish_snapshot())
except Exception as error:  # Report one line without a stack trace; bash removes the partial files.
    reason = " ".join(str(error).split()) or type(error).__name__
    print(f"ERROR  cannot snapshot {source_path}: {reason}", file=sys.stderr)
    sys.exit(1)
PY
)"

[[ "$journal_rows" =~ ^[0-9]+$ ]] || fail "SQLite backup did not report a journal row count"
[[ -s "$temporary" ]] || fail "SQLite backup completed without producing a snapshot"
checksum="$(sha256sum "$temporary" | awk '{print $1}')"
bytes="$(wc -c < "$temporary" | tr -d '[:space:]')"
{
  printf 'created_at_utc=%s\n' "$timestamp"
  printf 'snapshot=%s\n' "$(basename "$snapshot")"
  printf 'sha256=%s\n' "$checksum"
  printf 'bytes=%s\n' "$bytes"
  printf 'journal_rows=%s\n' "$journal_rows"
  printf 'source=commands.sqlite3\n'
} > "$manifest_temporary"
mv "$temporary" "$snapshot"
temporary=""
published_snapshot="$snapshot"
mv "$manifest_temporary" "$manifest"
manifest_temporary=""
published_snapshot=""
trap - EXIT

pass "Gateway command journal snapshot created and verified: $snapshot"
pass "Manifest written: $manifest"
printf 'NEXT   Copy both files to approved off-host storage; restore only through the documented isolated drill.\n'
