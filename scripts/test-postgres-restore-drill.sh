#!/usr/bin/env bash
set -euo pipefail

# Exercises restore-drill guardrails with PostgreSQL client stand-ins only.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
bin_dir="$test_root/bin"
backup_dir="$test_root/backups"
mkdir -p "$bin_dir" "$backup_dir"
archive="$backup_dir/shuzhiren-postgres-20261104T000000Z.dump"
manifest="${archive%.dump}.manifest"
printf 'fake-postgres-custom-archive\n' > "$archive"
checksum="$(sha256sum "$archive" | awk '{print $1}')"
bytes="$(wc -c < "$archive" | tr -d '[:space:]')"
cat > "$manifest" <<EOF
created_at_utc=20261104T000000Z
archive=$(basename "$archive")
sha256=$checksum
bytes=$bytes
source=database_url
EOF

cat > "$bin_dir/pg_restore" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--list" ]]; then
  grep -q '^fake-postgres-custom-archive$' "$2"
  exit 0
fi
[[ "$*" == *"--exit-on-error"* && "$*" == *"--no-owner"* && "$*" == *"--no-privileges"* ]]
printf 'restored\n' > "${RESTORE_DRILL_MARKER:?}"
EOF
cat > "$bin_dir/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
query="${*: -1}"
case "$query" in
  *"current_database"*) printf '%s\n' "${RESTORE_DRILL_DATABASE:-shuzhiren_restore_fixture}" ;;
  *"count(*) from pg_tables"*) printf '%s\n' "${RESTORE_DRILL_TABLE_COUNT:-0}" ;;
  *"count(*) from schema_migrations"*) printf '%s\n' "67" ;;
  *"string_agg"*) printf '\n' ;;
  *) exit 1 ;;
esac
EOF
chmod 0700 "$bin_dir/pg_restore" "$bin_dir/psql"

evidence="$test_root/restore-evidence.manifest"
PATH="$bin_dir:$PATH" \
BACKUP_FILE="$archive" \
DRILL_DATABASE_URL='postgresql://restore-owner:password@private-postgres:5432/shuzhiren_restore_fixture' \
DRILL_EVIDENCE_FILE="$evidence" \
RESTORE_DRILL_CONFIRM="restore-${checksum}" \
RESTORE_DRILL_MARKER="$test_root/restored" \
bash "$root/scripts/restore-postgres-drill.sh"
[[ -f "$test_root/restored" && -f "$evidence" ]]
grep -q '^target_database=shuzhiren_restore_fixture$' "$evidence"
grep -q '^migration_count=67$' "$evidence"

set +e
PATH="$bin_dir:$PATH" \
BACKUP_FILE="$archive" \
DRILL_DATABASE_URL='postgresql://restore-owner:password@private-postgres:5432/shuzhiren' \
DRILL_EVIDENCE_FILE="$test_root/unsafe-evidence.manifest" \
RESTORE_DRILL_CONFIRM="restore-${checksum}" \
RESTORE_DRILL_MARKER="$test_root/unsafe-restored" \
RESTORE_DRILL_DATABASE='shuzhiren' \
bash "$root/scripts/restore-postgres-drill.sh" >"$test_root/unsafe.log" 2>&1
unsafe_status=$?
set -e
[[ "$unsafe_status" -ne 0 ]]
grep -q 'must target an isolation database' "$test_root/unsafe.log"

printf 'PASS  PostgreSQL restore drill permits only empty, explicitly named isolation databases\n'
