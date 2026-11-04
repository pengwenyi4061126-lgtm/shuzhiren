#!/usr/bin/env bash
set -euo pipefail

# Exercises the DATABASE_URL path with controlled PostgreSQL client stand-ins.
# It never contacts a database, restores data, or writes outside a mktemp dir.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
first_pid=""
release_file=""
cleanup() {
  [[ -z "$release_file" ]] || touch "$release_file" 2>/dev/null || true
  [[ -z "$first_pid" ]] || wait "$first_pid" 2>/dev/null || true
  rm -rf "$test_root"
}
trap cleanup EXIT
bin_dir="$test_root/bin"
backup_dir="$test_root/backups"
mkdir -p "$bin_dir" "$backup_dir"

cat > "$bin_dir/pg_dump" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *"--dbname=postgresql://backup-user:backup-password@private-postgres:5432/shuzhiren"* ]]
[[ "$*" == *"--format=custom"* ]]
if [[ "${BACKUP_TEST_HOLD:-}" == "true" ]]; then
  : "${BACKUP_TEST_READY:?BACKUP_TEST_READY is required when holding}"
  : "${BACKUP_TEST_RELEASE:?BACKUP_TEST_RELEASE is required when holding}"
  touch "$BACKUP_TEST_READY"
  while [[ ! -e "$BACKUP_TEST_RELEASE" ]]; do sleep 0.05; done
fi
printf 'fake-postgres-custom-archive\n'
EOF
cat > "$bin_dir/pg_restore" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "--list" ]]
grep -q '^fake-postgres-custom-archive$' "$2"
EOF
chmod 0700 "$bin_dir/pg_dump" "$bin_dir/pg_restore"

PATH="$bin_dir:$PATH" \
DATABASE_URL='postgresql://backup-user:backup-password@private-postgres:5432/shuzhiren' \
POSTGRES_BACKUP_DIR="$backup_dir" \
bash "$root/scripts/backup-postgres.sh"

archive="$(find "$backup_dir" -maxdepth 1 -name '*.dump' -type f -print -quit)"
manifest="${archive%.dump}.manifest"
[[ -n "$archive" && -f "$manifest" ]]
grep -q '^source=database_url$' "$manifest"
expected_sha256="$(awk -F= '/^sha256=/{print $2}' "$manifest")"

PATH="$bin_dir:$PATH" \
BACKUP_FILE="$archive" \
EXPECTED_SHA256="$expected_sha256" \
bash "$root/scripts/verify-postgres-backup.sh"

tampered_manifest="$test_root/tampered.manifest"
sed 's/^bytes=.*/bytes=0/' "$manifest" > "$tampered_manifest"
set +e
PATH="$bin_dir:$PATH" \
BACKUP_FILE="$archive" \
MANIFEST_FILE="$tampered_manifest" \
bash "$root/scripts/verify-postgres-backup.sh" >"$test_root/tampered-verify.log" 2>&1
tampered_status=$?
set -e
[[ "$tampered_status" -ne 0 ]]
grep -q 'Backup bytes do not match backup manifest' "$test_root/tampered-verify.log"

contended_backup_dir="$test_root/contended-backups"
ready_file="$test_root/backup-ready"
release_file="$test_root/backup-release"
first_log="$test_root/first-backup.log"
second_log="$test_root/second-backup.log"

PATH="$bin_dir:$PATH" \
DATABASE_URL='postgresql://backup-user:backup-password@private-postgres:5432/shuzhiren' \
POSTGRES_BACKUP_DIR="$contended_backup_dir" \
BACKUP_TEST_HOLD=true \
BACKUP_TEST_READY="$ready_file" \
BACKUP_TEST_RELEASE="$release_file" \
bash "$root/scripts/backup-postgres.sh" >"$first_log" 2>&1 &
first_pid=$!
for _ in {1..100}; do
  [[ -e "$ready_file" ]] && break
  sleep 0.05
done
[[ -e "$ready_file" ]] || { cat "$first_log" >&2; exit 1; }

set +e
PATH="$bin_dir:$PATH" \
DATABASE_URL='postgresql://backup-user:backup-password@private-postgres:5432/shuzhiren' \
POSTGRES_BACKUP_DIR="$contended_backup_dir" \
bash "$root/scripts/backup-postgres.sh" >"$second_log" 2>&1
second_status=$?
set -e
[[ "$second_status" -ne 0 ]]
grep -q 'another PostgreSQL backup is already running' "$second_log"
touch "$release_file"
wait "$first_pid"

printf 'PASS  PostgreSQL backup uses the private DATABASE_URL client path without Compose\n'
printf 'PASS  PostgreSQL backup rejects a manifest with incorrect archive bytes\n'
printf 'PASS  PostgreSQL backup rejects concurrent writers for one backup directory\n'
