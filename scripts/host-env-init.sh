#!/bin/sh
# host-env-init.sh — create NextTime-AI's runtime secrets/config placeholders under
# $NEXTTIME_DATA and fix directory ownership so the platform's non-root containers can use
# their mounts. POSIX sh, idempotent. See docs/development-tasks.md E3/E4 and
# docs/graph-ai-middle-platform-design.md §10.2.
#
# Usage (local):
#   NEXTTIME_DATA=/path/to/data sh scripts/host-env-init.sh
#
# Usage (remote, piped over SSH):
#   ssh <TARGET_HOST> 'NEXTTIME_DATA=/path/to/data sh -s' < scripts/host-env-init.sh
#
# Requires: $NEXTTIME_DATA already bootstrapped by scripts/host-bootstrap.sh (task E2) — this
# script does not create the top-level directory tree, only files inside it plus an ownership
# fix-up on a few of those directories. One exception: collectors/host-inventory/ (S3.3) is
# `mkdir -p`'d defensively right before it is chowned — see that step's own comment for why.
#
# Scope: writes secrets/{kernel,llm-proxy,gatekeeper-ragflow}.env and
# config/{llm-providers.yaml,handle.pub,egress-sources.json} as placeholders/templates — no real
# credentials exist yet at this point in the task list (S1.7/S1.9 fill them in later;
# egress-sources.json is S1.11's SOURCE_MAP_FILE for egress-proxy, design doc §7.9 — an empty
# object is a valid "no sources registered yet" map, not a stub for a later task to overwrite;
# gatekeeper-ragflow.env's real shape is S2.5's, see below). Also creates models/models.json as a
# placeholder (S7-A, docs/STATUS.md 维护者决定 2026-09-22 ⑤: models.json moved out of config/ into
# its own directory — do not chown config/; see that step's own comment below).
# Then creates collectors/host-inventory/ if missing (S3.3) and chowns workspaces/ artifacts/
# gatekeepers/{docker,ragflow}/ collectors/host-inventory/ models/ to the non-root uid:gid
# (backups/ is forced back to root-owned — see its own step), and the platform's containers run
# as, chowns pgdata/ and chgrp's secrets/pg_password to the postgres image's own uid:gid
# (遗留20/S5.5 hardening — see that step's own comment), makes config/ world-readable (it holds no
# secrets), and chmod -R o+rX's caddy/ (root-owned — chown doesn't help there, see that step's own
# comment). Never echoes secret file contents. Touches nothing outside $NEXTTIME_DATA.

set -eu

# --- guard: NEXTTIME_DATA must be set, must not be "/", and must already be bootstrapped -----
if [ -z "${NEXTTIME_DATA:-}" ]; then
	echo "host-env-init: NEXTTIME_DATA is not set; refusing to run" >&2
	exit 1
fi

if [ "$NEXTTIME_DATA" = "/" ]; then
	echo "host-env-init: NEXTTIME_DATA is '/'; refusing to run" >&2
	exit 1
fi

SECRETS_DIR="$NEXTTIME_DATA/secrets"
CONFIG_DIR="$NEXTTIME_DATA/config"
PG_PASSWORD_FILE="$SECRETS_DIR/pg_password"

if [ ! -d "$SECRETS_DIR" ] || [ ! -d "$CONFIG_DIR" ]; then
	echo "host-env-init: $NEXTTIME_DATA is missing secrets/ or config/ — run scripts/host-bootstrap.sh (E2) first" >&2
	exit 1
fi

if [ ! -s "$PG_PASSWORD_FILE" ]; then
	echo "host-env-init: $PG_PASSWORD_FILE missing or empty — run scripts/host-bootstrap.sh (E2) first" >&2
	exit 1
fi

echo "host-env-init: target NEXTTIME_DATA=$NEXTTIME_DATA"

# --- non-root uid:gid the platform's containers run as ---------------------------------------
# All five packages/*/Dockerfile (kernel, agent-host, worker-supervisor, llm-proxy,
# egress-proxy) create the same system user/group: `nexttime`, uid 10001, gid 10001
# (`groupadd --system --gid 10001 nexttime` + `useradd --system --uid 10001 --gid nexttime`).
# Keep these two constants in sync with those Dockerfiles if that ever changes.
CONTAINER_UID=10001
CONTAINER_GID=10001

# --- uid:gid the postgres image's own 'postgres' user runs as (遗留20/S5.5 hardening) -----------
# docker-compose.yml now runs the `postgres` service as `user: postgres` from container start
# instead of the image's default root-then-gosu entrypoint path. pgvector/pgvector:pg17 is `FROM
# postgres:17-bookworm` with no useradd/groupadd/chown of its own (verified by reading its
# Dockerfile at its current tag), so this is exactly docker-library/postgres's own fixed
# `groupadd -r postgres --gid=999; useradd -r -g postgres --uid=999 ... postgres` (verified reading
# that Dockerfile too) — a different, fixed pair from CONTAINER_UID/CONTAINER_GID above, not this
# platform's own convention.
POSTGRES_UID=999
POSTGRES_GID=999

# --- urlencode: percent-encode everything outside RFC 3986 unreserved [A-Za-z0-9.~_-] --------
# POSIX-only (no bash-isms): `${s%"${s#?}"}` takes the first character of $s, `${s#?}` strips
# it. `printf '%%%02X' "'$c"` relies on POSIX printf's rule that a numeric conversion given an
# argument starting with `'` takes the numeric value of the following character.
urlencode() {
	s=$1
	out=""
	while [ -n "$s" ]; do
		c=${s%"${s#?}"}
		case "$c" in
			[A-Za-z0-9.~_-]) out="$out$c" ;;
			*) out="$out$(printf '%%%02X' "'$c")" ;;
		esac
		s=${s#?}
	done
	printf '%s' "$out"
}

CREATED=""
SKIPPED=""

# --- secrets/kernel.env: DATABASE_URL (from secrets/pg_password) + Handle key file paths ------
KERNEL_ENV="$SECRETS_DIR/kernel.env"
if [ ! -s "$KERNEL_ENV" ]; then
	pg_password=$(cat "$PG_PASSWORD_FILE")
	encoded_password=$(urlencode "$pg_password")
	{
		echo "# kernel.env — generated by scripts/host-env-init.sh. Real secret; never commit."
		echo "DATABASE_URL=postgres://nexttime:${encoded_password}@postgres:5432/nexttime"
		echo "# Handle signing keypair (scripts/gen-handle-keys.sh): the private key lives at"
		echo "# secrets/handle.key on the host and reaches the kernel container only as the"
		echo "# compose secret 'handle_key'; the public key is config/handle.pub."
		echo "HANDLE_PRIVATE_KEY_FILE=/run/secrets/handle_key"
		echo "HANDLE_PUBLIC_KEY_FILE=/data/config/handle.pub"
	} >"$KERNEL_ENV"
	unset pg_password encoded_password
	CREATED="$CREATED secrets/kernel.env"
else
	SKIPPED="$SKIPPED secrets/kernel.env"
fi
chmod 600 "$KERNEL_ENV"

# --- secrets/llm-proxy.env: commented template, no values (S1.7: packages/llm-proxy/src/config.ts
# defines the real schema) -----------------------------------------------------------------------
LLM_PROXY_ENV="$SECRETS_DIR/llm-proxy.env"
if [ ! -f "$LLM_PROXY_ENV" ]; then
	cat >"$LLM_PROXY_ENV" <<'EOF'
# llm-proxy secrets template (design doc §7.7; docs/development-tasks.md S1.7). Real provider API
# keys go here — never commit. Each var name must exactly match some provider entry's
# `api_key_env` in config/llm-providers.yaml (see config/llm-providers.example.yaml for the full
# schema) — llm-proxy reads the real key from process.env[api_key_env], never from this file's
# key names themselves.
#
# Example (uncomment and fill in when connecting a real provider — names must match
# llm-providers.yaml's own `api_key_env` values, these two are only an example pairing):
# EXAMPLE_OPENAI_API_KEY=
# EXAMPLE_ANTHROPIC_API_KEY=
EOF
	CREATED="$CREATED secrets/llm-proxy.env"
else
	SKIPPED="$SKIPPED secrets/llm-proxy.env"
fi
chmod 600 "$LLM_PROXY_ENV"

# --- secrets/gatekeeper-ragflow.env: commented template, no values (S2.5 defines the shape:
# gatekeepers/ragflow/README.md "Env") -----------------------------------------------------------
RAGFLOW_ENV="$SECRETS_DIR/gatekeeper-ragflow.env"
if [ ! -f "$RAGFLOW_ENV" ]; then
	cat >"$RAGFLOW_ENV" <<'EOF'
# gatekeeper-ragflow secrets template (design doc §7.5; docs/development-tasks.md S2.5, see
# gatekeepers/ragflow/README.md "Env"/"Credentials"). Real RAGFlow base URL/API key for this
# gatekeeper instance go here — never commit. The platform keeps its own copy; it does not share
# a credentials file with any other RAGFlow client on this host.
#
# Example (uncomment and fill in when connecting):
# RAGFLOW_BASE_URL=
# GATE_CREDENTIAL_RAGFLOW_API_KEY=
EOF
	CREATED="$CREATED secrets/gatekeeper-ragflow.env"
else
	SKIPPED="$SKIPPED secrets/gatekeeper-ragflow.env"
fi
chmod 600 "$RAGFLOW_ENV"

# --- config/llm-providers.yaml: empty (valid) config, no keys — real schema is packages/llm-
# proxy/src/config.ts `LlmProvidersFileSchema`, illustrated in full in
# config/llm-providers.example.yaml (design doc §7.7; docs/development-tasks.md S1.7) -----------
LLM_PROVIDERS_YAML="$CONFIG_DIR/llm-providers.yaml"
if [ ! -f "$LLM_PROVIDERS_YAML" ]; then
	cat >"$LLM_PROVIDERS_YAML" <<'EOF'
# Placeholder — no real provider endpoints or keys here. `providers: {}` (an empty map) is valid
# and is exactly what an idle llm-proxy needs — see config/llm-providers.example.yaml at the repo
# root for the full schema (api / upstream_base_url / api_key_env / auth / models) and a worked
# example; scripts/gen-models-json.ts (S1.7) then derives models/models.json (S7-A — moved out of
# config/) from whatever you put here. See design doc §7.7.
providers: {}
# Example provider entry (uncomment and adapt — matches config/llm-providers.example.yaml):
# providers:
#   example-openai:
#     api: openai-completions   # or: openai-responses | anthropic-messages
#     upstream_base_url: https://api.example-openai-compatible.invalid   # never ends in /v1
#     api_key_env: EXAMPLE_OPENAI_API_KEY   # name of a var in secrets/llm-proxy.env
#     auth:
#       header: authorization   # or: x-api-key (Anthropic's convention — omit scheme below)
#       scheme: Bearer
#     models:
#       - id: example-model-id
#         cost:                 # optional — USD per 1,000,000 tokens
#           input: 2.5
#           output: 10
#           cacheRead: 0.25
#           cacheWrite: 3.75
EOF
	CREATED="$CREATED config/llm-providers.yaml"
else
	SKIPPED="$SKIPPED config/llm-providers.yaml"
fi

# --- models/: llm-proxy's own read-write output directory for the merged catalog (S7-A,
# docs/STATUS.md 维护者决定 2026-09-22 ⑤: models.json moved out of config/ so this proxy never
# needs config/ chowned to write it — packages/llm-proxy/src/config.ts's own doc comment on
# `modelsJsonOutFile`). Created 0755, owned by the container uid (below, with the other uid-10001
# directories) — world-readable like config/ (models.json holds no secret: its own `apiKey` field
# is always the literal template string `$CAPABILITY_HANDLE`, never a real key).
mkdir -p "$NEXTTIME_DATA/models"
chmod 755 "$NEXTTIME_DATA/models"

# --- models/models.json: empty object; S1.7's gen-models-json.ts (now S7-A's own directory)
# regenerates it — a spawned entry/Worker container's bind-mount source must already exist as a
# file, or Docker creates a directory there instead (same reasoning as egress-sources.json below).
MODELS_JSON="$NEXTTIME_DATA/models/models.json"
if [ ! -f "$MODELS_JSON" ]; then
	echo "{}" >"$MODELS_JSON"
	CREATED="$CREATED models/models.json"
else
	SKIPPED="$SKIPPED models/models.json"
fi

# --- config/handle.pub: empty placeholder; S1.9 writes the real Handle-signing public key -----
HANDLE_PUB="$CONFIG_DIR/handle.pub"
if [ ! -f "$HANDLE_PUB" ]; then
	: >"$HANDLE_PUB"
	CREATED="$CREATED config/handle.pub"
else
	SKIPPED="$SKIPPED config/handle.pub"
fi

# --- config/egress-sources.json: empty object; docker-compose.yml bind-mounts this file -------
# read-only into egress-proxy (SOURCE_MAP_FILE) — if missing, Docker would create a directory
# at that path instead of a file.
EGRESS_SOURCES_JSON="$CONFIG_DIR/egress-sources.json"
if [ ! -f "$EGRESS_SOURCES_JSON" ]; then
	echo "{}" >"$EGRESS_SOURCES_JSON"
	CREATED="$CREATED config/egress-sources.json"
else
	SKIPPED="$SKIPPED config/egress-sources.json"
fi

# --- config/ontology/: domain packs the operator drops in (S5.3, docs/runbooks/add-domain-pack.md)
# `bootstrap.js seed-domain-pack` reads from here by default (kernel env DOMAIN_PACK_DIR, visible
# through the read-only config/ mount) — a new or updated pack is "put the yaml here, run seed",
# no kernel rebuild. Read-only for the containers like the rest of config/. The pre-S5.3
# collectors/host-inventory/ state directory is no longer mounted or written (register_source is
# idempotent since S5.3); an existing one is left alone.
mkdir -p "$CONFIG_DIR/ontology"

# --- secrets/setup/: initial administrator password directory (S4.1, docker-compose.yml's own
# kernel service comment) — the kernel writes admin's temporary password here (mode 0600) when no
# platform administrator exists yet, so unlike the rest of secrets/ (root-owned, 0700 — see this script's
# own header comment), this one directory must be owned by the same uid:gid the kernel container
# runs as. mkdir -p is idempotent.
mkdir -p "$SECRETS_DIR/setup"
chown "${CONTAINER_UID}:${CONTAINER_GID}" "$SECRETS_DIR/setup"
chmod 0700 "$SECRETS_DIR/setup"

# --- ownership: workspaces/ artifacts/ gatekeepers/{docker,ragflow}/ collectors/host-inventory/
# models/ must be usable by the platform's non-root containers (uid:gid 10001:10001 —
# gatekeepers/*/Dockerfile and collectors/host-inventory/Dockerfile all create the same `nexttime`
# uid:gid as every other @nexttime/* image, S2.5/S3.3). pgdata/ needs a DIFFERENT uid:gid
# (999:999, see POSTGRES_UID/POSTGRES_GID above, and its own step just below) — not this
# platform's own CONTAINER_UID/CONTAINER_GID convention. secrets/ (root-owned, 0700 — compose
# passes its contents via env_file / Docker secrets, not a bind-mounted directory read by a
# container process) is left untouched here, per task scope, EXCEPT secrets/pg_password (its own
# step just below, same 遗留20/S5.5 hardening). `caddy/` is deliberately NOT in this loop — see
# its own step below.
# workspaces/artifacts/gatekeepers/{docker,ragflow} are not `mkdir -p`'d here (unlike
# collectors/host-inventory just above) — scripts/host-bootstrap.sh (E2) has created all four of
# those since before this script existed, with no equivalent drift ever reported for them.
# gate-host/ (P-B2a): the generic gate host's GATE_DATA_DIR (per-instance credential stores +
# idempotency files) — mkdir -p'd here too because a v0.9.0 host that upgrades never ran the newer
# host-bootstrap.sh, and a root-owned bind mount makes the host log EACCES on its first take-over.
# models/ (S7-A): created above, next to its own models.json placeholder.
mkdir -p "$NEXTTIME_DATA/gate-host"
chmod 750 "$NEXTTIME_DATA/gate-host"
for d in workspaces artifacts gatekeepers/docker gatekeepers/ragflow gate-host collectors/host-inventory models; do
	chown -R "${CONTAINER_UID}:${CONTAINER_GID}" "$NEXTTIME_DATA/$d"
done

# --- pgdata/ and secrets/pg_password: owned/grouped for the postgres image's own uid:gid ---------
# (遗留20/S5.5 hardening). docker-compose.yml's `postgres` service now runs as `user: postgres`
# from container start instead of the image's default root-then-gosu entrypoint path — that path's
# own chown-to-postgres steps (docker-entrypoint.sh's `if [ "$(id -u)" = '0' ]; then exec gosu
# postgres ...` branch) never run, so both paths below must already be right before the next
# `docker compose up`, or a fresh initdb has nothing writable to initialize into and an existing
# server can't read its own password file.
# pgdata/: full chown (not just group) — docker-entrypoint.sh's own `chmod 00700 "$PGDATA" || :`
# needs the process uid (999) to match the directory's OWNER uid, group membership is not enough
# for chmod. Non-recursive: initdb itself (running as uid 999) creates everything underneath
# already owned by 999; an already-initialized pgdata/ on an existing host was already left owned
# 999:999 by that same image's prior root-based entrypoint runs, so this is a no-op there.
chown "${POSTGRES_UID}:${POSTGRES_GID}" "$NEXTTIME_DATA/pgdata"
# secrets/pg_password: chgrp only (never chown the uid) — same convention
# scripts/gen-handle-keys.sh already uses for handle.key/internal.token/gate.token: `docker
# compose`'s file-based `secrets:` (non-swarm) bind-mounts this file as-is, so its host-side
# mode/group is what actually gates the postgres service's own non-root read of
# POSTGRES_PASSWORD_FILE. Owner stays whoever ran scripts/host-bootstrap.sh (typically root, E2);
# only the group changes here, so `backup`'s own root+DAC_READ_SEARCH read of the same secret
# (docker-compose.yml's backup service comment) is unaffected either way. Best-effort: a denied
# chgrp is reported, not fatal — same as gen-handle-keys.sh's own CONTAINER_GID chgrps.
chmod 640 "$PG_PASSWORD_FILE"
chgrp "$POSTGRES_GID" "$PG_PASSWORD_FILE" 2>/dev/null || echo "host-env-init: WARNING: could not chgrp $PG_PASSWORD_FILE to gid $POSTGRES_GID — the postgres container will not be able to read it" >&2

# --- backups/: must stay ROOT-owned (0:0, mode 750). The `backup` service runs as root with -----
# `cap_drop: [ALL]` + only `DAC_READ_SEARCH` (docker-compose.yml, 2026-09-08 correction): without
# CAP_DAC_OVERRIDE, root can only write into directories it owns — a `backups/` chowned to the
# platform uid (what fix/socket-proxy-and-backup-user did here) made every backup fail with an
# empty pg_dump error until the directory was chowned back on the host. Enforced idempotently so a
# stray chown cannot silently break the nightly job again; nothing else writes here.
chown -R 0:0 "$NEXTTIME_DATA/backups"
chmod 750 "$NEXTTIME_DATA/backups"

# --- caddy/ (fix/socket-proxy-and-backup-user): chown does NOT work here the way it does for -----
# the uid-10001-owned directories above — `caddy` (docker-compose.yml) runs as the image's own
# default ROOT user, and its on-demand TLS cert/key storage (Caddy's internal CA, via
# caddyserver/certmagic's FileStorage) hardcodes every write to mode 0600 (files) / 0700 (dirs),
# root-owned, replacing the whole inode via atomic rename — so any chmod/chown applied ahead of
# time is overwritten back to root-only on caddy's next cert write (which `on_demand` TLS can
# trigger for any new SNI, not just periodic renewal), REGARDLESS of which of chmod/chown was
# used. `chmod -R o+rX` (not `chown -R :10001` + setgid) is applied anyway as a one-time baseline
# for files that exist right now — it's simpler (no setgid-vs.-certmagic's-own-chmod-0600
# interaction to reason about) and doesn't claim to survive the next cert write either way. The
# `backup` service's actual, ongoing correctness for caddy/ comes from its own `cap_add:
# [DAC_READ_SEARCH]` (docker-compose.yml), not from this chmod — see
# docs/runbooks/backup-restore.md for the full explanation. Re-run this script (idempotent) after
# any caddy restart if you want this baseline re-applied, but it is not required for backups to
# keep working.
chmod -R o+rX "$NEXTTIME_DATA/caddy"

# --- config/: left root-owned but made world-readable (it holds no secrets — provider keys ----
# live in secrets/*.env instead) so any container uid can read it read-only.
chmod 755 "$CONFIG_DIR"
for f in "$CONFIG_DIR"/*; do
	[ -f "$f" ] && chmod 644 "$f"
done

# --- report -------------------------------------------------------------------------------
echo ""
echo "host-env-init: created:${CREATED:- (none — all already existed)}"
echo "host-env-init: already existed, left unchanged:${SKIPPED:- (none)}"
echo ""
echo "host-env-init: secrets/*.env (mode, path):"
for f in kernel.env llm-proxy.env gatekeeper-ragflow.env; do
	echo "  $(stat -c '%a' "$SECRETS_DIR/$f" 2>/dev/null || echo '?') $SECRETS_DIR/$f"
done
echo ""
echo "host-env-init: config/ (mode, owner:group, path):"
find "$CONFIG_DIR" -maxdepth 1 -printf '  %M %U:%G %p\n'
echo ""
echo "host-env-init: ownership fix-up (uid:gid ${CONTAINER_UID}:${CONTAINER_GID}) applied to:"
for d in workspaces artifacts gatekeepers/docker gatekeepers/ragflow gate-host models; do
	echo "  $NEXTTIME_DATA/$d -> $(stat -c '%U:%G' "$NEXTTIME_DATA/$d")"
done
echo "host-env-init: pgdata/ owner -> $(stat -c '%u:%g' "$NEXTTIME_DATA/pgdata" 2>/dev/null || echo '?') (expect ${POSTGRES_UID}:${POSTGRES_GID})"
echo "host-env-init: secrets/pg_password -> mode $(stat -c '%a' "$PG_PASSWORD_FILE" 2>/dev/null || echo '?'), owner:group $(stat -c '%u:%g' "$PG_PASSWORD_FILE" 2>/dev/null || echo '?') (expect 640, group ${POSTGRES_GID})"
echo "host-env-init: backups/ kept root-owned (0:0, mode $(stat -c '%a' "$NEXTTIME_DATA/backups")) — the backup service is root with only DAC_READ_SEARCH and cannot write into a directory it does not own"
echo ""
echo "host-env-init: caddy/ left root-owned; \`chmod -R o+rX\` applied instead (mode now: $(stat -c '%a' "$NEXTTIME_DATA/caddy")) — see docs/runbooks/backup-restore.md for why this is only a baseline, not the real fix"
echo ""
echo "host-env-init: left untouched: secrets/ (dir itself, and every secrets/*.token /*.key)"
echo "host-env-init: done (idempotent — safe to re-run)"
echo ""
echo "platform admin: after the first \`docker compose up\`, the kernel creates the user 'admin' and"
echo "writes its temporary password to \$NEXTTIME_DATA/secrets/setup/initial-admin-password"
echo "(only when no platform administrator exists). Log in to the web console as admin with it;"
echo "you will be asked to change it."
