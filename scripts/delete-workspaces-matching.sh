#!/bin/sh
# delete-workspaces-matching.sh - lists every Workspace whose name matches a regex (via the
# kernel bootstrap CLI's `list-workspaces` subcommand), prints the matches, and - only with
# --yes - loops scripts/delete-workspace.sh over every one of them.
#
# Usage (from the compose project directory):
#   sh scripts/delete-workspaces-matching.sh '<regex>' [--yes]
#
# Without --yes: lists matches only, deletes nothing (a safe dry run - review the printed list
# before re-running the identical command with --yes appended).
#
# The regex is a POSIX extended regular expression (awk), matched against the workspace NAME
# column only, unanchored unless the pattern itself anchors (e.g. a leading ^) - the same
# convention the kernel bootstrap CLI's own delete-workspace --allow-name-pattern flag uses.
#
# Safety: this is a bulk, irreversible operation across every matching workspace. Double-check
# the regex does not match the operator's own long-lived workspace (e.g. a web-console smoke
# workspace) before passing --yes - see docs/runbooks/host-bootstrap.md "Deleting a workspace".

set -u

PATTERN="${1:-}"
if [ -z "$PATTERN" ]; then
	echo "delete-workspaces-matching: usage: sh scripts/delete-workspaces-matching.sh '<regex>' [--yes]" >&2
	exit 1
fi
shift

CONFIRM=0
if [ "${1:-}" = "--yes" ]; then
	CONFIRM=1
	shift
fi

if [ $# -gt 0 ]; then
	echo "delete-workspaces-matching: unknown argument: $1" >&2
	exit 1
fi

if ! docker compose config >/dev/null 2>&1; then
	echo "delete-workspaces-matching: 'docker compose config' failed - run this script from the compose project directory" >&2
	exit 1
fi

LIST=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js list-workspaces </dev/null)
RC=$?
if [ "$RC" -ne 0 ]; then
	echo "delete-workspaces-matching: list-workspaces exited $RC" >&2
	echo "$LIST" >&2
	exit "$RC"
fi

MATCHES=$(printf '%s\n' "$LIST" | tail -n +2 | awk -F '\t' -v pat="$PATTERN" '$2 ~ pat { print $1 "\t" $2 }')

if [ -z "$MATCHES" ]; then
	echo "delete-workspaces-matching: no workspace name matches '$PATTERN'"
	exit 0
fi

echo "delete-workspaces-matching: workspaces matching '$PATTERN':"
printf '%s\n' "$MATCHES" | awk -F '\t' '{ printf "  %s  %s\n", $1, $2 }'
MATCH_COUNT=$(printf '%s\n' "$MATCHES" | wc -l | tr -d ' ')
echo "delete-workspaces-matching: $MATCH_COUNT workspace(s) matched"

if [ "$CONFIRM" -ne 1 ]; then
	echo "delete-workspaces-matching: dry run (no --yes) - nothing deleted. Re-run with --yes to delete the workspaces listed above."
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
echo "delete-workspaces-matching: deleting $MATCH_COUNT workspace(s) ..."

while IFS="$TAB" read -r id name; do
	echo ""
	echo "delete-workspaces-matching: -> $id ($name)"
	if sh "$SELF_DIR/delete-workspace.sh" "$id" --name "$name"; then
		DELETED=$((DELETED + 1))
	else
		echo "delete-workspaces-matching: failed to delete $id ($name)" >&2
		FAILED=1
	fi
done <"$TMP_MATCHES"

echo ""
if [ "$FAILED" -ne 0 ]; then
	echo "delete-workspaces-matching: $DELETED/$MATCH_COUNT workspace(s) deleted - one or more deletions failed, see above" >&2
	exit 1
fi

echo "delete-workspaces-matching: done - $DELETED workspace(s) deleted"
