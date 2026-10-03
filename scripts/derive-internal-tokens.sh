#!/bin/sh
# derive-internal-tokens.sh — derive every internal-plane service's own credential from the root
# secret (R-03, 2026-10-02 review L1-7/L6-1; packages/kernel/src/interfaces/internal-auth). POSIX
# sh, idempotent, touches nothing outside $NEXTTIME_DATA/secrets.
#
# Usage:
#   NEXTTIME_DATA=/path/to/data sh scripts/derive-internal-tokens.sh
#
# Called by scripts/gen-handle-keys.sh (after it has made sure the root exists) and by
# scripts/apply-release.sh before every host apply (a release's docker-compose.yml may mount a
# credential file the host does not have yet, and `docker compose up` refuses a missing secret
# file). Safe to run any number of times.
#
# Reads:  secrets/internal.token — the root (gen-handle-keys.sh generates it). Only the kernel
#         mounts it.
# Writes: secrets/internal-<caller>-to-<callee>.token, one per edge of the internal plane, mode
#         0640, group 10001 (the same convention as internal.token; run as root — a file that
#         cannot be given group 10001 stops the script, exit 1). docker-compose.yml mounts each
#         into the services on that edge only:
#           agent-host   -> kernel             agent-host
#           llm-proxy    -> kernel             llm-proxy
#           egress-proxy -> kernel             egress-proxy
#           gate         -> kernel             every packaged gate (gatekeeper-docker,
#                                              gatekeeper-ragflow, any gatekeeper-<system>)
#           gate-host    -> kernel             gate-host
#           kernel       -> worker-supervisor  kernel and worker-supervisor
#           agent-host   -> worker-supervisor  agent-host and worker-supervisor
#
# Construction: credential = HMAC-SHA256(key = "nexttime-internal:<caller>-><callee>",
# message = root), hex — RFC 5869 HKDF-Extract with the public label as the salt. The root is
# streamed to openssl on stdin, never placed on a command line (where any local user could read
# it from the process table). The kernel re-derives the "-> kernel" credentials from the root
# itself (deriveInternalCredential), so the label strings here and there must change together.
#
# Every credential is re-derived on every run and rewritten when it differs, so rotating the root
# (docs/runbooks/key-rotation.md §2) and re-running this script rotates all of them. Never prints
# the root or a credential.

set -eu

if [ -z "${NEXTTIME_DATA:-}" ]; then
	echo "derive-internal-tokens: NEXTTIME_DATA is not set; refusing to run" >&2
	exit 1
fi
if [ "$NEXTTIME_DATA" = "/" ]; then
	echo "derive-internal-tokens: NEXTTIME_DATA is '/'; refusing to run" >&2
	exit 1
fi

SECRETS_DIR="$NEXTTIME_DATA/secrets"
ROOT="$SECRETS_DIR/internal.token"
CONTAINER_GID=10001

if [ ! -s "$ROOT" ]; then
	echo "derive-internal-tokens: $ROOT is missing or empty — run scripts/gen-handle-keys.sh first" >&2
	exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
	echo "derive-internal-tokens: openssl is required and was not found on PATH" >&2
	exit 1
fi

umask 077

derive() { # $1 = caller, $2 = callee
	file="$SECRETS_DIR/internal-$1-to-$2.token"
	# `tr` strips the trailing newline (and any surrounding whitespace) exactly as the kernel's
	# normalizeInternalToken trims the root; the sed strips openssl's "<alg>(stdin)= " prefix,
	# whose spelling varies across openssl versions.
	value=$(tr -d '[:space:]' <"$ROOT" | openssl dgst -sha256 -hmac "nexttime-internal:$1->$2" | sed 's/^.*= *//')
	case "$value" in
	"" | *[!0-9a-f]*)
		echo "derive-internal-tokens: openssl did not produce a hex HMAC for $file" >&2
		exit 1
		;;
	esac
	if [ "${#value}" -ne 64 ]; then
		echo "derive-internal-tokens: openssl produced a ${#value}-character HMAC for $file (expected 64)" >&2
		exit 1
	fi
	if [ -s "$file" ] && [ "$(cat "$file")" = "$value" ]; then
		status="unchanged"
	else
		printf '%s\n' "$value" >"$file"
		status="derived"
	fi
	chmod 640 "$file"
	# Fatal, unlike gen-handle-keys.sh's best-effort chgrp: apply-release.sh runs this right before
	# images, migrations and `up`, and a credential the non-root (gid 10001) service cannot read
	# would take that service down at `up` — stop here instead, with the running stack untouched.
	if ! chgrp "$CONTAINER_GID" "$file"; then
		echo "derive-internal-tokens: could not chgrp $file to gid $CONTAINER_GID — the services it is mounted into could not read it. Run this script as root (the host scripts and CI's bootstrap step do)" >&2
		exit 1
	fi
	gid=$(stat -c '%g' "$file" 2>/dev/null || echo '?')
	if [ "$gid" != "$CONTAINER_GID" ]; then
		echo "derive-internal-tokens: $file has group $gid after chgrp, expected $CONTAINER_GID — refusing to continue" >&2
		exit 1
	fi
	echo "derive-internal-tokens: secrets/internal-$1-to-$2.token: $status (mode $(stat -c '%a' "$file" 2>/dev/null || echo '?'), owner:group $(stat -c '%u:%g' "$file" 2>/dev/null || echo '?'))"
}

derive agent-host kernel
derive llm-proxy kernel
derive egress-proxy kernel
derive gate kernel
derive gate-host kernel
derive kernel worker-supervisor
derive agent-host worker-supervisor

echo "derive-internal-tokens: done (idempotent — safe to re-run; no secret printed)"
