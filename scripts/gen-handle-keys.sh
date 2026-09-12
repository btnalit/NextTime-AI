#!/bin/sh
# gen-handle-keys.sh — generate the kernel's Handle-signing Ed25519 keypair (design doc §11
# "EdDSA"; §5.1.4; docs/development-tasks.md S1.9) AND the internal-plane shared-secret token
# (fix/internal-plane-auth, 2026-09; @nexttime/shared's internal-token.ts). POSIX sh, idempotent,
# touches nothing outside $NEXTTIME_DATA/secrets and $NEXTTIME_DATA/config.
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
#   secrets/handle.key    — PKCS#8 PEM private key, mode 0640, group 10001 (the container uid/gid
#                           every packages/*/Dockerfile runs as — see host-env-init.sh's own
#                           CONTAINER_UID/CONTAINER_GID comment). It lives under secrets/, next to
#                           pg_password, and reaches exactly one container: docker-compose.yml
#                           declares it as the compose secret `handle_key`, mounted read-only into
#                           the kernel service at /run/secrets/handle_key (kernel.env's
#                           HANDLE_PRIVATE_KEY_FILE). It is deliberately NOT under config/: config/
#                           is bind-mounted whole into more than one service and is included in the
#                           daily files backup (deploy/backup/backup.sh), and both of those must
#                           stay credential-free. Generated only if missing — an existing private
#                           key is never regenerated or overwritten (that would silently invalidate
#                           every already-issued, still-valid Handle and any llm-proxy verifying
#                           against the old config/handle.pub).
#   config/handle.pub     — SPKI PEM public key derived from handle.key, mode 0644 (no secret
#                           material — this is the file llm-proxy, S1.7, reads to verify Handles
#                           locally, and the kernel's HANDLE_PUBLIC_KEY_FILE). Regenerated from
#                           handle.key whenever missing/empty, even on a run that leaves handle.key
#                           untouched, so the two files can never drift out of sync.
#   secrets/internal.token — 32 random bytes, hex-encoded (64 chars), mode 0640, group 10001 —
#                           same convention as handle.key. Reaches the kernel *and* every internal
#                           client (agent-host/llm-proxy/egress-proxy) as the compose secret
#                           `internal_token`, mounted at each container's
#                           NEXTTIME_INTERNAL_TOKEN_FILE (default /run/secrets/internal_token —
#                           @nexttime/shared's DEFAULT_INTERNAL_TOKEN_FILE). Generated only if
#                           missing — an existing token is never regenerated (that would 401 every
#                           already-running client until every one of the four containers restarts
#                           with the new value; a deliberate rotation should restart all four
#                           together, not rely on this idempotent script to do it silently).
#   secrets/gate.token     — 32 random bytes, hex-encoded (64 chars), mode 0640, group 10001 — a
#                           SEPARATE secret from internal.token (fix/gate-protocol-hardening,
#                           2026-09; @nexttime/gatekeeper-base's gate-token.ts closes the review
#                           lane 5 P1-1 gap: every /gate/* route was reachable, unauthenticated, by
#                           any control-network container). Reaches the kernel and every one of the
#                           four gate services (gatekeeper-docker, gatekeeper-ragflow,
#                           accept-s2-ssh-gate, accept-s2-http-gate) as the compose secret
#                           `gate_token`, mounted at each container's own default path
#                           (/run/secrets/gate_token — @nexttime/gatekeeper-base's
#                           DEFAULT_GATE_TOKEN_FILE, read by the kernel via NEXTTIME_GATE_TOKEN_FILE
#                           and by every gate via GATE_KERNEL_TOKEN_FILE — two env var names, one
#                           shared secret, see gate-token.ts's own module doc comment for why they
#                           are not the same var). Generated only if missing, same rotation caveat
#                           as internal.token above.
#
# Never prints private key or token contents. Never touches handle.key, internal.token, or
# gate.token once any of them has real content.

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
INTERNAL_TOKEN="$SECRETS_DIR/internal.token"
GATE_TOKEN="$SECRETS_DIR/gate.token"
GATE_HOST_STORE_KEY="$SECRETS_DIR/gate-host-store.key"

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

# --- secrets/internal.token: generate only if missing/empty (fix/internal-plane-auth) ----------
# 32 random bytes, hex-encoded — comfortably clears @nexttime/shared's INTERNAL_TOKEN_MIN_LENGTH
# (32 characters; 64 hex chars here). `openssl rand` (not genpkey/req) — this is a bare shared
# secret, not a key pair.
if [ ! -s "$INTERNAL_TOKEN" ]; then
	echo "gen-handle-keys: generating $INTERNAL_TOKEN (32 random bytes, hex)"
	umask 077
	openssl rand -hex 32 > "$INTERNAL_TOKEN"
	TOKEN_STATUS="generated"
else
	echo "gen-handle-keys: $INTERNAL_TOKEN already exists, leaving it unchanged"
	TOKEN_STATUS="already existed"
fi

chmod 640 "$INTERNAL_TOKEN"
chgrp "$CONTAINER_GID" "$INTERNAL_TOKEN" 2>/dev/null || echo "gen-handle-keys: WARNING: could not chgrp $INTERNAL_TOKEN to gid $CONTAINER_GID — the kernel/agent-host/llm-proxy/egress-proxy containers will not be able to read it" >&2

# --- secrets/gate.token: generate only if missing/empty (fix/gate-protocol-hardening) ----------
if [ ! -s "$GATE_TOKEN" ]; then
	echo "gen-handle-keys: generating $GATE_TOKEN (32 random bytes, hex)"
	umask 077
	openssl rand -hex 32 > "$GATE_TOKEN"
	GATE_TOKEN_STATUS="generated"
else
	echo "gen-handle-keys: $GATE_TOKEN already exists, leaving it unchanged"
	GATE_TOKEN_STATUS="already existed"
fi

chmod 640 "$GATE_TOKEN"
chgrp "$CONTAINER_GID" "$GATE_TOKEN" 2>/dev/null || echo "gen-handle-keys: WARNING: could not chgrp $GATE_TOKEN to gid $CONTAINER_GID — the kernel and gate containers will not be able to read it" >&2

# --- report -------------------------------------------------------------------------------
# gate-host-store.key (P-B2a, docs/development-tasks.md P-B 决定 ⑪): the AES key the generic gate
# host encrypts every hosted instance's credentials with at rest (packages/gatekeeper-base
# credentials/connected-account.ts, `GATE_STORE_KEY_FILE`). One key per host, compose secret
# `gate_host_store_key`, 0640 group 10001 like the other three. Never printed.
if [ ! -s "$GATE_HOST_STORE_KEY" ]; then
	echo "gen-handle-keys: generating $GATE_HOST_STORE_KEY (32 random bytes, hex)"
	umask 077
	openssl rand -hex 32 > "$GATE_HOST_STORE_KEY"
	GATE_HOST_STORE_KEY_STATUS="generated"
else
	echo "gen-handle-keys: $GATE_HOST_STORE_KEY already exists, leaving it unchanged"
	GATE_HOST_STORE_KEY_STATUS="already existed"
fi
chmod 640 "$GATE_HOST_STORE_KEY"
chgrp "$CONTAINER_GID" "$GATE_HOST_STORE_KEY" 2>/dev/null || echo "gen-handle-keys: WARNING: could not chgrp $GATE_HOST_STORE_KEY to gid $CONTAINER_GID — the gate-host container will not be able to read it" >&2
echo ""
echo "gen-handle-keys: secrets/handle.key:    $KEY_STATUS (mode $(stat -c '%a' "$HANDLE_KEY" 2>/dev/null || echo '?'), owner:group $(stat -c '%u:%g' "$HANDLE_KEY" 2>/dev/null || echo '?'))"
echo "gen-handle-keys: config/handle.pub:     $PUB_STATUS (mode $(stat -c '%a' "$HANDLE_PUB" 2>/dev/null || echo '?'))"
echo "gen-handle-keys: secrets/internal.token: $TOKEN_STATUS (mode $(stat -c '%a' "$INTERNAL_TOKEN" 2>/dev/null || echo '?'), owner:group $(stat -c '%u:%g' "$INTERNAL_TOKEN" 2>/dev/null || echo '?'))"
echo "gen-handle-keys: secrets/gate.token:     $GATE_TOKEN_STATUS (mode $(stat -c '%a' "$GATE_TOKEN" 2>/dev/null || echo '?'), owner:group $(stat -c '%u:%g' "$GATE_TOKEN" 2>/dev/null || echo '?'))"
echo "gen-handle-keys: secrets/gate-host-store.key: $GATE_HOST_STORE_KEY_STATUS (mode $(stat -c '%a' "$GATE_HOST_STORE_KEY" 2>/dev/null || echo '?'), owner:group $(stat -c '%u:%g' "$GATE_HOST_STORE_KEY" 2>/dev/null || echo '?'))"
echo "gen-handle-keys: done (idempotent — safe to re-run; private key/token contents never printed)"
