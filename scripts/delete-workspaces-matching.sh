#!/bin/sh
# delete-workspaces-matching.sh - lists every Workspace whose name matches a regex, OR (S5.3 /
# S6) every Workspace the governed purge would accept right now, prints the matches, and - only
# with --yes - loops scripts/delete-workspace.sh over every one of them.
#
# Usage (from the compose project directory):
#   sh scripts/delete-workspaces-matching.sh '<regex>' [--yes] [--force] [--actor <login>]
#   sh scripts/delete-workspaces-matching.sh --expired [--yes] [--include-disabled] [--actor <login>]
#
# Without --yes: lists matches only, deletes nothing (a safe dry run - review the printed list
# before re-running the identical command with --yes appended).
#
# The regex is a POSIX extended regular expression (awk), matched against the workspace NAME
# column only, unanchored unless the pattern itself anchors (e.g. a leading ^) - the same
# convention the kernel bootstrap CLI's own delete-workspace --allow-name-pattern flag uses.
#
# --expired selects through the kernel bootstrap CLI's `purge-expired-workspaces` subcommand
# (S6, docs/console-completion-plan.md §5.2 - the `purge_workspace` capability's own eligibility
# rule, evaluated on the database's clock): every `ephemeral` workspace whose `expires_at` has
# passed - a `standard` workspace is never selected, whatever its name - and, with
# --include-disabled, every workspace disabled for 7 days or more (or disabled before migration
# core 0030). The platform default workspace is never selected.
#
# Each match is purged by scripts/delete-workspace.sh, i.e. the governed `purge-workspace` path:
# a regex match that is still active, or disabled for less than 7 days, is REFUSED by the kernel
# (reported, counted as failed, the loop continues). --force passes scripts/delete-workspace.sh's
# own --force through (the legacy `delete-workspace` override that skips the preconditions) -
# only meaningful in regex mode, and only when you have reviewed the printed list.
#
# Safety: this is a bulk, irreversible operation across every matching workspace. Double-check
# the regex does not match the operator's own long-lived workspace (e.g. a web-console smoke
# workspace) before passing --yes - see docs/runbooks/host-bootstrap.md "Deleting a workspace"
# and docs/runbooks/operations.md "工作区清除".

set -u

PATTERN="${1:-}"
if [ -z "$PATTERN" ]; then
	echo "delete-workspaces-matching: usage: sh scripts/delete-workspaces-matching.sh '<regex>' [--yes] [--force] [--actor <login>]" >&2
	echo "                                   sh scripts/delete-workspaces-matching.sh --expired [--yes] [--include-disabled] [--actor <login>]" >&2
	exit 1
fi
shift
EXPIRED=0
if [ "$PATTERN" = "--expired" ]; then
	EXPIRED=1
fi

CONFIRM=0
FORCE=0
INCLUDE_DISABLED=0
ACTOR=""
while [ $# -gt 0 ]; do
	case "$1" in
		--yes)
			CONFIRM=1
			shift
			;;
		--force)
			FORCE=1
			shift
			;;
		--include-disabled)
			INCLUDE_DISABLED=1
			shift
			;;
		--actor)
			ACTOR="${2:-}"
			if [ -z "$ACTOR" ]; then
				echo "delete-workspaces-matching: --actor requires a value" >&2
				exit 1
			fi
			shift 2
			;;
		*)
			echo "delete-workspaces-matching: unknown argument: $1" >&2
			exit 1
			;;
	esac
done

if [ "$EXPIRED" -eq 1 ] && [ "$FORCE" -eq 1 ]; then
	echo "delete-workspaces-matching: --force is a regex-mode flag (--expired only ever selects workspaces the governed purge accepts)" >&2
	exit 1
fi
if [ "$EXPIRED" -eq 0 ] && [ "$INCLUDE_DISABLED" -eq 1 ]; then
	echo "delete-workspaces-matching: --include-disabled only applies to --expired" >&2
	exit 1
fi

if ! docker compose config >/dev/null 2>&1; then
	echo "delete-workspaces-matching: 'docker compose config' failed - run this script from the compose project directory" >&2
	exit 1
fi

if [ "$EXPIRED" -eq 1 ]; then
	# Selection lives in the kernel (`purge-expired-workspaces` without --yes prints
	# `WORKSPACE=<id>\t<name>\t<reason>` per candidate on stdout and nothing else there).
	if [ "$INCLUDE_DISABLED" -eq 1 ]; then
		SELECTION="purgeable workspaces (expired ephemeral, or disabled >= 7 days)"
		set -- purge-expired-workspaces --include-disabled
	else
		SELECTION="expired ephemeral workspaces"
		set -- purge-expired-workspaces
	fi
	LIST=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js "$@" </dev/null)
	RC=$?
	if [ "$RC" -ne 0 ]; then
		echo "delete-workspaces-matching: purge-expired-workspaces exited $RC" >&2
		echo "$LIST" >&2
		exit "$RC"
	fi
	MATCHES=$(printf '%s\n' "$LIST" | sed -n 's/^WORKSPACE=//p' | awk -F '\t' '{ print $1 "\t" $2 }')
else
	LIST=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js list-workspaces </dev/null)
	RC=$?
	if [ "$RC" -ne 0 ]; then
		echo "delete-workspaces-matching: list-workspaces exited $RC" >&2
		echo "$LIST" >&2
		exit "$RC"
	fi
	MATCHES=$(printf '%s\n' "$LIST" | tail -n +2 | awk -F '\t' -v pat="$PATTERN" '$2 ~ pat { print $1 "\t" $2 }')
	SELECTION="workspaces matching '$PATTERN'"
fi

if [ -z "$MATCHES" ]; then
	echo "delete-workspaces-matching: no $SELECTION"
	exit 0
fi

echo "delete-workspaces-matching: $SELECTION:"
printf '%s\n' "$MATCHES" | awk -F '\t' '{ printf "  %s  %s\n", $1, $2 }'
MATCH_COUNT=$(printf '%s\n' "$MATCHES" | wc -l | tr -d ' ')
echo "delete-workspaces-matching: $MATCH_COUNT workspace(s) matched"

if [ "$CONFIRM" -ne 1 ]; then
	echo "delete-workspaces-matching: dry run (no --yes) - nothing deleted. Re-run with --yes to purge the workspaces listed above."
	exit 0
fi

SELF_DIR=$(dirname "$0")
TMP_MATCHES="/tmp/delete-workspaces-matching.$$"
trap 'rm -f "$TMP_MATCHES"' EXIT
printf '%s\n' "$MATCHES" >"$TMP_MATCHES"

TAB=$(printf '\t')
FAILED=0
DELETED=0

echo ""
echo "delete-workspaces-matching: purging $MATCH_COUNT workspace(s) ..."

while IFS="$TAB" read -r id name; do
	echo ""
	echo "delete-workspaces-matching: -> $id ($name)"
	set -- "$id" --name "$name"
	if [ "$FORCE" -eq 1 ]; then
		set -- "$@" --force
	fi
	if [ -n "$ACTOR" ]; then
		set -- "$@" --actor "$ACTOR"
	fi
	if sh "$SELF_DIR/delete-workspace.sh" "$@"; then
		DELETED=$((DELETED + 1))
	else
		echo "delete-workspaces-matching: failed to purge $id ($name)" >&2
		FAILED=1
	fi
done <"$TMP_MATCHES"

echo ""
if [ "$FAILED" -ne 0 ]; then
	echo "delete-workspaces-matching: $DELETED/$MATCH_COUNT workspace(s) purged - one or more purges failed or were refused, see above" >&2
	exit 1
fi

echo "delete-workspaces-matching: done - $DELETED workspace(s) purged"
