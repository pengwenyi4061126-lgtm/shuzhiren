#!/usr/bin/env bash
set -euo pipefail

# Read-only archive verification. It never connects to or restores a database.
backup_file="${BACKUP_FILE:-}"
manifest_file="${MANIFEST_FILE:-}"
workspace_root="${WORKSPACE_ROOT:-$PWD}"
compose_file="${COMPOSE_FILE:-$workspace_root/infra/compose/docker-compose.yml}"
postgres_service="${POSTGRES_SERVICE:-postgres}"
expected_sha256="${EXPECTED_SHA256:-}"

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

[[ -n "$backup_file" ]] || fail "BACKUP_FILE is required"
[[ "$backup_file" = /* ]] || fail "BACKUP_FILE must be an absolute path"
[[ -r "$backup_file" ]] || fail "BACKUP_FILE is not readable: $backup_file"
[[ "${backup_file##*.}" == "dump" ]] || fail "BACKUP_FILE must be a .dump archive"
[[ -n "$manifest_file" ]] || manifest_file="${backup_file%.dump}.manifest"
[[ "$manifest_file" = /* ]] || fail "MANIFEST_FILE must be an absolute path"
[[ -r "$manifest_file" ]] || fail "Backup manifest is not readable: $manifest_file"
command -v sha256sum >/dev/null || fail "sha256sum is required"

actual_sha256="$(sha256sum "$backup_file" | awk '{print $1}')"
actual_bytes="$(wc -c < "$backup_file" | tr -d '[:space:]')"
manifest_value() {
  local key="$1"
  local value
  value="$(awk -F= -v key="$key" '$1 == key { count += 1; print substr($0, length(key) + 2) } END { if (count != 1) exit 1 }' "$manifest_file")" || fail "Backup manifest must contain exactly one ${key} entry"
  [[ -n "$value" ]] || fail "Backup manifest ${key} must not be empty"
  printf '%s' "$value"
}
manifest_archive="$(manifest_value archive)"
manifest_sha256="$(manifest_value sha256)"
manifest_bytes="$(manifest_value bytes)"
manifest_source="$(manifest_value source)"
manifest_created_at="$(manifest_value created_at_utc)"
[[ "$manifest_archive" == "$(basename "$backup_file")" ]] || fail "Backup manifest archive does not match BACKUP_FILE"
[[ "$manifest_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "Backup manifest sha256 is invalid"
[[ "$manifest_bytes" =~ ^[0-9]+$ ]] || fail "Backup manifest bytes is invalid"
[[ "$manifest_source" =~ ^[A-Za-z0-9:_-]+$ ]] || fail "Backup manifest source is invalid"
[[ "$manifest_created_at" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "Backup manifest created_at_utc is invalid"
[[ "$actual_sha256" == "$manifest_sha256" ]] || fail "SHA-256 does not match backup manifest"
[[ "$actual_bytes" == "$manifest_bytes" ]] || fail "Backup bytes do not match backup manifest"
[[ -z "$expected_sha256" || "$expected_sha256" == "$manifest_sha256" ]] || fail "EXPECTED_SHA256 does not match backup manifest"
if command -v pg_restore >/dev/null; then
  pg_restore --list "$backup_file" >/dev/null
else
  [[ -f "$compose_file" ]] || fail "COMPOSE_FILE does not exist: $compose_file"
  command -v docker >/dev/null || fail "pg_restore or docker is required"
  docker compose -f "$compose_file" exec -T "$postgres_service" pg_restore --list < "$backup_file" >/dev/null
fi
pass "PostgreSQL archive is readable: $backup_file"
pass "Manifest verified: $manifest_file"
pass "SHA-256: $actual_sha256"
