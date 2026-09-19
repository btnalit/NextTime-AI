#!/bin/sh
# delete-workspace.sh - operator-only, destructive: purges one Workspace (via the kernel
# bootstrap CLI's `purge-workspace` subcommand - the same application function the console's
# `purge_workspace` capability runs, S6 docs/console-completion-plan.md §5.2 "脚本与页面同一条
# 路径") and the matching host-side state - each of its Principals' stopped resident entry
# container and workspace data directory, and each of its Tasks' data directory.
#
# Usage (from the compose project directory - this script drives `docker compose run`):
#   sh scripts/delete-workspace.sh <workspaceId> [--name <expected name>] [--force] [--actor <login>]
#
#   <workspaceId>           required - the Workspace to purge.
#   --name <expected name>  optional - forwarded to the kernel CLI's own --name guard (refuses
#                           unless it equals the workspace's actual stored name; protects against
#                           a pasted-wrong-id mistake).
#   --force                 optional - operator override: run the legacy `delete-workspace`
#                           subcommand instead, which skips the purge preconditions (a workspace
#                           must otherwise be disabled for 7 days - or disabled before migration
#                           core 0030 - or an ephemeral workspace past its expiry, and never the
#                           platform default). For the one case the retention rule is wrong
#                           (a workspace created by mistake); never the routine path.
#   --actor <login>         optional - the administrator the `platform.workspace_purged` audit
#                           row names. Defaults to the first login in NEXTTIME_PLATFORM_ADMINS
#                           (read from .env by the kernel container); when neither resolves, the
#                           kernel prints a structured event line instead and says so.
#
# What this removes, in order (the §4 cascade, inside one kernel transaction):
#   1. Every CapabilityHandle (revoked, then deleted), Task, Chat / Turn / Activity / Decision /
#      Conflict / Fact / Object / Source / Observation / Evidence row, the workspace's own audit
#      rows, its Principals and the Workspace row - plus every user whose memberships were all
#      here and who never activated (no password, no login, nothing else referencing them). The
#      platform audit row `platform.workspace_purged` (counts, warnings, purged users) is kept.
#   2. Each Principal's resident entry container that belonged to it (docker rm -f; ignored if
#      already stopped/removed).
#   3. Each Principal's data directory under $NEXTTIME_DATA/workspaces/<principalId>.
#   4. Each Task's data directory under $NEXTTIME_DATA/workspaces/tasks/<taskId>.
#
# A `WARNING service_handle_in_use` line from the kernel means a `service` Principal (a collector,
# an external runtime) still existed: whatever process holds its Handle starts failing with 401
# from now on (leftover 41's own story) - re-mint it against the workspace it should be using.
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
	echo "delete-workspace: usage: sh scripts/delete-workspace.sh <workspaceId> [--name <expected name>] [--force] [--actor <login>]" >&2
	exit 1
fi
shift

NAME=""
FORCE=0
ACTOR=""
while [ $# -gt 0 ]; do
	case "$1" in
		--name)
			NAME="${2:-}"
			if [ -z "$NAME" ]; then
				echo "delete-workspace: --name requires a value" >&2
				exit 1
			fi
			shift 2
			;;
		--force)
			FORCE=1
			shift
			;;
		--actor)
			ACTOR="${2:-}"
			if [ -z "$ACTOR" ]; then
				echo "delete-workspace: --actor requires a value" >&2
				exit 1
			fi
			shift 2
			;;
		*)
			echo "delete-workspace: unknown argument: $1" >&2
			exit 1
			;;
	esac
done

if [ -z "${NEXTTIME_DATA:-}" ]; then
	echo "delete-workspace: NEXTTIME_DATA is not set; refusing to run (needed for host-side cleanup)" >&2
	exit 1
fi

if ! docker compose config >/dev/null 2>&1; then
	echo "delete-workspace: 'docker compose config' failed - run this script from the compose project directory" >&2
	exit 1
fi

if [ "$FORCE" -eq 1 ]; then
	SUBCOMMAND="delete-workspace"
	echo "delete-workspace: target workspace = $WORKSPACE_ID${NAME:+ (expected name: $NAME)} - FORCED (purge preconditions skipped)"
else
	SUBCOMMAND="purge-workspace"
	echo "delete-workspace: target workspace = $WORKSPACE_ID${NAME:+ (expected name: $NAME)}"
fi

# Exactly one `docker compose run` whatever the flag combination: the optional flags are appended
# only when set (an empty --name / --actor would be a usage error on the CLI side).
set -- "$SUBCOMMAND" "$WORKSPACE_ID" --yes
if [ -n "$NAME" ]; then
	set -- "$@" --name "$NAME"
fi
if [ -n "$ACTOR" ]; then
	set -- "$@" --actor "$ACTOR"
fi
OUT=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js "$@" </dev/null)
RC=$?

echo "$OUT"

if [ "$RC" -ne 0 ]; then
	echo "delete-workspace: bootstrap.js $SUBCOMMAND exited $RC - aborting before any host-side cleanup" >&2
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

echo "delete-workspace: done - workspace $WORKSPACE_ID purged, host-side cleanup complete"
