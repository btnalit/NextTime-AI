#!/bin/sh
# backup.sh — daily pg_dump + files tar for the platform's `backup` service (design doc
# §10.2/§10.4/§13; task S1.12). Runs inside the `postgres:17-alpine` image (has pg_dump,
# pg_isready, tar, gzip — no rsync, no cron), as the container's entrypoint.
#
# Two modes:
#   - BACKUP_NOW=1: run exactly one backup and exit (exit code reflects success/failure). Used
#     for manual runs and verification.
#   - default: loop forever, sleeping until the next daily BACKUP_TIME (in the container's TZ),
#     running one backup each time it arrives. A failed backup is logged and the loop continues
#     to the next scheduled time (the container itself must not die and restart-loop just
#     because one night's dump failed).
#
# Env (all optional, defaults shown):
#   TZ=UTC                 — controls both log timestamps' wall-clock reading and BACKUP_TIME.
#   BACKUP_TIME=03:30      — HH:MM, 24h, in $TZ.
#   RETENTION=7            — dumps/tarballs to keep, counted independently per category.
#   PGHOST=postgres  PGUSER=nexttime  PGDATABASE=nexttime
#   PG_PASSWORD_FILE=/run/secrets/pg_password  — Docker secret mount (see compose `secrets:
#     [pg_password]`); trailing newline stripped via command substitution.
#   DATA_DIR=/data         — bind mount of ${NEXTTIME_DATA} (compose: "${NEXTTIME_DATA}:/data").
#
# One backup = one pg_dump custom-format dump of the whole `nexttime` DB, plus one tar.gz of
# workspaces/ config/ (never secrets/ — it holds credentials, not backup content).
# Both land under $DATA_DIR/backups/{db,files}/, named with a UTC timestamp so lexical sort ==
# chronological order (used by the retention step below).

set -eu

TZ="${TZ:-UTC}"
export TZ
BACKUP_TIME="${BACKUP_TIME:-03:30}"
RETENTION="${RETENTION:-7}"
PGHOST="${PGHOST:-postgres}"
PGUSER="${PGUSER:-nexttime}"
PGDATABASE="${PGDATABASE:-nexttime}"
PG_PASSWORD_FILE="${PG_PASSWORD_FILE:-/run/secrets/pg_password}"
DATA_DIR="${DATA_DIR:-/data}"

DB_DIR="$DATA_DIR/backups/db"
FILES_DIR="$DATA_DIR/backups/files"
LAST_SUCCESS_FILE="$DATA_DIR/backups/last-success"

log() {
	echo "[backup] $(date -u +'%Y-%m-%dT%H:%M:%SZ') $*"
}

# --- prune: keep only the newest $3 files matching glob "$1/$2" ------------------------------
# POSIX pathname expansion returns matches sorted in ascending collating order, and our
# filenames embed a UTC timestamp (nexttime-<ts>.dump, files-<ts>.tgz), so ascending sort ==
# oldest-first. No reliance on GNU `head -n -K` or `ls`/`sort` piping (busybox `head` on this
# image does not reliably support negative counts).
prune() {
	_dir=$1
	_pat=$2
	_keep=$3
	set -- "$_dir"/$_pat
	[ -e "$1" ] || return 0
	_count=$#
	if [ "$_count" -gt "$_keep" ]; then
		_remove=$((_count - _keep))
		_i=0
		for _f in "$@"; do
			_i=$((_i + 1))
			[ "$_i" -gt "$_remove" ] && break
			rm -f "$_f"
			log "retention: pruned $_f (keeping newest $_keep in $_dir)"
		done
	fi
}

# --- run_backup: one dump + one tar + retention + last-success. Returns non-zero on any --------
# failure; every step logs to stdout so `docker compose logs backup` shows what happened.
run_backup() {
	mkdir -p "$DB_DIR" "$FILES_DIR"

	if [ ! -s "$PG_PASSWORD_FILE" ]; then
		log "ERROR: password file $PG_PASSWORD_FILE missing or empty"
		return 1
	fi
	PGPASSWORD=$(cat "$PG_PASSWORD_FILE")
	export PGPASSWORD

	# postgres should already be healthy (compose `depends_on: postgres: condition:
	# service_healthy`), but a manual `docker compose run` can race a fresh `up -d` — wait up to
	# ~30s before giving up.
	_tries=0
	until pg_isready -h "$PGHOST" -U "$PGUSER" >/dev/null 2>&1; do
		_tries=$((_tries + 1))
		if [ "$_tries" -ge 15 ]; then
			log "ERROR: $PGHOST:5432 not ready after ${_tries}s"
			unset PGPASSWORD
			return 1
		fi
		sleep 2
	done

	ts=$(date -u +%Y%m%dT%H%M%SZ)
	dump_file="$DB_DIR/nexttime-$ts.dump"
	tar_file="$FILES_DIR/files-$ts.tgz"

	log "starting: pg_dump $PGDATABASE -> $dump_file"
	if ! pg_dump -Fc -h "$PGHOST" -U "$PGUSER" "$PGDATABASE" >"$dump_file.tmp" 2>/tmp/pg_dump.err; then
		log "ERROR: pg_dump failed: $(cat /tmp/pg_dump.err 2>/dev/null)"
		rm -f "$dump_file.tmp"
		unset PGPASSWORD
		return 1
	fi
	mv "$dump_file.tmp" "$dump_file"
	unset PGPASSWORD
	dump_size=$(wc -c <"$dump_file" | tr -d ' ')
	log "ok: $dump_file ($dump_size bytes)"

	# Only workspaces/ config/ — never secrets/ (credentials, not backup content).
	log "starting: tar workspaces config -> $tar_file"
	tar_sources=""
	for d in workspaces config; do
		[ -d "$DATA_DIR/$d" ] && tar_sources="$tar_sources $d"
	done
	if [ -z "$tar_sources" ]; then
		log "ERROR: none of workspaces/ config/ exist under $DATA_DIR"
		return 1
	fi
	# shellcheck disable=SC2086
	if ! tar -czf "$tar_file.tmp" -C "$DATA_DIR" $tar_sources 2>/tmp/tar.err; then
		log "ERROR: tar failed: $(cat /tmp/tar.err 2>/dev/null)"
		rm -f "$tar_file.tmp"
		return 1
	fi
	mv "$tar_file.tmp" "$tar_file"
	tar_size=$(wc -c <"$tar_file" | tr -d ' ')
	log "ok: $tar_file ($tar_size bytes)"

	prune "$DB_DIR" "nexttime-*.dump" "$RETENTION"
	prune "$FILES_DIR" "files-*.tgz" "$RETENTION"

	{
		echo "timestamp=$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
		echo "db_dump=$dump_file size=$dump_size"
		echo "files_tar=$tar_file size=$tar_size"
	} >"$LAST_SUCCESS_FILE"
	log "last-success written: $LAST_SUCCESS_FILE"

	return 0
}

# --- seconds_until: seconds from now until the next $1 (HH:MM, in $TZ), today or tomorrow ----
# Arithmetic on "seconds since local midnight" via `date +%H/%M/%S` (which honors $TZ) rather
# than `date -d`, whose input-format support varies across busybox builds. `10#` forces base-10
# so a zero-padded field like "08" isn't misread as an invalid octal literal.
seconds_until() {
	_hh=${1%%:*}
	_mm=${1##*:}
	_now_hh=$(date +%H)
	_now_mm=$(date +%M)
	_now_ss=$(date +%S)
	_now_sod=$((10#$_now_hh * 3600 + 10#$_now_mm * 60 + 10#$_now_ss))
	_target_sod=$((10#$_hh * 3600 + 10#$_mm * 60))
	if [ "$_target_sod" -gt "$_now_sod" ]; then
		echo $((_target_sod - _now_sod))
	else
		echo $((86400 - _now_sod + _target_sod))
	fi
}

if [ "${BACKUP_NOW:-0}" = "1" ]; then
	log "BACKUP_NOW=1: running one backup and exiting"
	if run_backup; then
		log "backup ok"
		exit 0
	fi
	log "ERROR: backup failed"
	exit 1
fi

log "daily backup loop: BACKUP_TIME=$BACKUP_TIME TZ=$TZ RETENTION=$RETENTION PGHOST=$PGHOST"
while true; do
	delta=$(seconds_until "$BACKUP_TIME")
	log "sleeping ${delta}s until next backup ($BACKUP_TIME $TZ)"
	sleep "$delta"
	if run_backup; then
		log "backup ok"
	else
		log "ERROR: backup failed, will retry at next scheduled time ($BACKUP_TIME $TZ)"
	fi
done
