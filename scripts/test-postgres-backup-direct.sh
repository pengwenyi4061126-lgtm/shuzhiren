#!/usr/bin/env bash
set -euo pipefail

# Exercises the DATABASE_URL path with controlled PostgreSQL client stand-ins.
# It never contacts a database, restores data, or writes outside a mktemp dir.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
bin_dir="$test_root/bin"
backup_dir="$test_root/backups"
mkdir -p "$bin_dir" "$backup_dir"

cat > "$bin_dir/pg_dump" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *"--dbname=postgresql://backup-user:backup-password@private-postgres:5432/shuzhiren"* ]]
[[ "$*" == *"--format=custom"* ]]
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

printf 'PASS  PostgreSQL backup uses the private DATABASE_URL client path without Compose\n'
