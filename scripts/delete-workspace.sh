#!/bin/sh
# delete-workspace.sh - operator-only, destructive: deletes one Workspace (via the kernel
# bootstrap CLI's `delete-workspace` subcommand) and the matching host-side state - each of its
# Principals' stopped resident entry container and workspace data directory, and each of its
# Tasks' data directory.
#
# Usage (from the compose project directory - this script drives `docker compose run`):
#   sh scripts/delete-workspace.sh <workspaceId> [--name <expected name>]
#
#   <workspaceId>           required - the Workspace to delete.
#   --name <expected name>  optional - forwarded to the kernel CLI's own --name guard (refuses
#                           unless it equals the workspace's actual stored name; protects against
#                           a pasted-wrong-id mistake).
#
# What this removes, in order:
#   1. The Workspace row and every row any workspace-scoped table in Postgres holds for it - one
#      transaction, FK-safe order (kernel bootstrap CLI's `delete-workspace` subcommand).
#   2. Each Principal's resident entry container that belonged to it (docker rm -f; ignored if
#      already stopped/removed).
#   3. Each Principal's data directory under $NEXTTIME_DATA/workspaces/<principalId>.
#   4. Each Task's data directory under $NEXTTIME_DATA/workspaces/tasks/<taskId>.
#
# Requires NEXTTIME_DATA in the environment (same variable host-bootstrap.sh/host-checkout.sh
# use) - refuses without it rather than silently skipping steps 2-4.
#
# Safety: only ever removes a path of the exact shape
# $NEXTTIME_DATA/workspaces/<principalId> or $NEXTTIME_DATA/workspaces/tasks/<taskId> - refuses
# to touch anything else, even if the CLI's own output were ever malformed, and refuses to act on
# a principal/task id that contains "/" or "..".
#
# Does NOT delete backups (docs/runbooks/backup-restore.md) - old dumps that included this
# workspace are untouched.

set -u

WORKSPACE_ID="${1:-}"
if [ -z "$WORKSPACE_ID" ]; then
	echo "delete-workspace: usage: sh scripts/delete-workspace.sh <workspaceId> [--name <expected name>]" >&2
	exit 1
fi
shift

NAME=""
if [ "${1:-}" = "--name" ]; then
	NAME="${2:-}"
	if [ -z "$NAME" ]; then
		echo "delete-workspace: --name requires a value" >&2
		exit 1
	fi
	shift 2
fi

if [ $# -gt 0 ]; then
	echo "delete-workspace: unknown argument: $1" >&2
	exit 1
fi

if [ -z "${NEXTTIME_DATA:-}" ]; then
	echo "delete-workspace: NEXTTIME_DATA is not set; refusing to run (needed for host-side cleanup)" >&2
	exit 1
fi

if ! docker compose config >/dev/null 2>&1; then
	echo "delete-workspace: 'docker compose config' failed - run this script from the compose project directory" >&2
	exit 1
fi

echo "delete-workspace: target workspace = $WORKSPACE_ID${NAME:+ (expected name: $NAME)}"

if [ -n "$NAME" ]; then
	OUT=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js delete-workspace "$WORKSPACE_ID" --yes --name "$NAME" </dev/null)
else
	OUT=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js delete-workspace "$WORKSPACE_ID" --yes </dev/null)
fi
RC=$?

echo "$OUT"

if [ "$RC" -ne 0 ]; then
	echo "delete-workspace: bootstrap.js delete-workspace exited $RC - aborting before any host-side cleanup" >&2
	exit "$RC"
fi

PRINCIPAL_IDS=$(printf '%s\n' "$OUT" | sed -n 's/^PRINCIPAL=//p')
TASK_IDS=$(printf '%s\n' "$OUT" | sed -n 's/^TASK=//p')

if [ -z "$PRINCIPAL_IDS" ] && [ -z "$TASK_IDS" ]; then
	echo "delete-workspace: no PRINCIPAL=/TASK= lines in bootstrap.js output - nothing to clean up on the host"
fi

for pid in $PRINCIPAL_IDS; do
	case "$pid" in
		*/*  | *..* | "")
			echo "delete-workspace: refusing to act on suspicious principal id: $pid" >&2
			continue
			;;
	esac

	echo "delete-workspace: removing resident entry container for principal $pid"
	docker rm -f "nexttime-entry-$pid" >/dev/null 2>&1 || true

	dir="$NEXTTIME_DATA/workspaces/$pid"
	case "$dir" in
		"$NEXTTIME_DATA/workspaces/"*)
			if [ -d "$dir" ]; then
				echo "delete-workspace: removing $dir"
				rm -rf -- "$dir"
			fi
			;;
		*)
			echo "delete-workspace: refusing to remove unexpected path: $dir" >&2
			;;
	esac
done

for tid in $TASK_IDS; do
	case "$tid" in
		*/*  | *..* | "")
			echo "delete-workspace: refusing to act on suspicious task id: $tid" >&2
			continue
			;;
	esac

	dir="$NEXTTIME_DATA/workspaces/tasks/$tid"
	case "$dir" in
		"$NEXTTIME_DATA/workspaces/tasks/"*)
			if [ -d "$dir" ]; then
				echo "delete-workspace: removing $dir"
				rm -rf -- "$dir"
			fi
			;;
		*)
			echo "delete-workspace: refusing to remove unexpected path: $dir" >&2
			;;
	esac
done

echo "delete-workspace: done - workspace $WORKSPACE_ID deleted, host-side cleanup complete"
