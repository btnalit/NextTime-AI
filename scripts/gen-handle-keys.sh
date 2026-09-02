#!/bin/sh
# gen-handle-keys.sh — generate the kernel's Handle-signing Ed25519 keypair (design doc §11
# "EdDSA"; §5.1.4; docs/development-tasks.md S1.9). POSIX sh, idempotent, touches nothing
# outside $NEXTTIME_DATA/config.
#
# Usage (local):
#   NEXTTIME_DATA=/path/to/data sh scripts/gen-handle-keys.sh
#
# Usage (remote, piped over SSH):
#   ssh <TARGET_HOST> 'NEXTTIME_DATA=/path/to/data sh -s' < scripts/gen-handle-keys.sh
#
# Requires: $NEXTTIME_DATA/config already exists (scripts/host-bootstrap.sh E2 +
# scripts/host-env-init.sh E3.3 — the latter also writes the empty config/handle.pub
# placeholder this script fills in for real). Run after host-env-init.sh.
#
# Writes:
#   config/handle.key — PKCS#8 PEM private key, mode 0640, group 10001 (the container uid/gid
#                        every packages/*/Dockerfile runs as — see host-env-init.sh's own
#                        CONTAINER_UID/CONTAINER_GID comment) if that group exists on this host.
#                        Generated only if missing — an existing private key is never
#                        regenerated or overwritten (that would silently invalidate every
#                        already-issued, still-valid Handle and any llm-proxy verifying against
#                        the old config/handle.pub).
#   config/handle.pub  — SPKI PEM public key derived from handle.key, mode 0644 (no secret
#                         material — this is the file llm-proxy, S1.7, reads to verify Handles
#                         locally). Regenerated from handle.key whenever missing/empty, even on a
#                         run that leaves handle.key untouched, so the two files can never drift
#                         out of sync.
#
# Never prints private key contents. Never touches handle.key once it has real content.

set -eu

# --- guard: NEXTTIME_DATA must be set and must not be "/" -----------------
if [ -z "${NEXTTIME_DATA:-}" ]; then
	echo "gen-handle-keys: NEXTTIME_DATA is not set; refusing to run" >&2
	exit 1
fi

if [ "$NEXTTIME_DATA" = "/" ]; then
	echo "gen-handle-keys: NEXTTIME_DATA is '/'; refusing to run" >&2
	exit 1
fi

CONFIG_DIR="$NEXTTIME_DATA/config"

if [ ! -d "$CONFIG_DIR" ]; then
	echo "gen-handle-keys: $CONFIG_DIR does not exist — run scripts/host-bootstrap.sh (E2) and scripts/host-env-init.sh (E3.3) first" >&2
	exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
	echo "gen-handle-keys: openssl is required and was not found on PATH" >&2
	exit 1
fi

echo "gen-handle-keys: target NEXTTIME_DATA=$NEXTTIME_DATA"

HANDLE_KEY="$CONFIG_DIR/handle.key"
HANDLE_PUB="$CONFIG_DIR/handle.pub"

# --- container gid to chgrp handle.key to, only if that group actually exists on this host -----
# (mirrors host-env-init.sh's CONTAINER_UID/CONTAINER_GID comment: every packages/*/Dockerfile
# creates gid 10001 as `nexttime` inside the container, but this script runs on the host, which
# may or may not have any group with that gid).
CONTAINER_GID=10001

chgrp_container_group_if_present() {
	# $1: file to chgrp. Never fails the script if the group doesn't exist or chgrp is denied —
	# ownership is a best-effort convenience for the non-root container process to read the key,
	# not a security boundary (that's the 0640/0644 mode bits and secrets/ directory permissions).
	if command -v getent >/dev/null 2>&1; then
		if getent group "$CONTAINER_GID" >/dev/null 2>&1; then
			chgrp "$CONTAINER_GID" "$1" 2>/dev/null || true
		fi
	else
		chgrp "$CONTAINER_GID" "$1" 2>/dev/null || true
	fi
}

# --- config/handle.key: generate only if missing/empty ----------------------------------------
if [ ! -s "$HANDLE_KEY" ]; then
	echo "gen-handle-keys: generating $HANDLE_KEY (Ed25519, PKCS#8 PEM)"
	umask 077
	openssl genpkey -algorithm ed25519 -out "$HANDLE_KEY"
	KEY_STATUS="generated"
else
	echo "gen-handle-keys: $HANDLE_KEY already exists, leaving private key material unchanged"
	KEY_STATUS="already existed"
fi

chmod 640 "$HANDLE_KEY"
chgrp_container_group_if_present "$HANDLE_KEY"

# --- config/handle.pub: (re)derive from handle.key only if missing/empty ----------------------
if [ ! -s "$HANDLE_PUB" ]; then
	echo "gen-handle-keys: deriving $HANDLE_PUB from $HANDLE_KEY"
	openssl pkey -in "$HANDLE_KEY" -pubout -out "$HANDLE_PUB"
	PUB_STATUS="generated"
else
	echo "gen-handle-keys: $HANDLE_PUB already exists, leaving unchanged"
	PUB_STATUS="already existed"
fi

chmod 644 "$HANDLE_PUB"

# --- report -------------------------------------------------------------------------------
echo ""
echo "gen-handle-keys: config/handle.key: $KEY_STATUS (mode $(stat -c '%a' "$HANDLE_KEY" 2>/dev/null || echo '?'), group $(stat -c '%G' "$HANDLE_KEY" 2>/dev/null || echo '?'))"
echo "gen-handle-keys: config/handle.pub: $PUB_STATUS (mode $(stat -c '%a' "$HANDLE_PUB" 2>/dev/null || echo '?'))"
echo "gen-handle-keys: done (idempotent — safe to re-run; private key contents never printed)"
