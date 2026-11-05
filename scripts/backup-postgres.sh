#!/usr/bin/env bash
set -euo pipefail

# Creates a PostgreSQL archive and validates its structure. It never restores,
# deletes, rotates, uploads, or overwrites backups.
backup_dir="${BACKUP_DIR:-${POSTGRES_BACKUP_DIR:-}}"
workspace_root="${WORKSPACE_ROOT:-$PWD}"
compose_file="${COMPOSE_FILE:-$workspace_root/infra/compose/docker-compose.yml}"
postgres_service="${POSTGRES_SERVICE:-postgres}"
postgres_db="${POSTGRES_DB:-shuzhiren}"
postgres_user="${POSTGRES_USER:-shuzhiren}"
database_url="${DATABASE_URL:-}"

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

# Moves the password of a postgres:// URI out of the client argv (visible to
# every local user through /proc/<pid>/cmdline). Sets PG_SAFE_URL (the URI
# without its password, otherwise byte-identical), PG_URL_HAS_PASSWORD and the
# percent-decoded PG_URL_PASSWORD, following libpq: userinfo ends at the first
# '@' before the first '/', and the last password= query parameter wins.
pg_url_split() {
  local url="$1" scheme rest before_slash userinfo user password="" userinfo_password=0 base query param kept="" encoded decoded="" hex byte
  local -a params=()
  case "$url" in
    postgresql://*) scheme="postgresql://" ;;
    postgres://*) scheme="postgres://" ;;
    *) return 1 ;;
  esac
  rest="${url#"$scheme"}"
  before_slash="${rest%%/*}"
  if [[ "$before_slash" == *@* ]]; then
    userinfo="${before_slash%%@*}"
    user="${userinfo%%:*}"
    if [[ "$userinfo" == *:* ]]; then
      password="${userinfo#*:}"
      [[ -z "$password" ]] || userinfo_password=1
    fi
    rest="${user}@${rest#*@}"
  fi
  base="${rest%%\?*}"
  if [[ "$rest" == *\?* ]]; then
    query="${rest#*\?}"
    IFS='&' read -r -a params <<< "$query"
    for param in "${params[@]}"; do
      if [[ "${param%%=*}" == "password" ]]; then
        [[ "$userinfo_password" == 0 ]] || return 1
        password=""
        [[ "$param" != *=* ]] || password="${param#*=}"
        continue
      fi
      kept+="${kept:+&}${param}"
    done
    [[ -z "$kept" ]] || base+="?${kept}"
  fi
  encoded="$password"
  while [[ "$encoded" == *%* ]]; do
    decoded+="${encoded%%\%*}"
    encoded="${encoded#*\%}"
    hex="${encoded:0:2}"
    [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ && "$hex" != "00" ]] || return 1
    printf -v byte "\\x${hex}"
    decoded+="$byte"
    encoded="${encoded:2}"
  done
  PG_URL_PASSWORD="${decoded}${encoded}"
  PG_URL_HAS_PASSWORD=0
  [[ -z "$PG_URL_PASSWORD" ]] || PG_URL_HAS_PASSWORD=1
  PG_SAFE_URL="${scheme}${base}"
}
# Passes the password only to the one client process, through its environment.
run_pg() { if [[ "$PG_URL_HAS_PASSWORD" == 1 ]]; then PGPASSWORD="$PG_URL_PASSWORD" "$@"; else "$@"; fi; }

[[ -n "$backup_dir" ]] || fail "BACKUP_DIR or POSTGRES_BACKUP_DIR is required and must be an absolute path outside the repository"
[[ "$backup_dir" = /* ]] || fail "BACKUP_DIR must be an absolute path"
command -v sha256sum >/dev/null || fail "sha256sum is required"
command -v flock >/dev/null || fail "flock is required to prevent concurrent backups"
if [[ -n "$database_url" ]]; then
  pg_url_split "$database_url" || fail "DATABASE_URL must be a postgresql:// URI with valid percent-encoding and at most one password"
  command -v pg_dump >/dev/null || fail "pg_dump is required when DATABASE_URL is configured"
  command -v pg_restore >/dev/null || fail "pg_restore is required when DATABASE_URL is configured"
else
  [[ -f "$compose_file" ]] || fail "COMPOSE_FILE does not exist: $compose_file"
  command -v docker >/dev/null || fail "docker is required when DATABASE_URL is not configured"
fi

umask 077
mkdir -p "$backup_dir"
lock_file="${backup_dir}/.backup.lock"
exec 9>"$lock_file"
flock -n 9 || fail "another PostgreSQL backup is already running for $backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="shuzhiren-postgres-${timestamp}"
archive="${backup_dir}/${base}.dump"
manifest="${backup_dir}/${base}.manifest"
[[ ! -e "$archive" && ! -e "$manifest" ]] || fail "refusing to overwrite an existing backup: $base"
temporary="$(mktemp "${backup_dir}/.${base}.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

if [[ -n "$database_url" ]]; then
  run_pg pg_dump --dbname="$PG_SAFE_URL" --format=custom > "$temporary"
  pg_restore --list "$temporary" >/dev/null
  backup_source="database_url"
else
  docker compose -f "$compose_file" exec -T "$postgres_service" pg_dump -U "$postgres_user" -d "$postgres_db" -Fc > "$temporary"
  docker compose -f "$compose_file" exec -T "$postgres_service" pg_restore --list < "$temporary" >/dev/null
  backup_source="compose:${postgres_service}"
fi
[[ -s "$temporary" ]] || fail "pg_dump completed without producing an archive"

mv "$temporary" "$archive"
trap - EXIT
checksum="$(sha256sum "$archive" | awk '{print $1}')"
bytes="$(wc -c < "$archive" | tr -d '[:space:]')"
{
  printf 'created_at_utc=%s\n' "$timestamp"
  printf 'archive=%s\n' "$(basename "$archive")"
  printf 'sha256=%s\n' "$checksum"
  printf 'bytes=%s\n' "$bytes"
  printf 'source=%s\n' "$backup_source"
} > "$manifest"

pass "PostgreSQL archive created and structurally verified: $archive"
pass "Manifest written: $manifest"
printf 'NEXT   Copy both files to approved off-host storage; restore only through the documented isolated drill.\n'
