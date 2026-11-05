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

# Every connecting client call records its argv and PGPASSWORD (one line each)
# so the test can prove the password reaches libpq only through the environment.
cat > "$bin_dir/pg_restore" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--list" ]]; then
  grep -q '^fake-postgres-custom-archive$' "$2"
  exit 0
fi
printf 'argv:%s\n' "$*" >> "${RESTORE_DRILL_CLIENT_LOG:?}"
printf 'pgpassword:%s\n' "${PGPASSWORD-<unset>}" >> "$RESTORE_DRILL_CLIENT_LOG"
[[ "$*" == *"--exit-on-error"* && "$*" == *"--no-owner"* && "$*" == *"--no-privileges"* ]]
printf 'restored\n' > "${RESTORE_DRILL_MARKER:?}"
EOF
cat > "$bin_dir/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'argv:%s\n' "$*" >> "${RESTORE_DRILL_CLIENT_LOG:?}"
printf 'pgpassword:%s\n' "${PGPASSWORD-<unset>}" >> "$RESTORE_DRILL_CLIENT_LOG"
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
client_log="$test_root/clients.log"
encoded_password='p%40ss%3Aw%2Frd%25%2B%C3%A9'
decoded_password=$'p@ss:w/rd%+\xc3\xa9'
unset PGPASSWORD
PATH="$bin_dir:$PATH" \
BACKUP_FILE="$archive" \
DRILL_DATABASE_URL="postgresql://drill:${encoded_password}@db.internal:6543/shuzhiren_restore_fixture?sslmode=require" \
DRILL_EVIDENCE_FILE="$evidence" \
RESTORE_DRILL_CONFIRM="restore-${checksum}" \
RESTORE_DRILL_MARKER="$test_root/restored" \
RESTORE_DRILL_CLIENT_LOG="$client_log" \
bash "$root/scripts/restore-postgres-drill.sh"
[[ -f "$test_root/restored" && -f "$evidence" ]]
grep -q '^target_database=shuzhiren_restore_fixture$' "$evidence"
grep -q '^migration_count=67$' "$evidence"

# L14: the password never appears in a client argv, in decoded or encoded form,
# and every connecting call (4 psql + 1 pg_restore) gets it through PGPASSWORD.
[[ "$(grep -c '^argv:' "$client_log")" == 5 ]]
if grep '^argv:' "$client_log" | grep -qF -e 'p@ss' -e 'p%40ss' -e "$decoded_password"; then
  printf 'FAIL  restore drill passed the database password in a client argv\n' >&2
  exit 1
fi
[[ "$(grep -c '^argv:.*--dbname=postgresql://drill@db.internal:6543/shuzhiren_restore_fixture?sslmode=require' "$client_log")" == 5 ]]
[[ "$(grep -cxF "pgpassword:${decoded_password}" "$client_log")" == 5 ]]

run_drill_with_url() {
  local url="$1" log="$2"
  rm -f "$client_log"
  set +e
  PATH="$bin_dir:$PATH" \
  BACKUP_FILE="$archive" \
  DRILL_DATABASE_URL="$url" \
  DRILL_EVIDENCE_FILE="$test_root/evidence-$RANDOM.manifest" \
  RESTORE_DRILL_CONFIRM="restore-${checksum}" \
  RESTORE_DRILL_MARKER="$test_root/restored-$RANDOM" \
  RESTORE_DRILL_CLIENT_LOG="$client_log" \
  bash "$root/scripts/restore-postgres-drill.sh" >"$log" 2>&1
  drill_status=$?
  set -e
}

# A password given only as a query parameter is removed from the URI as well.
run_drill_with_url 'postgresql://drill@db.internal/shuzhiren_restore_fixture?application_name=drill&password=q%26uery' "$test_root/query.log"
[[ "$drill_status" -eq 0 ]] || { cat "$test_root/query.log" >&2; exit 1; }
[[ "$(grep -c '^argv:.*--dbname=postgresql://drill@db.internal/shuzhiren_restore_fixture?application_name=drill ' "$client_log")" == 5 ]]
if grep '^argv:' "$client_log" | grep -qF -e 'q%26uery' -e 'q&uery'; then
  printf 'FAIL  restore drill passed a query-string password in a client argv\n' >&2
  exit 1
fi
[[ "$(grep -cxF 'pgpassword:q&uery' "$client_log")" == 5 ]]

# Without a password the drill must not set an empty PGPASSWORD over a passfile.
run_drill_with_url 'postgresql://drill@db.internal/shuzhiren_restore_fixture' "$test_root/nopassword.log"
[[ "$drill_status" -eq 0 ]] || { cat "$test_root/nopassword.log" >&2; exit 1; }
[[ "$(grep -cxF 'pgpassword:<unset>' "$client_log")" == 5 ]]

# Malformed or ambiguous URIs fail before any client connects.
for bad_url in 'host=db.internal dbname=shuzhiren_restore_fixture password=secret' 'postgresql://drill:a%00b@db.internal/shuzhiren_restore_fixture' 'postgresql://drill:a%G1@db.internal/shuzhiren_restore_fixture' 'postgresql://drill:one@db.internal/shuzhiren_restore_fixture?password=two'; do
  run_drill_with_url "$bad_url" "$test_root/bad.log"
  [[ "$drill_status" -ne 0 ]]
  grep -q 'DRILL_DATABASE_URL must be a postgresql:// URI' "$test_root/bad.log"
  [[ ! -e "$client_log" ]]
  if grep -qF -e 'secret' -e 'a%00b' -e 'a%G1' -e 'one@' "$test_root/bad.log"; then
    printf 'FAIL  restore drill echoed a rejected DRILL_DATABASE_URL\n' >&2
    exit 1
  fi
done

set +e
PATH="$bin_dir:$PATH" \
BACKUP_FILE="$archive" \
DRILL_DATABASE_URL='postgresql://restore-owner:password@private-postgres:5432/shuzhiren' \
DRILL_EVIDENCE_FILE="$test_root/unsafe-evidence.manifest" \
RESTORE_DRILL_CONFIRM="restore-${checksum}" \
RESTORE_DRILL_MARKER="$test_root/unsafe-restored" \
RESTORE_DRILL_CLIENT_LOG="$test_root/unsafe-clients.log" \
RESTORE_DRILL_DATABASE='shuzhiren' \
bash "$root/scripts/restore-postgres-drill.sh" >"$test_root/unsafe.log" 2>&1
unsafe_status=$?
set -e
[[ "$unsafe_status" -ne 0 ]]
grep -q 'must target an isolation database' "$test_root/unsafe.log"

printf 'PASS  PostgreSQL restore drill permits only empty, explicitly named isolation databases\n'
printf 'PASS  PostgreSQL restore drill passes the database password through PGPASSWORD, never argv\n'
