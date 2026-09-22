#!/bin/sh
# host-llm-proxy-init.sh — one-time host step for S6-B provider management / S7-A console-written
# provider secrets (docs/console-completion-plan.md §5.4; docs/STATUS.md 维护者决定 2026-09-22 ①⑤;
# docs/runbooks/operations.md「供应商管理」). Run as root after scripts/host-env-init.sh, before
# `docker compose up -d llm-proxy`, and again (idempotent) whenever host-env-init.sh is re-run.
#
# What it does, and why the step exists:
#
#   ${NEXTTIME_DATA}/llm-proxy/ — llm-proxy's own read-write state directory (docker-compose.yml
#   mounts it at /data/state; providers.json (provider-store.ts) and keys.json (key-store.ts,
#   S7-A console-written provider keys) both live there). Created 0750 and chowned to the
#   container uid:gid (10001, packages/llm-proxy/Dockerfile) — the same convention host-env-
#   init.sh applies to workspaces/ artifacts/ gatekeepers/* gate-host/ collectors/* models/.
#   Without it Docker auto-creates the bind-mount source as root:root 755 and every console write
#   answers 503 `store_unwritable`.
#
# S7-A (维护者决定 ⑤): models.json now lives in its own ${NEXTTIME_DATA}/models/ directory, created
# 0755 and owned 10001 by scripts/host-env-init.sh itself — this script no longer chowns
# ${NEXTTIME_DATA}/config/ at all (that was the previous ② step; the maintainer decided against
# ever changing config/'s ownership, S6-B leftover 50 第二项). Every file under config/ stays
# root-owned 644, read-only to every container, exactly as host-env-init.sh leaves it.
#
# Never prints or touches a key. Requires NEXTTIME_DATA exported (same convention as every other
# host script: `set -a; . ./.env; set +a`).
set -eu

if [ -z "${NEXTTIME_DATA:-}" ]; then
	echo "host-llm-proxy-init: NEXTTIME_DATA is not set (export it, e.g. 'set -a; . ./.env; set +a')" >&2
	exit 1
fi
if [ ! -d "$NEXTTIME_DATA/config" ]; then
	echo "host-llm-proxy-init: $NEXTTIME_DATA/config is missing — run scripts/host-bootstrap.sh and scripts/host-env-init.sh first" >&2
	exit 1
fi

CONTAINER_UID="${CONTAINER_UID:-10001}"
CONTAINER_GID="${CONTAINER_GID:-10001}"

STATE_DIR="$NEXTTIME_DATA/llm-proxy"
mkdir -p "$STATE_DIR"
chmod 750 "$STATE_DIR"
chown "${CONTAINER_UID}:${CONTAINER_GID}" "$STATE_DIR"
if [ -f "$STATE_DIR/providers.json" ]; then
	chown "${CONTAINER_UID}:${CONTAINER_GID}" "$STATE_DIR/providers.json"
fi
if [ -f "$STATE_DIR/keys.json" ]; then
	chown "${CONTAINER_UID}:${CONTAINER_GID}" "$STATE_DIR/keys.json"
	chmod 600 "$STATE_DIR/keys.json"
fi

echo "host-llm-proxy-init: state dir -> $(stat -c '%A %U:%G' "$STATE_DIR") $STATE_DIR"
echo "host-llm-proxy-init: done — next (docs/runbooks/operations.md §12): docker compose build kernel llm-proxy caddy; up -d kernel; up -d --force-recreate llm-proxy; up -d caddy"
