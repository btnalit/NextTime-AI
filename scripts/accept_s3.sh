#!/bin/sh
# accept_s3.sh — S3 acceptance script (docs/development-tasks.md §S3.9: "采集 → 入口 agent 回答
# 「哪个服务依赖哪个」并 explain → Explorer 端点返回图 → Claude Code 经 MCP 观察同一图" — "退出 0
# 打印 S3 OK"). POSIX sh, run ON THE HOST from the checkout root — same conventions as
# scripts/accept_s1.sh/accept_s2.sh (this script's own structural template): every docker compose
# run/exec carries </dev/null, every kernel interaction runs through one mounted driver script
# inside a throwaway kernel-image container, secrets are held only in shell variables and printed
# only via redact(), an EXIT trap cleans up every temp file regardless of how the script
# terminates, and PASS/FAIL lines abort on the first real defect.
#
# Usage:
#   sh scripts/accept_s3.sh [--keep]
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s3.sh' </dev/null
#
# --keep leaves the resident entry container running and skips tearing anything down (workspace
# rows are always retained regardless — see cleanup_step).
#
# Preconditions (see docs/runbooks/host-accept-s3.md for the full walkthrough):
#   - `docker compose up -d` (or at least: postgres kernel llm-proxy egress-proxy worker-supervisor
#     agent-host docker-socket-proxy-collector) already running, plus
#     `docker compose --profile test up -d fake-llm` and the fake provider config swap
#     (docs/runbooks/host-agent-host.md §3 — same precondition accept_s1.sh's own header comment
#     documents).
#   - `${NEXTTIME_DATA}/secrets/gate_token` and the other host-bootstrap secrets already exist
#     (docs/runbooks/host-bootstrap.md) — this script does not generate them.
#
# Shared-state warning (read before running against a host that also runs a *real* host-inventory
# collector deployment): this script (a) overwrites
# ${NEXTTIME_DATA}/secrets/collector-host-inventory.token — the *same* Docker secret file path a
# real `collector-host-inventory` deployment on this host would use (docker-compose.yml's own
# `collector_host_inventory_token` secret definition; there is no per-invocation override for a
# Docker file-based secret) — with a freshly-minted service Handle scoped to this run's own
# throwaway workspace; and (b) deletes
# ${NEXTTIME_DATA}/collectors/host-inventory/host-inventory-source.json (the collector's own
# cached Source id — collectors/host-inventory/src/run.ts's `resolveSourceId` reads this file
# *without validating the cached id still resolves*, so a stale id from a previous run's now-
# unrelated workspace would otherwise make every `submit_observations` call in *this* run 404/403
# against the fresh workspace this script just created — the delete is required for this script to
# be safely re-runnable, not optional cleanup). Both are real operational side effects, not fixture
# writes under a scratch directory — same class of caveat docs/runbooks/host-explorer.md's own
# "信任边界" section documents for a different secret. Run this only in a dedicated
# verification environment, or accept that it will reassign the real collector's own Source
# lineage on its very next scheduled run.
#
# Toolset: identical rationale to accept_s1.sh/accept_s2.sh's own header comments — every kernel
# capability call and every Explorer/MCP HTTP call runs through one mounted driver script
# (DRIVER_JS below) inside a throwaway kernel-image container (`docker compose run --rm --no-deps
# -T kernel node /tmp/driver.mjs <subcommand> ...`), talking to the real running kernel over the
# `control` network (`http://kernel:8080/...`) — never through caddy (docs/development-tasks.md
# §S3.9 (d) is explicit: "call the kernel directly from the kernel image like other steps, not via
# caddy"). No `jq` dependency — every JSON field this script needs is extracted with a real
# `JS.parse()`/JS expression evaluated inside the same driver.mjs invocation that made the call
# (verbatim copy of accept_s2.sh's own driver.mjs `cap`/`send-and-wait`/`get-history`
# subcommands — see that script's own header comment for the design rationale — plus two new
# subcommands this script needs: `explorer` and `mcp`, same output-line conventions).
#
# Confidentiality (repo is public): every generated secret (the collector's service-Handle token,
# API keys) is held only in shell variables/files under ${NEXTTIME_DATA} for this process's
# lifetime and only ever printed via redact(); the one temp file this script creates in the repo
# checkout itself (the mounted driver.mjs) never contains a secret and is removed by the EXIT trap
# regardless of how the script terminates.

set -u

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *)
      echo "accept_s3: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "./docker-compose.yml" ]; then
  echo "accept_s3: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "accept_s3: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${NEXTTIME_DATA:-}" ]; then
  echo "accept_s3: .env must set NEXTTIME_DATA" >&2
  exit 1
fi

# --------------------------------------------------------------------------------------------
# PASS/FAIL helpers — abort the whole script on the first FAIL (a real defect), same contract
# accept_s1.sh uses.
# --------------------------------------------------------------------------------------------

pass() {
  printf 'PASS %s %s\n' "$1" "$2"
}

fail() {
  printf 'FAIL %s %s\n' "$1" "$2" >&2
  exit 1
}

redact() {
  prefix=$(printf '%s' "$1" | cut -c1-6)
  printf '%s...(redacted)' "$prefix"
}

parse_kv() {
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -n 1
}

# --------------------------------------------------------------------------------------------
# driver.mjs — mounted read-only into a throwaway kernel-image container per call (see file
# header above for why). Four subcommands: `cap`/`send-and-wait`/`get-history` are verbatim
# copies of accept_s2.sh's own driver.mjs (see that script's own header comment for their exact
# contracts); `explorer` and `mcp` are new for this script.
#   explorer <apiKey> <path>
#     GET http://kernel:8080<path> with `X-API-Key: <apiKey>` (docs/development-tasks.md §S3.9
#     (d): call the kernel directly, not via caddy — the Explorer HTTP routes themselves
#     (packages/kernel/src/interfaces/explorer-contract/) do X-API-Key auth exactly like the human
#     capability channel, just outside the /api/cap/<name> envelope). Prints HTTP_STATUS=/BODY=,
#     same convention as `cap`.
#   mcp <handleToken> <method> <paramsJson> [extractExpr]
#     POST http://kernel:8080/mcp — one JSON-RPC 2.0 request (packages/kernel/src/interfaces/mcp/
#     index.ts, StreamableHTTPServerTransport in stateless JSON-response mode). `Accept:
#     application/json, text/event-stream` is required by the SDK's own webStandardStreamableHttp
#     transport (406 otherwise); a stateless server with no `sessionIdGenerator` configured
#     (this kernel's own setup) skips both its session-id check and its "must send `initialize`
#     first" check entirely (`validateSession` returns immediately when `sessionIdGenerator ===
#     undefined` — verified by reading the installed SDK's own dist source, not assumed), so a
#     bare `tools/list`/`tools/call` request needs no prior handshake call. `enableJsonResponse:
#     true` server-side means the HTTP response is a single `application/json` body (never SSE)
#     for a one-request call, which every call this script makes is — prints HTTP_STATUS=/BODY=,
#     same convention as `cap`. Empty `handleToken` omits the Authorization header entirely (the
#     no-Handle → 401 check).
WS_CLIENT_HOST_PATH=$(mktemp /tmp/nt-accept-s3-driver.XXXXXX.mjs) || {
  echo "accept_s3: mktemp failed" >&2
  exit 1
}
# mktemp defaults to mode 0600 — the kernel image's own container process runs as a non-root uid
# that will not generally match whatever uid runs this script on the host, so the bind-mounted
# file needs to be world-readable (same reasoning as accept_s1.sh's own WS_CLIENT_HOST_PATH
# comment). Contains no secret — see this file's "Confidentiality" header comment.
chmod 644 "$WS_CLIENT_HOST_PATH"

cleanup_tmp() {
  rm -f "$WS_CLIENT_HOST_PATH"
}
trap cleanup_tmp EXIT INT TERM

cat >"$WS_CLIENT_HOST_PATH" <<'DRIVER_JS'
// driver.mjs — S3.9 acceptance driver (scripts/accept_s3.sh). See that script's own header
// comment for the `cap`/`send-and-wait`/`get-history`/`explorer`/`mcp` subcommand contracts.

const KERNEL_HTTP = 'http://kernel:8080';
const WS_URL = 'ws://kernel:8080/ws';
const RPC_TIMEOUT_MS = 30000;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error(`ws connect failed: ${url}`)));
  });
}

function idCounter() {
  let n = 0;
  return () => {
    n += 1;
    return n;
  };
}

function call(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`rpc timeout: ${method}`));
    }, RPC_TIMEOUT_MS);
    function onMessage(ev) {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.error) {
        reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      } else {
        resolve(msg.result);
      }
    }
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
  });
}

function onPush(ws, handler) {
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) return;
    if (typeof msg.method === 'string') handler(msg);
  });
}

function print(fields) {
  for (const [k, v] of Object.entries(fields)) console.log(`${k}=${v}`);
}

function printExtraction(parsed, expr) {
  if (!expr) return;
  try {
    const d = parsed;
    // eslint-disable-next-line no-eval -- expr is authored by this script's own caller, never
    // untrusted input; see driver.mjs's own header comment.
    const v = eval(expr);
    if (v === undefined || v === null) {
      console.log('EXTRACTED=');
    } else {
      console.log(`EXTRACTED=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  } catch (err) {
    console.log('EXTRACTED=');
    console.log(`EXTRACT_ERROR=${(err && err.message) || String(err)}`);
  }
}

async function cmdCap(args) {
  const [token, capabilityName, paramsJson, extractExpr] = args;
  const res = await fetch(`${KERNEL_HTTP}/api/cap/${capabilityName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: paramsJson && paramsJson.length > 0 ? paramsJson : '{}',
  });
  const text = await res.text();
  console.log(`HTTP_STATUS=${res.status}`);
  console.log(`BODY=${text}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  printExtraction(parsed, extractExpr);
}

async function cmdSendAndWait(args) {
  const [token, chatIdArg, text, timeoutMsArg] = args;
  const timeoutMs = Number(timeoutMsArg || 120000);
  const ws = await connect(WS_URL);
  const nextId = idCounter();
  await call(ws, nextId(), 'authenticate', { token });

  let chatId = chatIdArg;
  if (!chatId) {
    const chat = await call(ws, nextId(), 'new_chat', {});
    chatId = chat.id;
  }

  await call(ws, nextId(), 'subscribe_chat', { chatId, startAfter: '0' });

  let turnId;
  let turnStatus;
  let echoSeen = false;
  const settled = new Promise((resolve) => {
    onPush(ws, (msg) => {
      if (msg.method === 'chat.metadata' && msg.params?.chatId === chatId) {
        const md = msg.params.metadata ?? {};
        if (turnId && md.turnId === turnId && md.turnStatus) {
          turnStatus = md.turnStatus;
          resolve();
        }
      }
      if (msg.method === 'chat.message' && msg.params?.chatId === chatId) {
        const m = msg.params.message ?? {};
        if (m.role === 'assistant' && typeof m.text === 'string' && m.text.includes('echo:')) {
          echoSeen = true;
        }
      }
    });
  });

  const sendResult = await call(ws, nextId(), 'send_chat_message', { chatId, text });
  turnId = sendResult.turnId;

  await Promise.race([
    settled,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('turn did not settle before timeout')), timeoutMs),
    ),
  ]).catch(() => {
    // Timeout is reported via TURN_STATUS=(empty), not a thrown ERROR= — same convention
    // accept_s2.sh's own driver.mjs already establishes.
  });

  const history = await call(ws, nextId(), 'get_chat_history', { chatId });

  print({
    CHAT_ID: chatId,
    TURN_ID: turnId,
    TURN_STATUS: turnStatus ?? '',
    ECHO_SEEN: echoSeen ? 1 : 0,
    HISTORY_COUNT: history.items.length,
  });
  ws.close();
}

async function cmdGetHistory(args) {
  const [token, chatId, extractExpr] = args;
  const ws = await connect(WS_URL);
  const nextId = idCounter();
  await call(ws, nextId(), 'authenticate', { token });
  const history = await call(ws, nextId(), 'get_chat_history', { chatId });
  console.log(`RESULT=${JSON.stringify(history.items)}`);
  printExtraction(history.items, extractExpr);
  ws.close();
}

async function cmdExplorer(args) {
  const [apiKey, path] = args;
  const res = await fetch(`${KERNEL_HTTP}${path}`, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
  });
  const text = await res.text();
  console.log(`HTTP_STATUS=${res.status}`);
  console.log(`BODY=${text}`);
}

async function cmdMcp(args) {
  const [token, method, paramsJson, extractExpr] = args;
  const res = await fetch(`${KERNEL_HTTP}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: paramsJson && paramsJson.length > 0 ? JSON.parse(paramsJson) : {},
    }),
  });
  const text = await res.text();
  console.log(`HTTP_STATUS=${res.status}`);
  console.log(`BODY=${text}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  printExtraction(parsed, extractExpr);
}

const COMMANDS = {
  cap: cmdCap,
  'send-and-wait': cmdSendAndWait,
  'get-history': cmdGetHistory,
  explorer: cmdExplorer,
  mcp: cmdMcp,
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const fn = COMMANDS[cmd];
  if (!fn) throw new Error(`unknown subcommand: ${cmd}`);
  await fn(rest);
}

// Flush stdout before exiting: inside a container stdout is not a synchronous pipe, and
// process.exit() right after a large console.log (explain on a collector Fact is >400KB)
// drops the tail — the EXTRACTED= line — of the output. write('', cb) fires only after
// every earlier chunk has been flushed.
main()
  .then(() => process.stdout.write('', () => process.exit(0)))
  .catch((err) => {
    console.log(`ERROR=${(err && err.message) || String(err)}`);
    process.stdout.write('', () => process.exit(1));
  });
DRIVER_JS

# Runs one driver.mjs subcommand in a throwaway kernel-image container, on the control network,
# with the driver script mounted read-only. Combines stdout+stderr into one blob (same convention
# as accept_s1.sh's compose_run_ws).
run_driver() {
  docker compose run --rm --no-deps -T -v "$WS_CLIENT_HOST_PATH:/tmp/driver.mjs:ro" kernel \
    node /tmp/driver.mjs "$@" </dev/null 2>&1
}

# One capability call. Prints HTTP_STATUS=/BODY=/EXTRACTED= — callers extract with parse_kv.
cap() {
  run_driver cap "$1" "$2" "$3" "${4:-}"
}

# One Explorer HTTP call (X-API-Key). Prints HTTP_STATUS=/BODY=.
explorer() {
  run_driver explorer "$1" "$2"
}

# One MCP JSON-RPC call. Prints HTTP_STATUS=/BODY=/EXTRACTED=.
mcp() {
  run_driver mcp "$1" "$2" "$3" "${4:-}"
}

# GET /resident/<principalId> via the kernel image's own fetch() against worker-supervisor —
# verbatim copy of accept_s1.sh's own resident_status helper.
resident_status() {
  docker compose run --rm --no-deps -T kernel node -e "
const token = require('fs').readFileSync('/run/secrets/internal_token', 'utf8').trim();
fetch('http://worker-supervisor:8081/resident/$1', { headers: { authorization: 'Bearer ' + token } }).then(async (r) => {
  if (r.status === 404) { console.log('FOUND=0'); return; }
  if (!r.ok) { console.log('FOUND=error status=' + r.status); return; }
  const j = await r.json();
  console.log('FOUND=1');
  console.log('RESTARTS=' + j.restarts);
  console.log('RUNNING=' + j.running);
});
" </dev/null 2>&1
}

resident_stop() {
  docker compose run --rm --no-deps -T kernel node -e "
const token = require('fs').readFileSync('/run/secrets/internal_token', 'utf8').trim();
fetch('http://worker-supervisor:8081/resident/stop', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify({ principalId: '$1' }),
}).then((r) => console.log('STATUS=' + r.status));
" </dev/null 2>&1
}

# --------------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------------

preflight_step() {
  required_services="postgres kernel llm-proxy egress-proxy worker-supervisor agent-host fake-llm docker-socket-proxy-collector"
  running=$(docker compose --profile test ps --status running --services 2>/dev/null)
  if [ -z "$running" ]; then
    fail "preflight-services" "docker compose --profile test ps returned nothing — is the stack up? (docker compose up -d && docker compose --profile test up -d fake-llm)"
  fi
  missing=""
  for s in $required_services; do
    if ! printf '%s\n' "$running" | grep -qx "$s"; then
      missing="$missing $s"
    fi
  done
  if [ -n "$missing" ]; then
    fail "preflight-services" "not running:$missing"
  fi
  pass "preflight-services" "running: $required_services"

  providers_file="${NEXTTIME_DATA}/config/llm-providers.yaml"
  if [ ! -f "$providers_file" ]; then
    fail "preflight-fake-provider" "$providers_file not found — see docs/runbooks/host-agent-host.md §3"
  fi
  if ! grep -qE '^[[:space:]]*fake:[[:space:]]*$' "$providers_file"; then
    fail "preflight-fake-provider" "no 'fake:' provider entry in $providers_file — see docs/runbooks/host-agent-host.md §3"
  fi
  pass "preflight-fake-provider" "fake provider configured in $providers_file"

  migrate_out=$(docker compose run --rm --no-deps -T kernel node dist/cli/migrate.js --dry-run </dev/null 2>&1)
  migrate_rc=$?
  if [ "$migrate_rc" -ne 0 ]; then
    fail "preflight-migrations" "migrate --dry-run exited $migrate_rc: $(printf '%s' "$migrate_out" | tail -5)"
  fi
  case "$migrate_out" in
    *"nothing pending"*) pass "preflight-migrations" "up to date" ;;
    *) fail "preflight-migrations" "pending migrations reported: $(printf '%s' "$migrate_out" | tail -10)" ;;
  esac

  build_out=$(docker compose build collector-host-inventory 2>&1)
  build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    fail "preflight-collector-build" "docker compose build collector-host-inventory failed: $(printf '%s' "$build_out" | tail -20)"
  fi
  pass "preflight-collector-build" "collector-host-inventory image built"
}

bootstrap_step() {
  ts=$(date +%s)
  ws_name="accept-s3-$ts"

  # --entry-model pins the entry agent to the fake provider (same reasoning as accept_s2.sh's own
  # bootstrap_step comment: without it, the seeded entry WorkerDefinition has no `model` and the
  # runtime falls back to the host's default provider, which fake-llm never sees).
  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js create-workspace --name "$ws_name" --owner owner --entry-model "${ACCEPT_S3_MODEL:-fake/fake-echo}" </dev/null 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "bootstrap-workspace" "create-workspace exited $rc: $(printf '%s' "$out" | tail -5)"
  fi
  WORKSPACE_ID=$(printf '%s\n' "$out" | sed -n 's/^workspace created: //p')
  OWNER_ID=$(printf '%s\n' "$out" | sed -n 's/^owner principal:   //p')
  OWNER_KEY=$(printf '%s\n' "$out" | awk '/^API key/{getline; print; exit}')
  if [ -z "$WORKSPACE_ID" ] || [ -z "$OWNER_ID" ] || [ -z "$OWNER_KEY" ]; then
    fail "bootstrap-workspace" "could not parse create-workspace output: $(printf '%s' "$out" | tail -10)"
  fi
  pass "bootstrap-workspace" "workspace=$WORKSPACE_ID owner=$OWNER_ID key=$(redact "$OWNER_KEY")"
}

# S3.9 (a): seed ops-assets v1 into the fresh workspace — docs/runbooks/host-collector.md §1's own
# operator step, driven here instead of by hand.
seed_domain_pack_step() {
  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js seed-domain-pack \
    --workspace "$WORKSPACE_ID" --principal "$OWNER_ID" --pack-name ops-assets --file-name ops-assets-v1.yaml \
    </dev/null 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "seed-domain-pack" "seed-domain-pack exited $rc: $(printf '%s' "$out" | tail -10)"
  fi
  case "$out" in
    *"domain pack published: ops-assets"*) : ;;
    *) fail "seed-domain-pack" "unexpected output: $out" ;;
  esac
  pass "seed-domain-pack" "$(printf '%s' "$out" | tail -1)"
}

# S3.9 (b): mint the collector's own service Handle (docs/runbooks/host-collector.md §2) into
# ${NEXTTIME_DATA}/secrets/collector-host-inventory.token, and reset the collector's cached
# Source-id state file so this run's `register_source` targets *this* fresh workspace — see this
# script's own header comment ("Shared-state warning") for why the reset is required, not optional.
collector_fixtures_step() {
  rm -f "${NEXTTIME_DATA}/collectors/host-inventory/host-inventory-source.json"
  mkdir -p "${NEXTTIME_DATA}/collectors/host-inventory"

  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js issue-service-handle \
    --workspace "$WORKSPACE_ID" --name host-inventory --scope register_source,submit_observations \
    </dev/null 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "collector-issue-service-handle" "issue-service-handle exited $rc: $(printf '%s' "$out" | tail -10)"
  fi
  collector_token=$(printf '%s\n' "$out" | tail -n 1)
  if [ -z "$collector_token" ]; then
    fail "collector-issue-service-handle" "could not parse a Handle token from output: $(printf '%s' "$out" | tail -10)"
  fi
  mkdir -p "${NEXTTIME_DATA}/secrets"
  printf '%s' "$collector_token" >"${NEXTTIME_DATA}/secrets/collector-host-inventory.token"
  chmod 640 "${NEXTTIME_DATA}/secrets/collector-host-inventory.token"
  pass "collector-issue-service-handle" "token minted and written to \${NEXTTIME_DATA}/secrets/collector-host-inventory.token: $(redact "$collector_token")"
}

# Runs `collector-host-inventory --once`, returning its combined stdout+stderr — callers parse
# the "run complete" JSON line out of it (collectors/host-inventory/src/run.ts's own
# `consoleLogger`: one `console.log(JSON.stringify({level:'info', message:'run complete',
# objectsUpserted, factsAsserted, factsSuperseded}))` line per run).
run_collector_once() {
  docker compose run --rm --no-deps -T collector-host-inventory node dist/index.js --once </dev/null 2>&1
}

collector_run_complete_field() {
  # $1 = combined collector output, $2 = field name (objectsUpserted|factsAsserted|factsSuperseded)
  printf '%s\n' "$1" | grep '"message":"run complete"' | tail -1 | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p"
}

# S3.9 (b), first half: run once, assert it succeeded and actually wrote something, then assert
# "Container runs_on Host" Facts exist in the graph (the acceptance sentence's own literal words).
collector_first_run_step() {
  out=$(run_collector_once)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "collector-first-run" "collector-host-inventory --once exited $rc: $(printf '%s' "$out" | tail -20)"
  fi
  case "$out" in
    *'"message":"run complete"'*) : ;;
    *) fail "collector-first-run" "no 'run complete' line in output: $(printf '%s' "$out" | tail -20)" ;;
  esac
  facts_asserted=$(collector_run_complete_field "$out" factsAsserted)
  objects_upserted=$(collector_run_complete_field "$out" objectsUpserted)
  case "$facts_asserted" in
    '' | 0) fail "collector-first-run" "factsAsserted=$facts_asserted on the first-ever run (expected > 0): $(printf '%s' "$out" | tail -20)" ;;
  esac
  pass "collector-first-run" "objectsUpserted=$objects_upserted factsAsserted=$facts_asserted"

  out=$(cap "$OWNER_KEY" search '{"query":"","objectType":"Container"}' "d.result.items[0]&&d.result.items[0].id||''")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "collector-container-search" "search HTTP $status: $(parse_kv "$out" BODY)"
  container_id=$(parse_kv "$out" EXTRACTED)
  [ -n "$container_id" ] || fail "collector-container-search" "no Container Object found after the collector's first run: $(parse_kv "$out" BODY)"
  pass "collector-container-search" "containerId=$container_id"

  out=$(cap "$OWNER_KEY" traverse "{\"fromId\":\"$container_id\",\"linkType\":\"runs_on\",\"depth\":1}" "d.result.edges.length")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "collector-runs-on-host" "traverse HTTP $status: $(parse_kv "$out" BODY)"
  edge_count=$(parse_kv "$out" EXTRACTED)
  [ -n "$edge_count" ] && [ "$edge_count" -gt 0 ] 2>/dev/null || fail "collector-runs-on-host" "no 'runs_on' edge from Container $container_id — S3.9 acceptance requires 'Container runs_on Host' Facts to exist: $(parse_kv "$out" BODY)"
  pass "collector-runs-on-host" "Container $container_id runs_on Host — $edge_count edge(s)"
}

# S3.9 (b), second half: run again, assert idempotency (docs/runbooks/host-collector.md §4.4's own
# acceptance: "第二次 factsAsserted 应为 0"). The task brief's own wording is "factsUnchanged>0,
# factsSuperseded=0" — `submit_observations`' real wire result does carry a `factsUnchanged` field
# (application/gateway/ingest-handlers.ts), but the collector's own `consoleLogger` summary
# (collectors/host-inventory/src/run.ts, owned by another concurrent task — collectors/
# host-inventory/** is off-limits here) never reads or logs it, only objectsUpserted/
# factsAsserted/factsSuperseded — so this asserts the equivalent, fully-observable signal instead:
# factsAsserted===0 && factsSuperseded===0 on a run that is only possible when every one of this
# run's `assertFact` calls took the `unchanged: true` no-op path (substrate/graph/sql-store.ts) —
# i.e. exactly "factsUnchanged > 0, factsSuperseded = 0" for every fact this collector observes,
# just not literally printed under that field name. Also asserts no open Conflict was opened.
collector_second_run_step() {
  out=$(run_collector_once)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "collector-second-run" "collector-host-inventory --once exited $rc: $(printf '%s' "$out" | tail -20)"
  fi
  facts_asserted=$(collector_run_complete_field "$out" factsAsserted)
  facts_superseded=$(collector_run_complete_field "$out" factsSuperseded)
  if [ "$facts_asserted" != "0" ] || [ "$facts_superseded" != "0" ]; then
    fail "collector-second-run-idempotent" "second run: factsAsserted=$facts_asserted factsSuperseded=$facts_superseded (expected both 0 — every fact should have resolved 'unchanged'): $(printf '%s' "$out" | tail -20)"
  fi
  pass "collector-second-run-idempotent" "factsAsserted=0 factsSuperseded=0 (every observation resolved unchanged)"

  out=$(cap "$OWNER_KEY" list_conflicts '{"status":"open"}' "d.result.items.length")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "collector-no-open-conflicts" "list_conflicts HTTP $status: $(parse_kv "$out" BODY)"
  open_count=$(parse_kv "$out" EXTRACTED)
  [ "$open_count" = "0" ] || fail "collector-no-open-conflicts" "$open_count open Conflict(s) after two identical collector runs (expected 0): $(parse_kv "$out" BODY)"
  pass "collector-no-open-conflicts" "0 open Conflicts"
}

# S3.9 (c): "哪个服务依赖哪个" — the entry agent's chat reply (deploy/fake-llm/server.mjs's
# `entryDependencyChatScenario`), plus an independent `explain` on a `depends_on` Fact resolving to
# the collector's own Source. The Fact `explain` targets is *not* parsed out of the chat transcript
# (message.content's tool-call/tool-result shape is an internal detail this script does not need
# to depend on) — it is independently rediscovered via the same direct traverse this script's own
# `collector_first_run_step` already used, just filtered to the `kernel` Container specifically
# (this repo's own docker-compose.yml declares `kernel: depends_on: {postgres: ...}` — a real,
# always-true relationship on any running stack, not a fixture — see the fake-llm scenario's own
# doc comment for the full reasoning). `KERNEL_CONTAINER_ID`/`DEPENDS_ON_FACT_ID` are reused by
# mcp_step below.
chat_dependency_step() {
  chat_out=$(run_driver send-and-wait "$OWNER_KEY" "" "哪个服务依赖哪个" 90000)
  OWNER_CHAT_ID=$(parse_kv "$chat_out" CHAT_ID)
  [ -n "$OWNER_CHAT_ID" ] || fail "chat-dependency" "no CHAT_ID from send-and-wait: $chat_out"
  turn_status=$(parse_kv "$chat_out" TURN_STATUS)
  [ "$turn_status" = "completed" ] || fail "chat-dependency" "turn status=$turn_status (expected completed): $chat_out"

  history_out=$(run_driver get-history "$OWNER_KEY" "$OWNER_CHAT_ID" "(d.filter(m=>m.role==='assistant').pop()||{}).text||''")
  last_reply=$(parse_kv "$history_out" EXTRACTED)
  case "$last_reply" in
    *"did not resolve"* | "")
      fail "chat-dependency-reply" "entry agent's dependency chat did not resolve — see docs/runbooks/host-accept-s3.md (last assistant reply: '$last_reply')"
      ;;
  esac
  case "$last_reply" in
    *depends_on* | *依赖*) : ;;
    *) fail "chat-dependency-reply" "reply does not read as a dependency statement: '$last_reply'" ;;
  esac
  pass "chat-dependency-reply" "entry agent replied: $last_reply"

  out=$(cap "$OWNER_KEY" search '{"query":"","objectType":"Container"}' "d.result.items.find(i=>i.identityKey&&i.identityKey.serviceName==='kernel')&&d.result.items.find(i=>i.identityKey&&i.identityKey.serviceName==='kernel').id||''")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "chat-dependency-search-kernel" "search HTTP $status: $(parse_kv "$out" BODY)"
  KERNEL_CONTAINER_ID=$(parse_kv "$out" EXTRACTED)
  [ -n "$KERNEL_CONTAINER_ID" ] || fail "chat-dependency-search-kernel" "no Container with identityKey.serviceName='kernel' found: $(parse_kv "$out" BODY)"
  pass "chat-dependency-search-kernel" "kernel containerId=$KERNEL_CONTAINER_ID"

  out=$(cap "$OWNER_KEY" traverse "{\"fromId\":\"$KERNEL_CONTAINER_ID\",\"linkType\":\"depends_on\",\"depth\":1}" "d.result.edges[0]&&d.result.edges[0].linkId||''")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "chat-dependency-traverse" "traverse HTTP $status: $(parse_kv "$out" BODY)"
  DEPENDS_ON_FACT_ID=$(parse_kv "$out" EXTRACTED)
  [ -n "$DEPENDS_ON_FACT_ID" ] || fail "chat-dependency-traverse" "no depends_on edge from kernel Container $KERNEL_CONTAINER_ID: $(parse_kv "$out" BODY)"
  pass "chat-dependency-traverse" "depends_on Fact=$DEPENDS_ON_FACT_ID (kernel -> postgres)"

  out=$(cap "$OWNER_KEY" explain "{\"nodeId\":\"$DEPENDS_ON_FACT_ID\"}" "d.result.activity.observations[0]&&d.result.activity.observations[0].source&&d.result.activity.observations[0].source.kind||''")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "chat-dependency-explain" "explain HTTP $status: $(parse_kv "$out" BODY)"
  source_kind=$(parse_kv "$out" EXTRACTED)
  [ "$source_kind" = "host-inventory-collector" ] || fail "chat-dependency-explain" "explain($DEPENDS_ON_FACT_ID) resolved to source.kind='$source_kind', expected 'host-inventory-collector': $(parse_kv "$out" BODY)"
  pass "chat-dependency-explain" "explain(depends_on Fact) resolves to the collector's own Source (kind=host-inventory-collector)"
}

# S3.9 (d): three Explorer endpoints, called directly against the kernel image (not via caddy —
# the task brief's own instruction), authenticated as the workspace owner's own X-API-Key (the
# same human-channel auth the capability calls above already use, just outside the /api/cap/<name>
# envelope — packages/kernel/src/interfaces/explorer-contract/index.ts's own `guarded()`).
explorer_step() {
  out=$(explorer "$OWNER_KEY" "/api/graph/nodes")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "explorer-graph-nodes" "GET /api/graph/nodes HTTP $status: $(parse_kv "$out" BODY)"
  pass "explorer-graph-nodes" "200 (graph returned)"

  out=$(explorer "$OWNER_KEY" "/api/decisions")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "explorer-decisions" "GET /api/decisions HTTP $status: $(parse_kv "$out" BODY)"
  pass "explorer-decisions" "200"

  out=$(explorer "$OWNER_KEY" "/api/provenance?node_id=$DEPENDS_ON_FACT_ID")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "explorer-provenance" "GET /api/provenance HTTP $status: $(parse_kv "$out" BODY)"
  pass "explorer-provenance" "200 (provenance graph for the depends_on Fact returned)"
}

# S3.9 (e): mint an `interactive`-session Handle via `issue_handle`, then reach the same graph
# through MCP (`tools/list` + a real `traverse` call) — Claude Code's own connection shape
# (docs/howto-connect-claude-code.md). A no-Handle call must 401.
mcp_step() {
  out=$(cap "$OWNER_KEY" issue_handle '{"sessionKind":"interactive"}' "d.result.handle")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "mcp-issue-handle" "issue_handle HTTP $status: $(parse_kv "$out" BODY)"
  MCP_HANDLE=$(parse_kv "$out" EXTRACTED)
  [ -n "$MCP_HANDLE" ] || fail "mcp-issue-handle" "no Handle in response: $(parse_kv "$out" BODY)"
  pass "mcp-issue-handle" "interactive Handle minted: $(redact "$MCP_HANDLE")"

  out=$(mcp "$MCP_HANDLE" "tools/list" "" "d.result.tools.map(t=>t.name).sort().join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "mcp-tools-list" "tools/list HTTP $status: $(parse_kv "$out" BODY)"
  tool_names=$(parse_kv "$out" EXTRACTED)
  case ",$tool_names," in
    *,traverse,*) : ;;
    *) fail "mcp-tools-list" "'traverse' not in tools/list result: $tool_names" ;;
  esac
  pass "mcp-tools-list" "tools=$tool_names"

  out=$(mcp "$MCP_HANDLE" "tools/call" "{\"name\":\"traverse\",\"arguments\":{\"fromId\":\"$KERNEL_CONTAINER_ID\",\"linkType\":\"depends_on\",\"depth\":1}}" "JSON.stringify({isError: d.result.isError===true, edges: JSON.parse(d.result.content[0].text).edges.length})")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "mcp-traverse" "tools/call(traverse) HTTP $status: $(parse_kv "$out" BODY)"
  call_result=$(parse_kv "$out" EXTRACTED)
  case "$call_result" in
    *'"isError":true'*) fail "mcp-traverse" "tools/call(traverse) returned isError:true: $(parse_kv "$out" BODY)" ;;
  esac
  case "$call_result" in
    *'"edges":0'*) fail "mcp-traverse" "tools/call(traverse) returned 0 edges — expected the same depends_on edge chat_dependency_step already found: $(parse_kv "$out" BODY)" ;;
  esac
  pass "mcp-traverse" "MCP traverse sees the same graph: $call_result"

  out=$(mcp "" "tools/list" "" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "401" ] || fail "mcp-no-handle" "POST /mcp with no Authorization header -> HTTP $status (expected 401): $(parse_kv "$out" BODY)"
  pass "mcp-no-handle" "no Handle -> 401"
}

cleanup_step() {
  if [ "$KEEP" -eq 1 ]; then
    echo "cleanup: --keep set, leaving the owner's entry container running"
  else
    resident_stop "$OWNER_ID" >/dev/null 2>&1
    echo "cleanup: stopped the owner's entry container via the supervisor API"
  fi
  # Workspace/principal/graph/chat/audit rows are the audit trail (design doc §12) — left in place
  # on purpose, same precedent as accept_s1.sh/accept_s2.sh's own cleanup_step. Periodic cleanup:
  # sh scripts/delete-workspaces-matching.sh '^accept-s3' --yes.
  pass "cleanup" "workspace retained: $WORKSPACE_ID (clean up periodically with: sh scripts/delete-workspaces-matching.sh '^accept-s3' --yes)"
}

# --------------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------------

preflight_step
bootstrap_step
seed_domain_pack_step
collector_fixtures_step
collector_first_run_step
collector_second_run_step
chat_dependency_step
explorer_step
mcp_step
cleanup_step

echo "S3 OK"
exit 0
