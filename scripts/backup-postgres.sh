#!/usr/bin/env bash
set -euo pipefail

# Creates a PostgreSQL archive and validates its structure. It never restores,
# deletes, rotates, uploads, or overwrites backups.
backup_dir="${BACKUP_DIR:-}"
workspace_root="${WORKSPACE_ROOT:-$PWD}"
compose_file="${COMPOSE_FILE:-$workspace_root/infra/compose/docker-compose.yml}"
postgres_service="${POSTGRES_SERVICE:-postgres}"
postgres_db="${POSTGRES_DB:-shuzhiren}"
postgres_user="${POSTGRES_USER:-shuzhiren}"

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

[[ -n "$backup_dir" ]] || fail "BACKUP_DIR is required and must be an absolute path outside the repository"
[[ "$backup_dir" = /* ]] || fail "BACKUP_DIR must be an absolute path"
[[ -f "$compose_file" ]] || fail "COMPOSE_FILE does not exist: $compose_file"
command -v docker >/dev/null || fail "docker is required"
command -v sha256sum >/dev/null || fail "sha256sum is required"

umask 077
mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="shuzhiren-postgres-${timestamp}"
archive="${backup_dir}/${base}.dump"
manifest="${backup_dir}/${base}.manifest"
temporary="$(mktemp "${backup_dir}/.${base}.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

docker compose -f "$compose_file" exec -T "$postgres_service" pg_dump -U "$postgres_user" -d "$postgres_db" -Fc > "$temporary"
[[ -s "$temporary" ]] || fail "pg_dump completed without producing an archive"
docker compose -f "$compose_file" exec -T "$postgres_service" pg_restore --list < "$temporary" >/dev/null

mv "$temporary" "$archive"
trap - EXIT
checksum="$(sha256sum "$archive" | awk '{print $1}')"
bytes="$(wc -c < "$archive" | tr -d '[:space:]')"
{
  printf 'created_at_utc=%s\n' "$timestamp"
  printf 'archive=%s\n' "$(basename "$archive")"
  printf 'sha256=%s\n' "$checksum"
  printf 'bytes=%s\n' "$bytes"
  printf 'database=%s\n' "$postgres_db"
  printf 'postgres_service=%s\n' "$postgres_service"
} > "$manifest"

pass "PostgreSQL archive created and structurally verified: $archive"
pass "Manifest written: $manifest"
printf 'NEXT   Copy both files to approved off-host storage; restore only through the documented isolated drill.\n'
