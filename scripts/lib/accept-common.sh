# scripts/lib/accept-common.sh — shell helpers shared by scripts/accept_s1.sh, accept_s2.sh,
# accept_s3.sh and drill-add-gatekeeper.sh (W6, STATUS leftover 7). POSIX sh; sourced with
# `. "$(dirname "$0")/lib/accept-common.sh"` from a script that already runs from the checkout
# root (docker compose reads ./docker-compose.yml and ./.env from cwd). Before W6 every script
# carried its own copy of these helpers plus its own heredoc JS driver; the driver is now the
# single deploy/accept/driver.mjs (see its header for the subcommand contracts) and the helpers
# live here.
#
# Conventions the callers rely on:
#   - pass/fail/skip print `PASS <name> <detail>` / `FAIL <name> <detail>` / `SKIP <name>
#     <detail>`; fail aborts the whole script (exit 1) — first failure stops the run.
#   - skip counts into SKIP_COUNT / SKIP_LOG so a script can print a summary at the end.
#   - run_driver prints the driver's stdout+stderr as one blob; callers pick `KEY=value` lines out
#     of it with parse_kv (last matching line wins, so an ExperimentalWarning or compose noise on
#     stderr is harmless).
#   - Confidentiality (repo is public): keys are passed to the driver as CLI arguments per
#     invocation, never written to a file; only ever printed through redact().

SKIP_COUNT=0
SKIP_LOG=""

pass() {
  printf 'PASS %s %s\n' "$1" "$2"
}

fail() {
  printf 'FAIL %s %s\n' "$1" "$2" >&2
  exit 1
}

skip() {
  printf 'SKIP %s %s\n' "$1" "${2:-}"
  SKIP_COUNT=$((SKIP_COUNT + 1))
  SKIP_LOG="${SKIP_LOG}SKIP $1 ${2:-}
"
}

# First 6 characters of a secret, for logging without exposing it ("never prints API keys or
# Handles beyond their first 6 characters").
redact() {
  prefix=$(printf '%s' "$1" | cut -c1-6)
  printf '%s...(redacted)' "$prefix"
}

# Extracts the value of the last `KEY=...` line in $1's output (blob of stdout+stderr text).
parse_kv() {
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -n 1
}

# The driver, bind-mounted read-only from the checkout into a throwaway kernel-image container
# on the control network. The kernel image's process runs as uid 10001 — an uid unrelated to
# whoever checked out the repo — so the file must be readable by "other". A checkout under a
# permissive umask gives 644, but a hardened account (umask 027/077) yields 640/600 and every
# driver call would then fail inside the container with an opaque EACCES; the old per-script
# temp file was chmod 644'd for exactly this reason. require_driver restores that guarantee:
# best-effort `chmod a+r` (git tracks only the executable bit, so this never dirties the tree),
# then a hard check on the "other" read bit with a clear message instead of a late failure.
ACCEPT_DRIVER_PATH="${ACCEPT_DRIVER_PATH:-$PWD/deploy/accept/driver.mjs}"

require_driver() {
  if [ ! -r "$ACCEPT_DRIVER_PATH" ]; then
    echo "accept: driver not found at $ACCEPT_DRIVER_PATH — run from the checkout root" >&2
    exit 1
  fi
  chmod a+r "$ACCEPT_DRIVER_PATH" 2>/dev/null || true
  other_read=$(ls -ld "$ACCEPT_DRIVER_PATH" | cut -c8)
  if [ "$other_read" != "r" ]; then
    echo "accept: $ACCEPT_DRIVER_PATH is not world-readable (uid 10001 inside the kernel container must read it): chmod a+r it" >&2
    exit 1
  fi
}

# Runs one driver subcommand. Combines stdout+stderr into one blob for parse_kv. `</dev/null`
# because these scripts run non-interactively over ssh where stdin may not be a terminal.
run_driver() {
  docker compose run --rm --no-deps -T -v "$ACCEPT_DRIVER_PATH:/tmp/driver.mjs:ro" kernel \
    node /tmp/driver.mjs "$@" </dev/null 2>&1
}

# One capability call: cap <token> <capabilityName> <paramsJson> [extractExpr]. Prints the
# HTTP_STATUS=/BODY=/EXTRACTED= blob; callers extract with parse_kv.
cap() {
  run_driver cap "$1" "$2" "$3" "${4:-}"
}

# Polls one gate's /gate/health (control-network-only, no host port) from inside the kernel
# image, sending the kernel container's own gate token as Bearer (the driver's gate-health
# subcommand). Retries for up to ~30s — gate containers take a few seconds to bind their port
# after `docker compose up -d`.
wait_for_gate_health() {
  gate_url="$1"
  attempt=0
  while [ "$attempt" -lt 15 ]; do
    out=$(run_driver gate-health "$gate_url")
    case "$out" in
      *OK=true*) return 0 ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

# --------------------------------------------------------------------------------------------
# Fake provider via compose override (W6, retrospective §5.3). `accept_provider_up` generates the
# fake-provider models.json into ${NEXTTIME_DATA}/accept/ and recreates llm-proxy /
# worker-supervisor / fake-llm with deploy/accept/docker-compose.fake.yml merged in;
# `accept_provider_restore` recreates the two production services from the root file alone.
# The production ${NEXTTIME_DATA}/config/llm-providers.yaml and models.json are never touched.
# Scripts call `trap accept_provider_restore EXIT INT TERM` right after `accept_provider_up`, so
# a run that dies half-way still leaves the host on its real provider.
# --------------------------------------------------------------------------------------------

ACCEPT_FAKE_OVERRIDE="${ACCEPT_FAKE_OVERRIDE:-$PWD/deploy/accept/docker-compose.fake.yml}"
ACCEPT_PROVIDER_SWITCHED=0

compose_accept() {
  docker compose -f docker-compose.yml -f "$ACCEPT_FAKE_OVERRIDE" "$@"
}

# Generates ${NEXTTIME_DATA}/accept/models.json from the fake provider file (the override mounts
# it into llm-proxy, so gen-models reads it) and brings the three services up on the override.
# Prints nothing on success; returns non-zero with a message on stderr otherwise.
accept_provider_up() {
  if [ ! -r "$ACCEPT_FAKE_OVERRIDE" ]; then
    echo "accept: override not found at $ACCEPT_FAKE_OVERRIDE — run from the checkout root" >&2
    return 1
  fi
  mkdir -p "$NEXTTIME_DATA/accept" || return 1
  if ! compose_accept run --rm --no-deps -T llm-proxy node dist/cli/gen-models.js \
      </dev/null >"$NEXTTIME_DATA/accept/models.json.tmp" 2>"$NEXTTIME_DATA/accept/gen-models.err"; then
    echo "accept: gen-models (fake provider) failed: $(tail -5 "$NEXTTIME_DATA/accept/gen-models.err")" >&2
    rm -f "$NEXTTIME_DATA/accept/models.json.tmp"
    return 1
  fi
  mv "$NEXTTIME_DATA/accept/models.json.tmp" "$NEXTTIME_DATA/accept/models.json" || return 1
  # Read inside spawned containers as uid 10001 (see require_driver for the same reasoning).
  chmod a+r "$NEXTTIME_DATA/accept/models.json"
  if ! up_out=$(compose_accept --profile test up -d --force-recreate llm-proxy worker-supervisor fake-llm </dev/null 2>&1); then
    echo "accept: bringing up the fake provider failed: $(printf '%s' "$up_out" | tail -10)" >&2
    return 1
  fi
  ACCEPT_PROVIDER_SWITCHED=1
  return 0
}

# Recreates llm-proxy and worker-supervisor from the root compose file alone (production
# provider config, production models.json path). Idempotent; a no-op if accept_provider_up never
# succeeded. fake-llm is left running — it is harmless and `--profile test` only.
accept_provider_restore() {
  [ "$ACCEPT_PROVIDER_SWITCHED" -eq 1 ] || return 0
  if ! restore_out=$(docker compose up -d --force-recreate llm-proxy worker-supervisor </dev/null 2>&1); then
    echo "accept: restoring the production provider failed — run 'docker compose up -d --force-recreate llm-proxy worker-supervisor' by hand: $(printf '%s' "$restore_out" | tail -10)" >&2
    return 1
  fi
  ACCEPT_PROVIDER_SWITCHED=0
  return 0
}
