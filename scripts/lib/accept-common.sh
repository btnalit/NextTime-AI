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
