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
# The real (non-dry-run) DB restore always restores into a database this run has just CREATED,
# so there is never anything of a newer schema left behind to block a DROP or collide with a
# CREATE (2026-10-02 review R-11: the old `pg_restore --clean --if-exists` over the live database
# left objects only a newer release created in place — a rollback across a release that added an
# FK into a dumped table ended up half pre-, half post-upgrade — and reported success anyway).
#
#   1. Live restore (--target-db nexttime --i-know) only: stop kernel/agent-host/
#      worker-supervisor/backup (all four either hold connections to `nexttime` or write into the
#      data this replaces), wait until nothing is connected to `nexttime`, then RENAME it to
#      nexttime_pre_restore_<ts>. Nothing is dropped: the previous database stays intact under that
#      name until an operator drops it, so every failure below leaves a known, recoverable state.
#   2. CREATE DATABASE <target>.
#   3. Copy the dump into the running `postgres` container's /tmp (pg_restore's custom format (-Fc)
#      needs a seekable file, not a pipe) and run
#        pg_restore --exit-on-error --single-transaction -U nexttime -d <target> <path>
#      — all-or-nothing: any error (an unreadable archive, a failed CREATE, a failed COPY) aborts
#      and rolls back the whole restore, and any non-zero exit is fatal.
#   4. Verify that the number of tables in schema public equals the number of `TABLE public`
#      entries in the dump's own TOC (`pg_restore -l`).
#   On a failure in 2–4 the target database this run created is dropped again; for a live restore
#   the kept database is renamed back to `nexttime` before the services restart, so the stack comes
#   back on exactly the data it had. If that rename-back itself fails, the exact commands to finish
#   it by hand are printed.
#
# Only the throwaway-target path is exercised on the host (scripts/drill-restore.sh); the live
# path shares every step except the rename, and is otherwise only exercised by drill-upgrade.sh's
# rollback (docs/runbooks/release.md §6).
#
# The copy is `docker compose exec -T postgres sh -c 'cat > <path>' < <dump>`, not
# `docker compose cp`: since leftover 20 (#188, 2026-09-17) the postgres service is
# `read_only: true`, and the Docker daemon refuses any `cp` into a read-only rootfs ("container
# rootfs is marked read-only") even when the destination is a writable tmpfs — this script failed
# that way from #188 until the 2026-10-01 restore drill caught it (closing wave C10). /tmp is that
# service's own tmpfs (docker-compose.yml), so the copy costs RAM for as long as the restore runs —
# about one dump's size (tens of MB today).
#
# The stopped services are restarted from an EXIT trap (`restart_live_services`), and INT / TERM /
# HUP / PIPE are trapped to `exit`, because dash does not run the EXIT trap on an untrapped signal —
# a Ctrl-C or a dropped ssh session mid-restore would otherwise leave the core services down
# (review L9-8; same pattern as scripts/accept_s1.sh).

set -eu

DB_DUMP=""
TARGET_DB=""
FILES_TGZ=""
DRY_RUN=0
I_KNOW=0
LIVE=0
LIVE_SERVICES_STOPPED=0
PRE_DB=""
TARGET_CREATED=0
CONTAINER_DUMP_PATH=""

psql_admin() {
	docker compose exec -T postgres psql -U nexttime -d postgres -v ON_ERROR_STOP=1 -t -A "$@" </dev/null
}

# Undo whatever this run did to the databases. Called on every failure after the first database
# change; idempotent. For a live restore it drops the half-made `nexttime` and renames the kept
# database back, so the services restart on exactly the data they had.
roll_back_databases() {
	if [ -n "$CONTAINER_DUMP_PATH" ]; then
		docker compose exec -T postgres rm -f "$CONTAINER_DUMP_PATH" </dev/null >/dev/null 2>&1 || true
	fi
	if [ "$TARGET_CREATED" -eq 1 ]; then
		if psql_admin -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";" >/dev/null 2>&1; then
			echo "restore: dropped the database this run created ('$TARGET_DB')" >&2
			TARGET_CREATED=0
		else
			echo "restore: could not drop '$TARGET_DB'" >&2
		fi
	fi
	if [ -n "$PRE_DB" ]; then
		if [ "$TARGET_CREATED" -eq 0 ] && psql_admin -c "ALTER DATABASE \"$PRE_DB\" RENAME TO nexttime;" >/dev/null 2>&1; then
			echo "restore: rolled back — the previous database is 'nexttime' again (nothing was restored)" >&2
			PRE_DB=""
		else
			echo "restore: ROLLBACK INCOMPLETE — the previous database is intact as '$PRE_DB'. Finish by hand:" >&2
			echo "  docker compose exec -T postgres psql -U nexttime -d postgres -c 'DROP DATABASE IF EXISTS nexttime;'" >&2
			echo "  docker compose exec -T postgres psql -U nexttime -d postgres -c 'ALTER DATABASE \"$PRE_DB\" RENAME TO nexttime;'" >&2
		fi
	fi
}

die() {
	echo "restore: FAILED — $1" >&2
	roll_back_databases
	exit 1
}

# Restarts kernel/agent-host/worker-supervisor/backup if (and only if) this run stopped them for
# a live restore — registered as an EXIT trap right after that stop, so it fires whether the
# script succeeds, dies through `die`, or is interrupted (the signal traps turn INT/TERM/HUP/PIPE
# into an `exit`). A no-op for a dry-run or a throwaway-target restore.
restart_live_services() {
	if [ "$LIVE_SERVICES_STOPPED" -eq 1 ]; then
		echo "restore: restarting kernel/agent-host/worker-supervisor/backup"
		docker compose start kernel agent-host worker-supervisor backup
	fi
}

on_signal() {
	echo "restore: interrupted" >&2
	roll_back_databases
	exit 130
}

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
	echo "         directory (the checkout root, e.g. cd <CODE_DIR> first)." >&2
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
if [ "$TARGET_DB" = "nexttime" ]; then
	LIVE=1
fi

DB_DUMP_ABS=$(cd "$(dirname "$DB_DUMP")" && pwd)/$(basename "$DB_DUMP")

echo "restore: dump        = $DB_DUMP_ABS"
echo "restore: target db   = $TARGET_DB$([ "$LIVE" -eq 1 ] && echo ' (LIVE — --i-know)')"
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
	tables=$(grep -c ' TABLE public ' /tmp/restore-toc.$$ || true)
	echo "restore: [dry-run] OK — $entries TOC entries, $tables table(s) in schema public. First 15:"
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
	echo "restore: [dry-run] would restore into a freshly created database '$TARGET_DB' with:"
	[ "$LIVE" -eq 1 ] && echo "  (live: stop kernel/agent-host/worker-supervisor/backup, rename 'nexttime' to nexttime_pre_restore_<ts>)"
	echo "  docker compose exec -T postgres pg_restore --exit-on-error --single-transaction -U nexttime -d $TARGET_DB <copied dump>"
	[ -n "$FILES_TGZ" ] && echo "  extract '$FILES_TGZ' into \$NEXTTIME_DATA/restore/$ts/ (staging, not the live dirs)"
	echo "restore: [dry-run] no database or filesystem changes made."
	exit 0
fi

trap on_signal INT TERM HUP PIPE

# --- real restore, step 1 (live only): set the live database aside -------------------------
if [ "$LIVE" -eq 1 ]; then
	echo "restore: live restore — stopping kernel, agent-host, worker-supervisor, backup first" >&2
	echo "         (they hold connections to, or write into, the data this replaces; restarted" >&2
	echo "         automatically when this script exits, success or failure)." >&2
	docker compose stop kernel agent-host worker-supervisor backup
	LIVE_SERVICES_STOPPED=1
	trap restart_live_services EXIT

	# The postgres healthcheck's pg_isready and any connection the stopped services left behind
	# can briefly hold `nexttime`; ALTER DATABASE … RENAME refuses while anything is connected.
	waited=0
	while :; do
		connected=$(psql_admin -c "select count(*) from pg_stat_activity where datname = 'nexttime';" | tr -d '[:space:]')
		[ "$connected" = "0" ] && break
		waited=$((waited + 1))
		if [ "$waited" -ge 15 ]; then
			echo "restore: still connected to 'nexttime' after 15 s:" >&2
			psql_admin -c "select coalesce(nullif(application_name, ''), '?') || ' from ' || coalesce(client_addr::text, 'local') from pg_stat_activity where datname = 'nexttime';" >&2 || true
			die "could not set the live database aside — nothing was changed"
		fi
		sleep 1
	done

	PRE_DB="nexttime_pre_restore_$ts"
	if ! psql_admin -c "ALTER DATABASE nexttime RENAME TO \"$PRE_DB\";" >/dev/null; then
		PRE_DB=""
		die "ALTER DATABASE nexttime RENAME failed — nothing was changed"
	fi
	echo "restore: previous live database kept as '$PRE_DB'"
fi

# --- step 2: create the target -------------------------------------------------------------
echo "restore: creating database '$TARGET_DB'"
if ! psql_admin -c "CREATE DATABASE \"$TARGET_DB\" OWNER nexttime;" >/dev/null; then
	die "CREATE DATABASE \"$TARGET_DB\" failed"
fi
TARGET_CREATED=1

# --- step 3: restore, all or nothing -------------------------------------------------------
CONTAINER_DUMP_PATH="/tmp/restore-$ts.dump"
echo "restore: copying dump into the postgres container ($CONTAINER_DUMP_PATH)"
# Not `docker compose cp` — refused for a read_only service (this file's header comment).
if ! docker compose exec -T postgres sh -c "cat > '$CONTAINER_DUMP_PATH'" <"$DB_DUMP_ABS"; then
	die "could not copy the dump into the postgres container"
fi

expected_tables=$(docker compose exec -T postgres pg_restore -l "$CONTAINER_DUMP_PATH" </dev/null | grep -c ' TABLE public ' || true)
if [ "${expected_tables:-0}" -le 0 ]; then
	die "the dump's TOC lists no table in schema public — not a usable nexttime dump"
fi

echo "restore: running pg_restore --exit-on-error --single-transaction -d $TARGET_DB"
if ! docker compose exec -T postgres pg_restore --exit-on-error --single-transaction -U nexttime -d "$TARGET_DB" "$CONTAINER_DUMP_PATH" </dev/null; then
	die "pg_restore failed (the single transaction rolled back; see its output above)"
fi

docker compose exec -T postgres rm -f "$CONTAINER_DUMP_PATH" </dev/null
CONTAINER_DUMP_PATH=""

# --- step 4: verify against the dump's own TOC ---------------------------------------------
table_count=$(docker compose exec -T postgres psql -U nexttime -d "$TARGET_DB" -t -A \
	-c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p');" </dev/null | tr -d '[:space:]')
echo "restore: '$TARGET_DB' now has $table_count table(s) in schema public (the dump's TOC lists $expected_tables)"
if [ "$table_count" != "$expected_tables" ]; then
	die "restored $table_count table(s) but the dump lists $expected_tables"
fi
# The restore is complete and verified; from here on a failure no longer rolls the database back.
TARGET_CREATED=0

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
echo "  target db:  $TARGET_DB ($table_count tables, matches the dump)"
[ -n "$FILES_TGZ" ] && [ -n "${NEXTTIME_DATA:-}" ] && echo "  files:      staged at \$NEXTTIME_DATA/restore/$ts/"
if [ "$LIVE" -eq 1 ]; then
	echo "  previous:   kept as '$PRE_DB' — drop it once the restored stack is verified:"
	echo "              docker compose exec -T postgres psql -U nexttime -d postgres -c 'DROP DATABASE \"$PRE_DB\";'"
	PRE_DB=""
else
	echo "  cleanup:    drop the throwaway database when done: docker compose exec -T postgres psql -U nexttime -d postgres -c 'DROP DATABASE \"$TARGET_DB\";'"
fi
echo "restore: done"
