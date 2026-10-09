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
#   - Confidentiality (repo is public): keys are held in shell variables, never written to a file
#     and only ever printed through redact(). They reach the driver through the environment, never
#     as an argument of any process (R-34, see run_driver).

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

# auth_header <token>: the `Authorization: Bearer` line for `curl -H @-` (R-34). Piped into curl's
# stdin by the printf builtin, the key is an argument of no process — `curl -H "...$KEY"` would put
# it in curl's /proc/<pid>/cmdline, readable by every local user.
auth_header() {
  printf 'Authorization: Bearer %s\n' "$1"
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

# Best-effort `chmod a+r` (git tracks only the executable bit, so this never dirties the tree),
# then a hard check on the "other" read bit with a clear message instead of a late EACCES from
# inside a container running as uid 10001.
require_world_readable() {
  if [ ! -r "$1" ]; then
    echo "accept: $2 not found at $1 — run from the checkout root" >&2
    exit 1
  fi
  chmod a+r "$1" 2>/dev/null || true
  other_read=$(ls -ld "$1" | cut -c8)
  if [ "$other_read" != "r" ]; then
    echo "accept: $1 is not world-readable (uid 10001 inside a container must read it): chmod a+r it" >&2
    exit 1
  fi
}

require_driver() {
  require_world_readable "$ACCEPT_DRIVER_PATH" "driver"
}

# Runs one driver subcommand. Combines stdout+stderr into one blob for parse_kv. `</dev/null`
# because these scripts run non-interactively over ssh where stdin may not be a terminal.
#
# R-34: a key, Handle or capability params JSON (which can carry a connection secret or a gate
# credential) is never an argument of `docker compose` here or of `node` in the container — any
# local user can read /proc/<pid>/cmdline, and these suites run on the production host. Callers
# still pass them positionally; this function moves them into the environment instead: the token
# (first argument of every token-taking subcommand) becomes NT_ACCEPT_TOKEN, cap/mcp params become
# NT_ACCEPT_PARAMS, `-e NAME` (no value) copies each into the container, and the driver receives
# `env:NAME` in their place (driver.mjs resolveArg). The subshell body keeps the exports from
# outliving the call.
run_driver() (
  case "$1" in
    cap | mcp)
      [ "$#" -ge 4 ] || { echo "run_driver: $1 needs <token> <name> <paramsJson>" >&2; exit 2; }
      driver_cmd=$1
      driver_name=$3
      NT_ACCEPT_TOKEN=$2
      NT_ACCEPT_PARAMS=$4
      export NT_ACCEPT_TOKEN NT_ACCEPT_PARAMS
      shift 4
      set -- "$driver_cmd" env:NT_ACCEPT_TOKEN "$driver_name" env:NT_ACCEPT_PARAMS "$@"
      ;;
    send-and-wait | send-only | isolation-check | get-history | wait-task | explorer)
      [ "$#" -ge 2 ] || { echo "run_driver: $1 needs <token>" >&2; exit 2; }
      driver_cmd=$1
      NT_ACCEPT_TOKEN=$2
      export NT_ACCEPT_TOKEN
      shift 2
      set -- "$driver_cmd" env:NT_ACCEPT_TOKEN "$@"
      ;;
  esac
  docker compose run --rm --no-deps -T -e NT_ACCEPT_TOKEN -e NT_ACCEPT_PARAMS \
    -v "$ACCEPT_DRIVER_PATH:/tmp/driver.mjs:ro" kernel \
    node /tmp/driver.mjs "$@" </dev/null 2>&1
)

# run_driver_mount <host_file> <driver args...>: like run_driver, additionally bind-mounting one
# host file read-only at /tmp/mounted (W7: `transcript-stats /tmp/mounted` reads a Worker's pi
# session JSONL from ${NEXTTIME_DATA}/workspaces/tasks/<taskId>/...). The file must be readable by
# the kernel image's non-root user — same umask caveat require_world_readable documents.
run_driver_mount() {
  mount_src=$1
  shift
  docker compose run --rm --no-deps -T -v "$ACCEPT_DRIVER_PATH:/tmp/driver.mjs:ro" \
    -v "$mount_src:/tmp/mounted:ro" kernel node /tmp/driver.mjs "$@" </dev/null 2>&1
}

# One capability call: cap <token> <capabilityName> <paramsJson> [extractExpr]. Prints the
# HTTP_STATUS=/BODY=/EXTRACTED= blob; callers extract with parse_kv.
cap() {
  run_driver cap "$1" "$2" "$3" "${4:-}"
}

# Polls one gate's /gate/health (control-network-only, no host port) from inside the kernel
# image, sending the kernel container's own gate token as Bearer (the driver's gate-health
# subcommand). Retries for up to ~30s — gate containers take a few seconds to bind their port
# after `docker compose up -d`. Optional second argument (R-01): a host file holding a
# self-connected gate's own connection secret — mounted read-only and sent instead of the platform
# gate token, which such a gate never accepts.
wait_for_gate_health() {
  gate_url="$1"
  token_file="${2:-}"
  attempt=0
  while [ "$attempt" -lt 15 ]; do
    if [ -n "$token_file" ]; then
      out=$(run_driver_mount "$token_file" gate-health "$gate_url" /tmp/mounted)
    else
      out=$(run_driver gate-health "$gate_url")
    fi
    case "$out" in
      *OK=true*) return 0 ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

# R-01 (maintainer decision D-01): a self-connected gate authenticates the kernel with its own
# connection secret, never the platform gate token. mint_gate_secret <ownerKey> <step> prints a
# fresh one (`mint_connection_secret` stores nothing); it runs inside a command substitution, so
# the caller checks for an empty result. write_gate_secret <secret> <file> puts it where the gate's
# GATE_KERNEL_TOKEN_FILE points (docker-compose.yml), readable by the gate's uid 10001 — a
# throwaway acceptance directory, like the store.key beside it.
mint_gate_secret() {
  out=$(cap "$1" mint_connection_secret "{}" "d.result.connectionSecret")
  status=$(parse_kv "$out" HTTP_STATUS)
  if [ "$status" != "200" ]; then
    echo "$2: mint_connection_secret HTTP $status: $(parse_kv "$out" BODY)" >&2
    return 1
  fi
  parse_kv "$out" EXTRACTED
}

write_gate_secret() {
  (umask 077 && printf '%s\n' "$1" >"$2") || return 1
  chmod 0644 "$2"
}

# leftover 63 (host egress / DNS jitter): retry_http_code <max_attempts> <backoff_seconds>
# <cmd...> — runs <cmd...> (its stdout must be exactly an HTTP status code, e.g. `curl -o /dev/null
# -w '%{http_code}' ...`) up to <max_attempts> times, sleeping <backoff_seconds> between tries,
# stopping at the first attempt whose output is "200". 2026-09-23 host acceptance saw the host's
# direct public-internet reachability flap (half the requests failing, recovering minutes later);
# 2026-09-25 accept_s2.sh's own step6-registered-egress-ok failed twice in a row with curl 000
# while egress-proxy's own log showed `allowed:true` / `bytesDown:0` (an upstream TLS stall, not a
# platform rejection) — a transient network condition indistinguishable, from inside the container,
# from a real regression, so this is a targeted retry on the *specific* probes that hit it, not a
# blanket retry around every acceptance step.
#
# Only ever wraps a *positive* egress probe (expects 200) — a *negative* probe (egress-internal-
# denied, step6-direct-lan-fails, step6-unregistered-source-denied: all denied-by-design) must keep
# failing closed on its first answer and must never call this helper.
#
# Callers invoke this via command substitution (`out=$(retry_http_code ...)`), which POSIX sh runs
# in a subshell — a side-channel global variable set inside this function would be lost the moment
# it returns, so the attempt count travels the only way that survives the subshell: printed on the
# same stdout line as the code, space-separated ("<code> <attempts>"). Split it back apart with
# plain parameter expansion (no external `cut`/`awk` needed):
#   out=$(retry_http_code 3 5 docker exec ... curl ... -w '%{http_code}' ...)
#   code=${out% *}
#   attempts=${out#* }
retry_http_code() {
  retry_max="$1"
  retry_backoff="$2"
  shift 2
  retry_attempt=1
  while :; do
    retry_code=$("$@" </dev/null 2>/dev/null)
    if [ "$retry_code" = "200" ] || [ "$retry_attempt" -ge "$retry_max" ]; then
      printf '%s %s' "$retry_code" "$retry_attempt"
      return 0
    fi
    sleep "$retry_backoff"
    retry_attempt=$((retry_attempt + 1))
  done
}

# --------------------------------------------------------------------------------------------
# Fake provider via compose override (W6, retrospective §5.3). `accept_provider_up` generates the
# fake-provider models.json into ${NEXTTIME_DATA}/accept/ and recreates llm-proxy /
# worker-supervisor / fake-llm with deploy/accept/docker-compose.fake.yml merged in;
# `accept_provider_restore` recreates the two production services from the root file alone.
# The production ${NEXTTIME_DATA}/config/llm-providers.yaml and
# ${NEXTTIME_DATA}/models/models.json are never touched.
# Scripts install `trap accept_provider_restore EXIT` (plus INT/TERM/HUP/PIPE handlers that
# restore and exit) *before* calling `accept_provider_up`, so a run that dies half-way — including
# a dropped ssh session — still leaves the host on its real provider.
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
  # The fake provider file is bind-mounted into llm-proxy (uid 10001) — same umask hazard as the
  # driver, same guard.
  require_world_readable "$PWD/config/llm-providers.fake.example.yaml" "fake provider file"
  mkdir -p "$NEXTTIME_DATA/accept" || return 1
  # llm-proxy (uid 10001) must traverse this directory: the override mounts it as /data/state and
  # /data/accept. Run-private files live in their own 0750 subdirectory (accept_s3.sh), never here.
  chmod 0755 "$NEXTTIME_DATA/accept" || return 1
  # The override mounts this directory as llm-proxy's /data/state: an empty provider store per run.
  rm -f "$NEXTTIME_DATA/accept/providers.json"
  if ! compose_accept run --rm --no-deps -T llm-proxy node dist/cli/gen-models.js \
      </dev/null >"$NEXTTIME_DATA/accept/models.json.tmp" 2>"$NEXTTIME_DATA/accept/gen-models.err"; then
    echo "accept: gen-models (fake provider) failed: $(tail -5 "$NEXTTIME_DATA/accept/gen-models.err")" >&2
    rm -f "$NEXTTIME_DATA/accept/models.json.tmp"
    return 1
  fi
  mv "$NEXTTIME_DATA/accept/models.json.tmp" "$NEXTTIME_DATA/accept/models.json" || return 1
  # Read inside spawned containers as uid 10001 (see require_driver for the same reasoning).
  chmod a+r "$NEXTTIME_DATA/accept/models.json"
  # Marked as switched *before* the recreate: `up` can succeed for llm-proxy and then fail on
  # worker-supervisor, and the caller's EXIT trap (installed before calling this function) must
  # still restore whatever did get recreated onto the override.
  ACCEPT_PROVIDER_SWITCHED=1
  if ! up_out=$(compose_accept --profile test up -d --force-recreate llm-proxy worker-supervisor fake-llm </dev/null 2>&1); then
    echo "accept: bringing up the fake provider failed: $(printf '%s' "$up_out" | tail -10)" >&2
    return 1
  fi
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

# chat_assistant_text <token> <chatId>: every assistant message of the chat, joined with spaces
# and lower-cased, printed on one line. Polls get-history until the text stops changing (up to
# ~10s): the Turn's `completed` metadata can reach the driver before the last assistant message
# is readable through get_chat_history (seen with a real model on the host — the final table
# landed a beat after `send-and-wait` returned), and a real model may also emit several assistant
# messages per Turn, so the *last* one alone is not the answer.
chat_assistant_text() {
  prev=""
  n=0
  while [ "$n" -lt 6 ]; do
    out=$(run_driver get-history "$1" "$2" "d.filter(m=>m.role==='assistant').map(m=>String(m.text||'')).join(' ').replace(/\\s+/g,' ').toLowerCase()")
    cur=$(parse_kv "$out" EXTRACTED)
    if [ -n "$cur" ] && [ "$cur" = "$prev" ]; then
      break
    fi
    prev=$cur
    n=$((n + 1))
    sleep 2
  done
  printf '%s' "$prev"
}

# reply_says_unavailable <lower-cased reply>: 1 when the reply says it could not get the answer
# ("无法…" / "not available" / …), else 0. A bounded flag for a real-model RUN line, so a miss reads
# as "the model said it could not see it" vs "it answered something else" without printing reply
# text (the repo and its run artifacts are public).
reply_says_unavailable() {
  case "$1" in
    *无法* | *不能* | *拿不到* | *看不到* | *没有权限* | *unavailable* | *"not available"* | *cannot* | *"can't"* | *"unable to"*) echo 1 ;;
    *) echo 0 ;;
  esac
}

# reply_says_running <lower-cased reply>: 1 when the reply states the container is running, else 0.
# A bare 运行 is not enough — the question itself asks for the "运行状态", so a reply echoing
# "运行状态：已停止" would match it. Negated or stopped states are checked first and win.
reply_says_running() {
  case "$1" in
    *"not running"* | *"isn't running"* | *未运行* | *没有运行* | *没在运行* | *不在运行* | *已停止* | *已退出* | *exited* | *stopped*) echo 0 ;;
    *running* | *运行中* | *正在运行*) echo 1 ;;
    *) echo 0 ;;
  esac
}
