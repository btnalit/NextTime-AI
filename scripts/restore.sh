#!/bin/sh
# restore.sh — restore a backup produced by deploy/backup/backup.sh (task S1.12; design doc
# §10.4/§13). Runs ON THE HOST (not inside a container) from the compose project directory
# (the checkout root — same place `docker compose` commands are normally run from), and drives
# the already-running `postgres` service via `docker compose exec`.
#
# Usage:
#   sh scripts/restore.sh --db <dump-file> [--target-db <name>] [--files <tgz>] [--dry-run]
#
#   --db <dump-file>     (required) a $NEXTTIME_DATA/backups/db/nexttime-<ts>.dump produced by
#                         backup.sh (pg_dump -Fc).
#   --target-db <name>   database to restore into. Default: a fresh, never-existed-before
#                         nexttime_restore_<UTC ts> — NEVER the live `nexttime` unless you pass
#                         `--target-db nexttime --i-know` explicitly (both flags required).
#   --i-know              required in addition to `--target-db nexttime` to restore over the
#                         live database. Refused otherwise.
#   --files <tgz>         also restore a $NEXTTIME_DATA/backups/files/files-<ts>.tgz — extracted
#                         into a staging dir ($NEXTTIME_DATA/restore/<ts>/), never over the live
#                         workspaces/ config/ directories. Requires NEXTTIME_DATA set
#                         in the environment.
#   --dry-run              validate only: `pg_restore -l` the dump's TOC (via a throwaway
#                         postgres:17-alpine container — the live postgres service is never
#                         touched) and, if --files given, `tar -tzf` the tarball's listing. No
#                         database or filesystem changes.
#
# The real (non-dry-run) DB restore: creates the target database (unless --target-db nexttime
# --i-know, where it's assumed to already exist), copies the dump into the running `postgres`
# container with `docker compose cp` (pg_restore's custom format (-Fc) needs a seekable file,
# not a pipe, so this is more robust than trying to stream it over `docker compose exec -T`'s
# stdin), then runs:
#   docker compose exec -T postgres pg_restore --clean --if-exists -U nexttime -d <target> <path>
# and removes the copied file from the container afterward.

set -eu

DB_DUMP=""
TARGET_DB=""
FILES_TGZ=""
DRY_RUN=0
I_KNOW=0

usage() {
	cat >&2 <<'EOF'
usage: restore.sh --db <dump-file> [--target-db <name>] [--files <tgz>] [--dry-run] [--i-know]
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--db)
			DB_DUMP="${2:-}"
			shift 2
			;;
		--target-db)
			TARGET_DB="${2:-}"
			shift 2
			;;
		--files)
			FILES_TGZ="${2:-}"
			shift 2
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		--i-know)
			I_KNOW=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "restore: unknown argument: $1" >&2
			usage
			exit 1
			;;
	esac
done

if [ -z "$DB_DUMP" ]; then
	echo "restore: --db <dump-file> is required" >&2
	usage
	exit 1
fi

if [ ! -s "$DB_DUMP" ]; then
	echo "restore: dump file not found or empty: $DB_DUMP" >&2
	exit 1
fi

# --- must be run from the compose project directory (docker compose reads ./docker-compose.yml
# and ./.env from cwd) --------------------------------------------------------------------------
if ! docker compose config >/dev/null 2>&1; then
	echo "restore: 'docker compose config' failed — run this script from the compose project" >&2
	echo "         directory (the checkout root, e.g. cd /opt/NextTime-AI first)." >&2
	exit 1
fi

ts=$(date -u +%Y%m%dT%H%M%SZ)
if [ -z "$TARGET_DB" ]; then
	TARGET_DB="nexttime_restore_$ts"
fi

if [ "$TARGET_DB" = "nexttime" ] && [ "$I_KNOW" -ne 1 ]; then
	echo "restore: refusing to restore over the live 'nexttime' database." >&2
	echo "         pass --target-db nexttime --i-know if you really mean it." >&2
	exit 1
fi

DB_DUMP_ABS=$(cd "$(dirname "$DB_DUMP")" && pwd)/$(basename "$DB_DUMP")

echo "restore: dump        = $DB_DUMP_ABS"
echo "restore: target db   = $TARGET_DB$([ "$TARGET_DB" = nexttime ] && echo ' (LIVE — --i-know)')"
[ -n "$FILES_TGZ" ] && echo "restore: files tgz   = $FILES_TGZ"
echo "restore: mode        = $([ "$DRY_RUN" -eq 1 ] && echo 'dry-run (validate only)' || echo 'real restore')"
echo ""

# --- dry-run: validate only, never touches the live postgres service ---------------------------
if [ "$DRY_RUN" -eq 1 ]; then
	echo "restore: [dry-run] validating dump TOC with pg_restore -l (postgres:17-alpine, throwaway container)"
	if ! docker run --rm -v "$DB_DUMP_ABS:/restore.dump:ro" postgres:17-alpine pg_restore -l /restore.dump >/tmp/restore-toc.$$; then
		echo "restore: [dry-run] FAILED — dump does not look like a valid pg_dump -Fc archive" >&2
		rm -f /tmp/restore-toc.$$
		exit 1
	fi
	entries=$(wc -l </tmp/restore-toc.$$ | tr -d ' ')
	echo "restore: [dry-run] OK — $entries TOC entries. First 15:"
	head -n 15 /tmp/restore-toc.$$
	rm -f /tmp/restore-toc.$$

	if [ -n "$FILES_TGZ" ]; then
		echo ""
		echo "restore: [dry-run] validating files tarball listing (tar -tzf)"
		if ! tar -tzf "$FILES_TGZ" >/tmp/restore-tar.$$; then
			echo "restore: [dry-run] FAILED — not a valid tar.gz" >&2
			rm -f /tmp/restore-tar.$$
			exit 1
		fi
		fcount=$(wc -l </tmp/restore-tar.$$ | tr -d ' ')
		echo "restore: [dry-run] OK — $fcount entries. First 15:"
		head -n 15 /tmp/restore-tar.$$
		rm -f /tmp/restore-tar.$$
	fi

	echo ""
	echo "restore: [dry-run] would restore into database '$TARGET_DB' with:"
	echo "  docker compose exec -T postgres pg_restore --clean --if-exists -U nexttime -d $TARGET_DB <copied dump>"
	[ -n "$FILES_TGZ" ] && echo "  extract '$FILES_TGZ' into \$NEXTTIME_DATA/restore/$ts/ (staging, not the live dirs)"
	echo "restore: [dry-run] no database or filesystem changes made."
	exit 0
fi

# --- real restore: DB ----------------------------------------------------------------------
if [ "$TARGET_DB" != "nexttime" ] || [ "$I_KNOW" -ne 1 ]; then
	# Fresh throwaway target: create it now. (The nexttime/--i-know case skips this — that
	# database is assumed to already exist and --clean --if-exists will handle prior objects.)
	echo "restore: creating database '$TARGET_DB'"
	docker compose exec -T postgres psql -U nexttime -d postgres -v ON_ERROR_STOP=1 \
		-c "CREATE DATABASE \"$TARGET_DB\" OWNER nexttime;"
fi

CONTAINER_DUMP_PATH="/tmp/restore-$ts.dump"
echo "restore: copying dump into the postgres container ($CONTAINER_DUMP_PATH)"
docker compose cp "$DB_DUMP_ABS" "postgres:$CONTAINER_DUMP_PATH"

echo "restore: running pg_restore --clean --if-exists -d $TARGET_DB"
restore_rc=0
docker compose exec -T postgres pg_restore --clean --if-exists -U nexttime -d "$TARGET_DB" "$CONTAINER_DUMP_PATH" || restore_rc=$?

echo "restore: removing copied dump from the container"
docker compose exec -T postgres rm -f "$CONTAINER_DUMP_PATH"

# pg_restore exits 1 on mere warnings (e.g. "role does not exist" for ownership it can't set on
# a differently-named throwaway db) as well as on real failures — surface it but don't treat
# exit 1 alone as fatal; only abort on higher/other unexpected codes. Table counts below are the
# real signal for whether the restore produced usable data.
if [ "$restore_rc" -gt 1 ]; then
	echo "restore: pg_restore exited $restore_rc (fatal)" >&2
	exit "$restore_rc"
elif [ "$restore_rc" -eq 1 ]; then
	echo "restore: pg_restore exited 1 (warnings — see output above; verifying table count below)"
fi

table_count=$(docker compose exec -T postgres psql -U nexttime -d "$TARGET_DB" -t -A \
	-c "select count(*) from information_schema.tables where table_schema='public';" | tr -d '[:space:]')
echo "restore: '$TARGET_DB' now has $table_count table(s) in schema public"

# --- real restore: files (optional) ---------------------------------------------------------
if [ -n "$FILES_TGZ" ]; then
	if [ -z "${NEXTTIME_DATA:-}" ]; then
		echo "restore: --files given but NEXTTIME_DATA is not set in the environment; skipping files restore" >&2
	else
		STAGE_DIR="$NEXTTIME_DATA/restore/$ts"
		echo "restore: extracting '$FILES_TGZ' into staging dir $STAGE_DIR (not the live dirs)"
		mkdir -p "$STAGE_DIR"
		tar -xzf "$FILES_TGZ" -C "$STAGE_DIR"
		echo "restore: files staged at $STAGE_DIR — review and copy into place manually; nothing live was touched"
	fi
fi

echo ""
echo "restore: summary"
echo "  dump:       $DB_DUMP_ABS"
echo "  target db:  $TARGET_DB ($table_count tables)"
[ -n "$FILES_TGZ" ] && [ -n "${NEXTTIME_DATA:-}" ] && echo "  files:      staged at \$NEXTTIME_DATA/restore/$ts/"
echo "  cleanup:    drop the throwaway database when done: docker compose exec -T postgres psql -U nexttime -d postgres -c 'DROP DATABASE \"$TARGET_DB\";'"
echo "restore: done"
