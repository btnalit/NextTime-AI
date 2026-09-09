#!/bin/sh
# drill-restore.sh — S3.10 operational drill (docs/development-tasks.md §S3.10 acceptance:
# "按「从备份恢复」手册在临时环境走一遍成功"). POSIX sh, run ON THE HOST from the checkout root,
# same conventions as scripts/accept_s1.sh/accept_s2.sh (PASS/FAIL lines, an EXIT trap that cleans
# up regardless of how the script terminates).
#
# What this drills: docs/runbooks/backup-restore.md's own "恢复演练" section, automated —
# scripts/restore.sh (the documented restore procedure itself, unmodified, called exactly as that
# runbook says to call it) into a fresh, never-touched-before nexttime_restore_<ts> database
# (restore.sh's own default target — this drill never passes --target-db, so it can never come
# anywhere near the live `nexttime` database), asserts the restored database actually has tables
# (table count > 0 — proof the dump was not empty/corrupt and pg_restore actually populated
# something, not just that the command exited 0), then drops the temp database.
#
# Usage:
#   sh scripts/drill-restore.sh [--db <dump-file>] [--keep]
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/drill-restore.sh' </dev/null
#
#   --db <dump-file>   restore this specific dump instead of the newest one under
#                       ${NEXTTIME_DATA}/backups/db/. Same shape scripts/restore.sh itself expects
#                       (a nexttime-<ts>.dump produced by deploy/backup/backup.sh's pg_dump -Fc).
#   --keep              skip dropping the temp database afterward — leaves it for manual
#                       inspection (`docker compose exec -T postgres psql -U nexttime -d <name>`).
#
# Without --db: looks for the newest ${NEXTTIME_DATA}/backups/db/nexttime-*.dump (filenames are
# UTC-timestamped so lexical sort == chronological order, same convention backup.sh's own retention
# pruning already relies on); if none exists yet (a fresh host that has never run a backup), this
# drill triggers one itself (`docker compose run --rm -e BACKUP_NOW=1 backup` — docs/runbooks/
# backup-restore.md's own "手动跑一次" section) rather than failing on a precondition the operator
# would otherwise have to remember to satisfy first.
#
# Preconditions: `docker compose up -d postgres backup` (or the full stack) already running —
# scripts/restore.sh itself requires `docker compose config` to succeed from this same directory
# and the `postgres` service to be reachable via `docker compose exec`.

set -u

DB_DUMP=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db)
      DB_DUMP="${2:-}"
      shift 2
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    *)
      echo "drill-restore: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "./docker-compose.yml" ]; then
  echo "drill-restore: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "drill-restore: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi
if [ ! -f "./scripts/restore.sh" ]; then
  echo "drill-restore: scripts/restore.sh not found — run this from the checkout root" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${NEXTTIME_DATA:-}" ]; then
  echo "drill-restore: .env must set NEXTTIME_DATA" >&2
  exit 1
fi

# --------------------------------------------------------------------------------------------
# PASS/FAIL helpers — abort on the first FAIL, same contract accept_s1.sh/accept_s2.sh use.
# --------------------------------------------------------------------------------------------

pass() {
  printf 'PASS %s %s\n' "$1" "$2"
}

fail() {
  printf 'FAIL %s %s\n' "$1" "$2" >&2
  exit 1
}

RESTORE_LOG=$(mktemp /tmp/nt-drill-restore-log.XXXXXX) || {
  echo "drill-restore: mktemp failed" >&2
  exit 1
}
cleanup_tmp() {
  rm -f "$RESTORE_LOG"
}
trap cleanup_tmp EXIT INT TERM

# --------------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------------

preflight_step() {
  running=$(docker compose ps --status running --services 2>/dev/null)
  if [ -z "$running" ]; then
    fail "preflight-services" "docker compose ps returned nothing — is the stack up? (docker compose up -d postgres backup)"
  fi
  if ! printf '%s\n' "$running" | grep -qx "postgres"; then
    fail "preflight-services" "postgres not running — run: docker compose up -d postgres"
  fi
  pass "preflight-services" "postgres running"
}

# Resolves $DB_DUMP: the --db argument if given, else the newest existing dump, else a freshly
# triggered one.
resolve_dump_step() {
  if [ -n "$DB_DUMP" ]; then
    if [ ! -s "$DB_DUMP" ]; then
      fail "resolve-dump" "--db $DB_DUMP not found or empty"
    fi
    pass "resolve-dump" "using --db $DB_DUMP"
    return
  fi

  DB_DIR="${NEXTTIME_DATA}/backups/db"
  newest=""
  if [ -d "$DB_DIR" ]; then
    # POSIX pathname expansion sorts matches in ascending collating order — UTC-timestamped
    # filenames (backup.sh's own convention) therefore sort chronologically; the last match is
    # the newest. `2>/dev/null` + the literal-glob fallback check handles "no matches yet".
    for f in "$DB_DIR"/nexttime-*.dump; do
      [ -e "$f" ] && newest="$f"
    done
  fi

  if [ -n "$newest" ]; then
    DB_DUMP="$newest"
    pass "resolve-dump" "using newest existing dump: $DB_DUMP"
    return
  fi

  echo "drill-restore: no existing dump under $DB_DIR — triggering one now (docker compose run --rm -e BACKUP_NOW=1 backup)"
  backup_out=$(docker compose run --rm -e BACKUP_NOW=1 backup </dev/null 2>&1)
  backup_rc=$?
  if [ "$backup_rc" -ne 0 ]; then
    fail "resolve-dump" "BACKUP_NOW=1 backup run exited $backup_rc: $(printf '%s' "$backup_out" | tail -20)"
  fi

  newest=""
  if [ -d "$DB_DIR" ]; then
    for f in "$DB_DIR"/nexttime-*.dump; do
      [ -e "$f" ] && newest="$f"
    done
  fi
  if [ -z "$newest" ]; then
    fail "resolve-dump" "BACKUP_NOW=1 backup run succeeded but no dump appeared under $DB_DIR"
  fi
  DB_DUMP="$newest"
  pass "resolve-dump" "triggered a fresh backup, using: $DB_DUMP"
}

# Runs the documented restore procedure verbatim (scripts/restore.sh --db <dump>, no
# --target-db — restore.sh's own default is a fresh, never-existed-before nexttime_restore_<ts>,
# so this can never land on the live `nexttime` database), then parses the target database name
# and table count out of restore.sh's own printed summary line rather than re-deriving either —
# a single source of truth for "did the restore actually produce tables".
restore_step() {
  sh scripts/restore.sh --db "$DB_DUMP" </dev/null >"$RESTORE_LOG" 2>&1
  restore_rc=$?
  if [ "$restore_rc" -ne 0 ]; then
    fail "restore" "scripts/restore.sh exited $restore_rc: $(tail -30 "$RESTORE_LOG")"
  fi

  # restore.sh's own line: "restore: 'nexttime_restore_<ts>' now has <N> table(s) in schema public"
  summary_line=$(grep "now has" "$RESTORE_LOG" | tail -1)
  TARGET_DB=$(printf '%s\n' "$summary_line" | sed -n "s/^restore: '\([^']*\)' now has .*/\1/p")
  TABLE_COUNT=$(printf '%s\n' "$summary_line" | sed -n 's/.* now has \([0-9][0-9]*\) table(s).*/\1/p')

  if [ -z "$TARGET_DB" ] || [ -z "$TABLE_COUNT" ]; then
    fail "restore" "could not parse target db/table count from restore.sh output: $(tail -30 "$RESTORE_LOG")"
  fi
  pass "restore" "restored into $TARGET_DB from $DB_DUMP"

  if [ "$TABLE_COUNT" -le 0 ] 2>/dev/null; then
    fail "restore-table-count" "$TARGET_DB has $TABLE_COUNT table(s) in schema public — expected > 0 (empty/corrupt restore)"
  fi
  pass "restore-table-count" "$TARGET_DB has $TABLE_COUNT table(s) in schema public"
}

drop_step() {
  if [ "$KEEP" -eq 1 ]; then
    echo "cleanup: --keep set, leaving $TARGET_DB in place for inspection"
    echo "  docker compose exec -T postgres psql -U nexttime -d $TARGET_DB -c '\\dt'"
    echo "  docker compose exec -T postgres psql -U nexttime -d postgres -c 'DROP DATABASE \"$TARGET_DB\";'"
    return
  fi

  docker compose exec -T postgres psql -U nexttime -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE \"$TARGET_DB\";" </dev/null >/dev/null
  drop_rc=$?
  if [ "$drop_rc" -ne 0 ]; then
    fail "drop-temp-db" "DROP DATABASE \"$TARGET_DB\" exited $drop_rc"
  fi

  still_there=$(docker compose exec -T postgres psql -U nexttime -d postgres -t -A \
    -c "select 1 from pg_database where datname = '$TARGET_DB';" </dev/null 2>/dev/null | tr -d '[:space:]')
  if [ -n "$still_there" ]; then
    fail "drop-temp-db" "$TARGET_DB still present in pg_database after DROP DATABASE"
  fi
  pass "drop-temp-db" "$TARGET_DB dropped"
}

# --------------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------------

preflight_step
resolve_dump_step
restore_step
drop_step

echo "DRILL-RESTORE OK"
exit 0
