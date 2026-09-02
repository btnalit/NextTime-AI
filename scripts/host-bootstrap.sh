#!/bin/sh
# host-bootstrap.sh — create the NextTime-AI data directory tree and secrets
# directory on a target host. POSIX sh, idempotent, touches nothing outside
# $NEXTTIME_DATA.
#
# Usage (local):
#   NEXTTIME_DATA=/path/to/data sh scripts/host-bootstrap.sh
#
# Usage (remote, piped over SSH — see docs/runbooks/host-bootstrap.md):
#   ssh <TARGET_HOST> 'NEXTTIME_DATA=/path/to/data sh -s' < scripts/host-bootstrap.sh
#
# Scope: only creates directories, sets permissions, and generates the
# Postgres password file. Does NOT write .env (task E3) and does NOT
# generate the Handle signing keypair (task S1.9).

set -eu

# --- guard: NEXTTIME_DATA must be set and must not be "/" -----------------
if [ -z "${NEXTTIME_DATA:-}" ]; then
	echo "host-bootstrap: NEXTTIME_DATA is not set; refusing to run" >&2
	exit 1
fi

if [ "$NEXTTIME_DATA" = "/" ]; then
	echo "host-bootstrap: NEXTTIME_DATA is '/'; refusing to run" >&2
	exit 1
fi

echo "host-bootstrap: target NEXTTIME_DATA=$NEXTTIME_DATA"

# --- create data root and subdirectories -----------------------------------
mkdir -p "$NEXTTIME_DATA"

for d in pgdata sessions workspaces workspaces/tasks secrets config artifacts backups caddy; do
	mkdir -p "$NEXTTIME_DATA/$d"
done

# --- permissions -------------------------------------------------------------
# secrets/ is the only directory with private key material: 0700.
chmod 700 "$NEXTTIME_DATA/secrets"

# Every other subdirectory: 0750 (owner rwx, group rx, no world access).
for d in pgdata sessions workspaces workspaces/tasks config artifacts backups caddy; do
	chmod 750 "$NEXTTIME_DATA/$d"
done

# --- secrets/pg_password: generate only if missing --------------------------
PG_PASSWORD_FILE="$NEXTTIME_DATA/secrets/pg_password"

if [ ! -s "$PG_PASSWORD_FILE" ]; then
	echo "host-bootstrap: generating $PG_PASSWORD_FILE"
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -base64 32 >"$PG_PASSWORD_FILE"
	else
		head -c 32 /dev/urandom | base64 >"$PG_PASSWORD_FILE"
	fi
	chmod 600 "$PG_PASSWORD_FILE"
else
	echo "host-bootstrap: $PG_PASSWORD_FILE already exists, leaving unchanged"
	chmod 600 "$PG_PASSWORD_FILE"
fi

# --- config/.keep: empty placeholder so the (initially empty) config/ dir
# survives in git-tracked deployment tooling that expects it to exist -------
if [ ! -f "$NEXTTIME_DATA/config/.keep" ]; then
	: >"$NEXTTIME_DATA/config/.keep"
fi

# --- report -------------------------------------------------------------------
echo ""
echo "host-bootstrap: directory tree (mode, owner, path):"
find "$NEXTTIME_DATA" -maxdepth 2 -printf '%M %u %p\n'

echo ""
echo "host-bootstrap: summary"
echo "  data root:      $NEXTTIME_DATA"
echo "  secrets mode:   $(stat -c '%a' "$NEXTTIME_DATA/secrets")"
echo "  pg_password:    $([ -s "$PG_PASSWORD_FILE" ] && echo present || echo MISSING) (mode $(stat -c '%a' "$PG_PASSWORD_FILE" 2>/dev/null || echo '?'))"
echo "  subdirectories: pgdata sessions workspaces workspaces/tasks secrets config artifacts backups caddy"
echo "host-bootstrap: done (idempotent — safe to re-run)"
