#!/bin/sh
# host-llm-proxy-init.sh — one-time host step for S6-B provider management
# (docs/console-completion-plan.md §5.4; docs/runbooks/operations.md「供应商管理」). Run as root
# after scripts/host-env-init.sh, before `docker compose up -d llm-proxy`, and again (idempotent)
# whenever host-env-init.sh is re-run.
#
# What it does, and why each step exists:
#
#   1. ${NEXTTIME_DATA}/llm-proxy/ — llm-proxy's own read-write state directory (docker-compose.yml
#      mounts it at /data/state; providers.json lives there). Created 0750 and chowned to the
#      container uid:gid (10001, packages/llm-proxy/Dockerfile) — the same convention host-env-
#      init.sh applies to workspaces/ artifacts/ gatekeepers/* gate-host/ collectors/*. Without it
#      Docker auto-creates the bind-mount source as root:root 755 and every console write answers
#      503 `store_unwritable`.
#
#   2. ${NEXTTIME_DATA}/config/ — chowned (owner only, mode untouched) to the same uid, so llm-proxy
#      can rewrite models.json atomically there (`.tmp` + rename needs write permission on the
#      *directory*, not the file). Ownership rather than a group-write bit because
#      host-env-init.sh re-applies `chmod 755` to config/ on every run, which would strip g+w
#      again; owner write survives that. Every file inside stays whatever it was (root-owned 644
#      for handle.pub, llm-providers.yaml, egress-sources.json…): llm-proxy cannot modify them in
#      place, and inside the container they are additionally covered by read-only mounts
#      (docker-compose.yml llm-proxy block) — the only thing it gains is creating / replacing
#      models.json. `make gen-models` (root, `.tmp` + `mv`) keeps working unchanged.
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

CONFIG_DIR="$NEXTTIME_DATA/config"
chown "${CONTAINER_UID}" "$CONFIG_DIR"
# models.json itself: owned by the same uid so a *file-level* replace works too; harmless if
# `make gen-models` later hands it back to root (rename over it only needs the directory).
if [ -f "$CONFIG_DIR/models.json" ]; then
	chown "${CONTAINER_UID}" "$CONFIG_DIR/models.json"
fi

echo "host-llm-proxy-init: state dir  -> $(stat -c '%A %U:%G' "$STATE_DIR") $STATE_DIR"
echo "host-llm-proxy-init: config dir -> $(stat -c '%A %U:%G' "$CONFIG_DIR") $CONFIG_DIR"
echo "host-llm-proxy-init: done — now 'docker compose up -d --force-recreate llm-proxy' (new mounts) and 'docker compose restart caddy' (new route)"
