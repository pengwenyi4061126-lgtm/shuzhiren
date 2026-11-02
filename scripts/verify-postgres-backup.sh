#!/usr/bin/env bash
set -euo pipefail

# Read-only archive verification. It never connects to or restores a database.
backup_file="${BACKUP_FILE:-}"
workspace_root="${WORKSPACE_ROOT:-$PWD}"
compose_file="${COMPOSE_FILE:-$workspace_root/infra/compose/docker-compose.yml}"
postgres_service="${POSTGRES_SERVICE:-postgres}"
expected_sha256="${EXPECTED_SHA256:-}"

fail() { printf 'ERROR  %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS   %s\n' "$*"; }

[[ -n "$backup_file" ]] || fail "BACKUP_FILE is required"
[[ "$backup_file" = /* ]] || fail "BACKUP_FILE must be an absolute path"
[[ -r "$backup_file" ]] || fail "BACKUP_FILE is not readable: $backup_file"
[[ -f "$compose_file" ]] || fail "COMPOSE_FILE does not exist: $compose_file"
command -v docker >/dev/null || fail "docker is required"
command -v sha256sum >/dev/null || fail "sha256sum is required"

actual_sha256="$(sha256sum "$backup_file" | awk '{print $1}')"
if [[ -n "$expected_sha256" && "$actual_sha256" != "$expected_sha256" ]]; then
  fail "SHA-256 does not match EXPECTED_SHA256"
fi
docker compose -f "$compose_file" exec -T "$postgres_service" pg_restore --list < "$backup_file" >/dev/null
pass "PostgreSQL archive is readable: $backup_file"
pass "SHA-256: $actual_sha256"
