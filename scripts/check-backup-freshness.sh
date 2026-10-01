#!/bin/sh
# check-backup-freshness.sh — is the nightly backup actually happening? (closing wave C10,
# 2026-10-01). The `backup` service (deploy/backup/backup.sh) is the platform's backup timer: it
# sleeps until BACKUP_TIME, dumps, prunes, and writes ${NEXTTIME_DATA}/backups/last-success. A
# failed night only shows up in `docker compose logs backup`, which nobody reads — the maintainer
# accepts releases from the console, so a backup that silently stopped would go unnoticed
# indefinitely. This script turns that into a PASS/FAIL that the release apply runs (see
# docs/runbooks/release.md §3 and backup-restore.md) and an operator can run any time.
#
# Usage (on the host, from the checkout root — same conventions as scripts/drill-restore.sh):
#   sh scripts/check-backup-freshness.sh [--max-age-hours N]     (default 26: one daily run + slack)
#
# Checks, each printed as `PASS <step> <detail>` / `FAIL <step> <detail>` (FAIL exits non-zero):
#   backup-service   the `backup` compose service is running (a stopped service writes nothing)
#   last-success     ${NEXTTIME_DATA}/backups/last-success exists and its timestamp is at most
#                    N hours old
#   dump-present     the db dump last-success names is still on disk and non-empty (the service
#                    writes container paths under /data; mapped back to ${NEXTTIME_DATA} here)
# Read-only: never starts, stops, or writes anything.

set -u

MAX_AGE_HOURS=26
while [ $# -gt 0 ]; do
	case "$1" in
	--max-age-hours)
		MAX_AGE_HOURS="${2:-}"
		shift 2
		;;
	*)
		echo "check-backup-freshness: unknown argument: $1" >&2
		exit 1
		;;
	esac
done
case "$MAX_AGE_HOURS" in
'' | *[!0-9]*)
	echo "check-backup-freshness: --max-age-hours needs a whole number of hours" >&2
	exit 1
	;;
esac

if [ ! -f "./docker-compose.yml" ] || [ ! -f "./.env" ]; then
	echo "check-backup-freshness: run this from the checkout root (docker-compose.yml and .env)" >&2
	exit 1
fi
NEXTTIME_DATA=$(grep -E '^NEXTTIME_DATA=' ./.env | tail -1 | cut -d= -f2-)
if [ -z "$NEXTTIME_DATA" ]; then
	echo "check-backup-freshness: .env must set NEXTTIME_DATA" >&2
	exit 1
fi

pass() {
	printf 'PASS %s %s\n' "$1" "$2"
}
fail() {
	printf 'FAIL %s %s\n' "$1" "$2" >&2
	exit 1
}

if docker compose ps --status running --services 2>/dev/null | grep -qx backup; then
	pass "backup-service" "backup service running"
else
	fail "backup-service" "backup service not running — docker compose up -d backup; docker compose logs backup"
fi

LAST_SUCCESS="$NEXTTIME_DATA/backups/last-success"
if [ ! -s "$LAST_SUCCESS" ]; then
	fail "last-success" "$LAST_SUCCESS missing or empty — no backup has ever succeeded here (docker compose logs backup)"
fi
stamp=$(sed -n 's/^timestamp=//p' "$LAST_SUCCESS" | tail -1)
stamp_epoch=$(date -u -d "$stamp" +%s 2>/dev/null) ||
	fail "last-success" "cannot parse timestamp '$stamp' in $LAST_SUCCESS"
# Compared in minutes, so the limit is exact (a 25h59m-old backup is not "25h" under a 25h limit).
age_minutes=$((($(date -u +%s) - stamp_epoch) / 60))
age_text="$((age_minutes / 60))h$((age_minutes % 60))m"
if [ "$age_minutes" -gt $((MAX_AGE_HOURS * 60)) ]; then
	fail "last-success" "last successful backup $stamp is $age_text old (> ${MAX_AGE_HOURS}h) — docker compose logs backup"
fi
pass "last-success" "$stamp ($age_text old, limit ${MAX_AGE_HOURS}h)"

dump_container_path=$(sed -n 's/^db_dump=\([^ ]*\).*/\1/p' "$LAST_SUCCESS" | tail -1)
dump_host_path="$NEXTTIME_DATA${dump_container_path#/data}"
if [ -z "$dump_container_path" ] || [ ! -s "$dump_host_path" ]; then
	fail "dump-present" "last-success names '$dump_container_path' but $dump_host_path is missing or empty"
fi
pass "dump-present" "$dump_host_path ($(wc -c <"$dump_host_path" | tr -d ' ') bytes)"
echo "BACKUP-FRESHNESS OK"
