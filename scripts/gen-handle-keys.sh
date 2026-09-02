#!/bin/sh
# gen-handle-keys.sh — generate the kernel's Handle-signing Ed25519 keypair (design doc §11
# "EdDSA"; §5.1.4; docs/development-tasks.md S1.9). POSIX sh, idempotent, touches nothing
# outside $NEXTTIME_DATA/secrets and $NEXTTIME_DATA/config.
#
# Usage (local):
#   NEXTTIME_DATA=/path/to/data sh scripts/gen-handle-keys.sh
#
# Usage (remote, piped over SSH):
#   ssh <TARGET_HOST> 'NEXTTIME_DATA=/path/to/data sh -s' < scripts/gen-handle-keys.sh
#
# Requires: $NEXTTIME_DATA/secrets and $NEXTTIME_DATA/config already exist (scripts/host-bootstrap.sh
# E2 + scripts/host-env-init.sh E3.3 — the latter also writes the empty config/handle.pub
# placeholder this script fills in for real). Run after host-env-init.sh.
#
# Writes:
#   secrets/handle.key — PKCS#8 PEM private key, mode 0640, group 10001 (the container uid/gid
#                        every packages/*/Dockerfile runs as — see host-env-init.sh's own
#                        CONTAINER_UID/CONTAINER_GID comment). It lives under secrets/, next to
#                        pg_password, and reaches exactly one container: docker-compose.yml
#                        declares it as the compose secret `handle_key`, mounted read-only into
#                        the kernel service at /run/secrets/handle_key (kernel.env's
#                        HANDLE_PRIVATE_KEY_FILE). It is deliberately NOT under config/: config/
#                        is bind-mounted whole into more than one service and is included in the
#                        daily files backup (deploy/backup/backup.sh), and both of those must
#                        stay credential-free. Generated only if missing — an existing private
#                        key is never regenerated or overwritten (that would silently invalidate
#                        every already-issued, still-valid Handle and any llm-proxy verifying
#                        against the old config/handle.pub).
#   config/handle.pub  — SPKI PEM public key derived from handle.key, mode 0644 (no secret
#                        material — this is the file llm-proxy, S1.7, reads to verify Handles
#                        locally, and the kernel's HANDLE_PUBLIC_KEY_FILE). Regenerated from
#                        handle.key whenever missing/empty, even on a run that leaves handle.key
#                        untouched, so the two files can never drift out of sync.
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

SECRETS_DIR="$NEXTTIME_DATA/secrets"
CONFIG_DIR="$NEXTTIME_DATA/config"

for d in "$SECRETS_DIR" "$CONFIG_DIR"; do
	if [ ! -d "$d" ]; then
		echo "gen-handle-keys: $d does not exist — run scripts/host-bootstrap.sh (E2) and scripts/host-env-init.sh (E3.3) first" >&2
		exit 1
	fi
done

if ! command -v openssl >/dev/null 2>&1; then
	echo "gen-handle-keys: openssl is required and was not found on PATH" >&2
	exit 1
fi

echo "gen-handle-keys: target NEXTTIME_DATA=$NEXTTIME_DATA"

HANDLE_KEY="$SECRETS_DIR/handle.key"
HANDLE_PUB="$CONFIG_DIR/handle.pub"

# --- container gid the private key is chgrp'd to ---------------------------------------------
# (mirrors host-env-init.sh's CONTAINER_UID/CONTAINER_GID: every packages/*/Dockerfile creates
# gid 10001 as `nexttime` inside the container). chgrp takes the numeric gid directly, so this
# works whether or not the host has a group entry for it — the bind-mounted secret keeps the
# host file's uid/gid/mode, and the kernel process (uid/gid 10001) reads it through the group
# bit. Best-effort: a denied chgrp is reported, not fatal — the mode bits and the root-owned
# 0700 secrets/ directory are the security boundary, the group is only what lets the non-root
# container process read the file at all, and the report line below makes a wrong group visible.
CONTAINER_GID=10001

# --- secrets/handle.key: generate only if missing/empty ----------------------------------------
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
chgrp "$CONTAINER_GID" "$HANDLE_KEY" 2>/dev/null || echo "gen-handle-keys: WARNING: could not chgrp $HANDLE_KEY to gid $CONTAINER_GID — the kernel container will not be able to read it" >&2

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
echo "gen-handle-keys: secrets/handle.key: $KEY_STATUS (mode $(stat -c '%a' "$HANDLE_KEY" 2>/dev/null || echo '?'), owner:group $(stat -c '%u:%g' "$HANDLE_KEY" 2>/dev/null || echo '?'))"
echo "gen-handle-keys: config/handle.pub:  $PUB_STATUS (mode $(stat -c '%a' "$HANDLE_PUB" 2>/dev/null || echo '?'))"
echo "gen-handle-keys: done (idempotent — safe to re-run; private key contents never printed)"
