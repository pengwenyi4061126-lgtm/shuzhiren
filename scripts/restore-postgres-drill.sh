#!/usr/bin/env bash
set -euo pipefail

# Restores a verified archive only into an empty, explicitly named isolation
# database. It never connects to the production DATABASE_URL or drops a database.
backup_file="${BACKUP_FILE:-}"
manifest_file="${MANIFEST_FILE:-}"
drill_database_url="${DRILL_DATABASE_URL:-}"
evidence_file="${DRILL_EVIDENCE_FILE:-}"
confirmation="${RESTORE_DRILL_CONFIRM:-}"
workspace_root="${WORKSPACE_ROOT:-$PWD}"

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

[[ -n "$backup_file" && "$backup_file" = /* && -r "$backup_file" ]] || fail "BACKUP_FILE must be an absolute readable archive"
[[ -n "$drill_database_url" ]] || fail "DRILL_DATABASE_URL is required and must point to a dedicated isolation database"
pg_url_split "$drill_database_url" || fail "DRILL_DATABASE_URL must be a postgresql:// URI with valid percent-encoding and at most one password"
[[ -n "$evidence_file" && "$evidence_file" = /* ]] || fail "DRILL_EVIDENCE_FILE must be an absolute path outside the repository"
command -v pg_restore >/dev/null || fail "pg_restore is required for an isolated restore drill"
command -v psql >/dev/null || fail "psql is required for an isolated restore drill"
command -v sha256sum >/dev/null || fail "sha256sum is required"

manifest_file="${manifest_file:-${backup_file%.dump}.manifest}"
[[ "$manifest_file" = /* && -r "$manifest_file" ]] || fail "MANIFEST_FILE must be an absolute readable manifest"
checksum="$(sha256sum "$backup_file" | awk '{print $1}')"
[[ "$confirmation" == "restore-${checksum}" ]] || fail "RESTORE_DRILL_CONFIRM must equal restore-${checksum} for this exact archive"
[[ ! -e "$evidence_file" ]] || fail "refusing to overwrite existing DRILL_EVIDENCE_FILE"

BACKUP_FILE="$backup_file" MANIFEST_FILE="$manifest_file" bash "$workspace_root/scripts/verify-postgres-backup.sh" >/dev/null

target_database="$(run_pg psql --dbname="$PG_SAFE_URL" -Atqc 'select current_database()')"
[[ "$target_database" =~ ^shuzhiren_restore_[a-z0-9_]+$ ]] || fail "DRILL_DATABASE_URL must target an isolation database named shuzhiren_restore_<suffix>"
table_count="$(run_pg psql --dbname="$PG_SAFE_URL" -Atqc "select count(*) from pg_tables where schemaname = 'public'")"
[[ "$table_count" == "0" ]] || fail "restore drill target database must be empty; found ${table_count} public tables"

run_pg pg_restore --exit-on-error --no-owner --no-privileges --dbname="$PG_SAFE_URL" "$backup_file"
migration_count="$(run_pg psql --dbname="$PG_SAFE_URL" -Atqc 'select count(*) from schema_migrations')"
[[ "$migration_count" =~ ^[1-9][0-9]*$ ]] || fail "restored isolation database does not contain applied schema migrations"
missing_tables="$(run_pg psql --dbname="$PG_SAFE_URL" -Atqc "select string_agg(name, ',') from (values ('tenants'), ('live_runs'), ('audit_events'), ('outbox_events'), ('schema_migrations')) required(name) where to_regclass('public.' || name) is null")"
[[ -z "$missing_tables" ]] || fail "restored isolation database is missing required tables: ${missing_tables}"

umask 077
mkdir -p "$(dirname "$evidence_file")"
temporary="$(mktemp "$(dirname "$evidence_file")/.restore-drill.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
{
  printf 'completed_at_utc=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)"
  printf 'archive=%s\n' "$(basename "$backup_file")"
  printf 'manifest=%s\n' "$(basename "$manifest_file")"
  printf 'archive_sha256=%s\n' "$checksum"
  printf 'target_database=%s\n' "$target_database"
  printf 'migration_count=%s\n' "$migration_count"
  printf 'required_tables=tenants,live_runs,audit_events,outbox_events,schema_migrations\n'
} > "$temporary"
mv "$temporary" "$evidence_file"
trap - EXIT

pass "PostgreSQL archive restored into isolated database ${target_database}"
pass "Restore drill evidence written: ${evidence_file}"
printf 'NEXT   Drop the isolated database only through the approved DBA procedure after preserving this evidence.\n'
