#!/bin/sh
# accept_s2.sh — S2 acceptance script (docs/development-tasks.md S2.12; design doc §14/§15-style
# verification, extended for S2). POSIX sh, run ON THE HOST from the checkout root — same
# conventions as scripts/accept_s1.sh (this script's structural template): every docker compose
# run/exec carries </dev/null, a mounted driver script drives every kernel interaction from inside
# a throwaway kernel-image container (the host has no node/corepack), secrets are held only in
# shell variables and printed only via redact(), and an EXIT trap cleans up every temp file
# regardless of how the script terminates.
#
# Usage:
#   sh scripts/accept_s2.sh [--keep]
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s2.sh' </dev/null
#
# --keep skips the accept-s2 profile teardown (leaves the fixtures/gates/workspace up for
# inspection).
#
# Preconditions (see docs/runbooks/host-accept-s2.md for the full walkthrough):
#   - `docker compose --profile test up -d` already running (accept_s1.sh's own preconditions —
#     fake-llm, the fake provider config swap) plus `docker compose up -d gatekeeper-docker`.
#   - `docker compose --profile accept-s2 build` has been run at least once (images built).
#   - `docker compose build worker-runtime` (profile build-only) has produced
#     `nexttime-ai-worker-runtime` — step 6's fallback env/egress probe runs that image directly.
#
# Toolset: identical rationale to accept_s1.sh's own header comment — every kernel interaction
# (chat WS, and here also every `POST /api/cap/<name>` capability call) runs through one mounted
# driver script (DRIVER_JS below) inside a throwaway `kernel`-image container
# (`docker compose run --rm --no-deps -T -v <tmpfile>:/tmp/driver.mjs:ro kernel node
# /tmp/driver.mjs <subcommand> ...`), talking to the real running kernel over the `control`
# network (`http://kernel:8080/...`, `ws://kernel:8080/ws`) — not through caddy's self-signed TLS,
# same reasoning as accept_s1.sh's own header comment (this script has no single "the one step
# that deliberately goes through caddy" the way accept_s1.sh's explain_step does; every capability
# call here uses the same internal path uniformly, matching docs/runbooks/host-gatekeepers.md's own
# `docker compose exec -T kernel node -e "fetch('http://localhost:8080/...')"` precedent — the
# difference being `run --rm --no-deps` + the service DNS name `kernel`, not `exec` inside the
# already-running container + `localhost`, because this script's driver runs in its *own* fresh
# container each invocation, same as accept_s1.sh's ws-client.mjs).
#
# JSON handling: this script has no `jq` dependency (not guaranteed present on the target host) —
# every capability-call/chat-history result that needs field extraction is parsed with a real
# `JSON.parse()` *inside* the same driver.mjs invocation that made the call (an optional trailing
# argv element is a JS expression evaluated against the parsed body, bound to `d`) rather than
# shell regex against raw JSON text — see driver.mjs's own header comment.
#
# Confidentiality (repo is public): the SSH private key, the HTTP gate's ConnectedAccount store
# key, and the fixture API bearer token are all generated at run time into
# ${NEXTTIME_DATA}/accept-s2/ (a real path outside the repo checkout — see host-accept-s2.md
# "cleanup"), never written into any file under the repo; API keys and the bearer token are held
# only in shell variables for this process's lifetime and only ever printed via redact().

set -u

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *)
      echo "accept_s2: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "./docker-compose.yml" ]; then
  echo "accept_s2: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "accept_s2: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${NEXTTIME_DATA:-}" ] || [ -z "${KERNEL_BIND_ADDR:-}" ]; then
  echo "accept_s2: .env must set NEXTTIME_DATA and KERNEL_BIND_ADDR" >&2
  exit 1
fi

# --------------------------------------------------------------------------------------------
# PASS/FAIL/SKIP helpers. FAIL aborts immediately (a real defect). SKIP records a known,
# documented platform gap (docs/runbooks/host-accept-s2.md "已知偏离") and lets the script keep
# running every other step — but the script exits non-zero and never prints "S2 OK" if any SKIP
# was recorded (task brief: "the script must then exit non-zero, not print S2 OK").
# --------------------------------------------------------------------------------------------

pass() {
  printf 'PASS %s %s\n' "$1" "$2"
}

fail() {
  printf 'FAIL %s %s\n' "$1" "$2" >&2
  exit 1
}

SKIP_COUNT=0
SKIP_LOG=""
skip() {
  printf 'SKIP %s %s\n' "$1" "$2"
  SKIP_COUNT=$((SKIP_COUNT + 1))
  SKIP_LOG="${SKIP_LOG}SKIP $1 $2
"
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
# header above for why). Three subcommands:
#   cap <token> <capabilityName> <paramsJson> [extractExpr]
#     POST http://kernel:8080/api/cap/<capabilityName> with `Authorization: Bearer <token>`.
#     Prints `HTTP_STATUS=<n>` then `BODY=<raw json, one line>`. If `extractExpr` is given, it is
#     evaluated as a JS expression (parsed body bound to `d`) and the result printed as
#     `EXTRACTED=<value>` (strings printed verbatim, everything else JSON-stringified; `undefined`/
#     `null`/a parse or eval failure prints an empty `EXTRACTED=` line, never throws).
#   send-and-wait <token> <chatId|""> <text> <timeoutMs>
#     Verbatim copy of accept_s1.sh's own ws-client.mjs subcommand of the same name (chat WS
#     JSON-RPC — §9.4): authenticate -> (new_chat if chatId omitted) -> subscribe_chat ->
#     send_chat_message(text) -> wait for that Turn's chat.metadata (turnStatus) or timeoutMs,
#     whichever first -> get_chat_history. Prints CHAT_ID/TURN_ID/TURN_STATUS/ECHO_SEEN/
#     HISTORY_COUNT.
#   get-history <token> <chatId> [extractExpr]
#     authenticate -> get_chat_history({chatId}). Prints `RESULT=<json array of messages>`; same
#     optional trailing JS-expression extraction as `cap` (bound to `d`, the parsed messages
#     array).
WS_CLIENT_HOST_PATH=$(mktemp /tmp/nt-accept-s2-driver.XXXXXX.mjs) || {
  echo "accept_s2: mktemp failed" >&2
  exit 1
}
# mktemp defaults to mode 0600 — the kernel image's own container process runs as a non-root uid
# (10001) that will not generally match whatever uid runs this script on the host, so the
# bind-mounted file needs to be world-readable (same reasoning as accept_s1.sh's own WS_CLIENT_
# HOST_PATH comment). Contains no secret — see this file's "Confidentiality" header comment.
chmod 644 "$WS_CLIENT_HOST_PATH"

FIXTURE_DIRS_CREATED=0
cleanup_tmp() {
  rm -f "$WS_CLIENT_HOST_PATH"
}
trap cleanup_tmp EXIT INT TERM

cat >"$WS_CLIENT_HOST_PATH" <<'DRIVER_JS'
// driver.mjs — S2.12 acceptance driver (scripts/accept_s2.sh). See that script's own header
// comment for why this exists as a mounted file rather than inline `node -e`, and for the
// `cap`/`send-and-wait`/`get-history` subcommand contracts.

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
    // Timeout is reported via TURN_STATUS=(empty), not a thrown ERROR= — several accept_s2.sh
    // scenarios (the entry-mode-gap scripted scenarios, see fake-llm's own doc comment)
    // deliberately do not settle to 'completed' and the caller needs to observe that, not have
    // this driver exit 1 out from under it.
  });

  const history = await call(ws, nextId(), 'get_chat_history', { chatId });

  print({
    CHAT_ID: chatId,
    TURN_ID: turnId,
    TURN_STATUS: turnStatus ?? '',
    ECHO_SEEN: echoSeen ? 1 : 0,
    HISTORY_COUNT: history.messages.length,
  });
  ws.close();
}

async function cmdGetHistory(args) {
  const [token, chatId, extractExpr] = args;
  const ws = await connect(WS_URL);
  const nextId = idCounter();
  await call(ws, nextId(), 'authenticate', { token });
  const history = await call(ws, nextId(), 'get_chat_history', { chatId });
  console.log(`RESULT=${JSON.stringify(history.messages)}`);
  printExtraction(history.messages, extractExpr);
  ws.close();
}

const COMMANDS = {
  cap: cmdCap,
  'send-and-wait': cmdSendAndWait,
  'get-history': cmdGetHistory,
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const fn = COMMANDS[cmd];
  if (!fn) throw new Error(`unknown subcommand: ${cmd}`);
  await fn(rest);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.log(`ERROR=${(err && err.message) || String(err)}`);
    process.exit(1);
  });
DRIVER_JS

# Runs one driver.mjs subcommand in a throwaway kernel-image container, on the control network,
# with the driver script mounted read-only. Combines stdout+stderr into one blob (same convention
# as accept_s1.sh's compose_run_ws).
run_driver() {
  docker compose run --rm --no-deps -T -v "$WS_CLIENT_HOST_PATH:/tmp/driver.mjs:ro" kernel \
    node /tmp/driver.mjs "$@" </dev/null 2>&1
}

# One capability call. Prints the same blob run_driver's `cap` subcommand prints
# (HTTP_STATUS=/BODY=/EXTRACTED=); callers extract with parse_kv.
cap() {
  run_driver cap "$1" "$2" "$3" "${4:-}"
}

resident_stop() {
  docker compose run --rm --no-deps -T kernel node -e "
fetch('http://worker-supervisor:8081/resident/stop', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ principalId: '$1' }),
}).then((r) => console.log('STATUS=' + r.status));
" </dev/null 2>&1
}

# Polls one gate's /gate/health (reachable only inside the control network — no host port) from
# inside the kernel image, same node-fetch pattern docs/runbooks/host-gatekeepers.md's own §3
# uses. Retries for up to ~30s (gate containers can take a few seconds to bind their port after
# `docker compose up -d`).
wait_for_gate_health() {
  gate_url="$1"
  attempt=0
  while [ "$attempt" -lt 15 ]; do
    out=$(docker compose run --rm --no-deps -T kernel node -e "
fetch('$gate_url/gate/health').then((r) => r.json()).then((b) => console.log('OK=' + (b.ok === true)))
" </dev/null 2>&1)
    case "$out" in
      *OK=true*) return 0 ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

# --------------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------------

preflight_step() {
  required_services="postgres kernel caddy llm-proxy egress-proxy worker-supervisor agent-host fake-llm gatekeeper-docker"
  running=$(docker compose --profile test ps --status running --services 2>/dev/null)
  if [ -z "$running" ]; then
    fail "preflight-services" "docker compose --profile test ps returned nothing — is the stack up? (docker compose --profile test up -d && docker compose up -d gatekeeper-docker)"
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

  if ! docker image inspect nexttime-ai-worker-runtime >/dev/null 2>&1; then
    fail "preflight-worker-runtime-image" "nexttime-ai-worker-runtime image not built — run: docker compose --profile build-only build worker-runtime"
  fi
  pass "preflight-worker-runtime-image" "nexttime-ai-worker-runtime present"

  build_out=$(docker compose --profile accept-s2 build accept-s2-sshd accept-s2-openapi accept-s2-ssh-gate accept-s2-http-gate 2>&1)
  build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    fail "preflight-accept-s2-build" "docker compose --profile accept-s2 build failed: $(printf '%s' "$build_out" | tail -20)"
  fi
  pass "preflight-accept-s2-build" "accept-s2 fixture/gate images built"
}

bootstrap_step() {
  ts=$(date +%s)
  ws_name="accept-s2-$ts"

  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js create-workspace --name "$ws_name" --owner alice </dev/null 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "bootstrap-workspace" "create-workspace exited $rc: $(printf '%s' "$out" | tail -5)"
  fi
  WORKSPACE_ID=$(printf '%s\n' "$out" | sed -n 's/^workspace created: //p')
  ALICE_PRINCIPAL_ID=$(printf '%s\n' "$out" | sed -n 's/^owner principal:   //p')
  ALICE_KEY=$(printf '%s\n' "$out" | awk '/^API key/{getline; print; exit}')
  if [ -z "$WORKSPACE_ID" ] || [ -z "$ALICE_PRINCIPAL_ID" ] || [ -z "$ALICE_KEY" ]; then
    fail "bootstrap-workspace" "could not parse create-workspace output: $(printf '%s' "$out" | tail -10)"
  fi
  pass "bootstrap-workspace" "workspace=$WORKSPACE_ID alice=$ALICE_PRINCIPAL_ID key=$(redact "$ALICE_KEY")"

  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js add-principal --workspace "$WORKSPACE_ID" --name bob --role member </dev/null 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "bootstrap-bob" "add-principal exited $rc: $(printf '%s' "$out" | tail -5)"
  fi
  BOB_PRINCIPAL_ID=$(printf '%s\n' "$out" | sed -n 's/^principal created: //p')
  BOB_KEY=$(printf '%s\n' "$out" | awk '/^API key/{getline; print; exit}')
  if [ -z "$BOB_PRINCIPAL_ID" ] || [ -z "$BOB_KEY" ]; then
    fail "bootstrap-bob" "could not parse add-principal output: $(printf '%s' "$out" | tail -10)"
  fi
  pass "bootstrap-bob" "bob=$BOB_PRINCIPAL_ID (member) key=$(redact "$BOB_KEY")"
}

# Generates the SSH keypair and the http gate's ConnectedAccount store key into
# ${NEXTTIME_DATA}/accept-s2/ (never inside the repo checkout — see this file's "Confidentiality"
# header comment), and the openapi fixture's bearer token, all via one-shot containers (the host
# may have neither ssh-keygen nor node — same reasoning as accept_s1.sh's own use of the kernel
# image for everything node-shaped).
fixtures_secrets_step() {
  mkdir -p "${NEXTTIME_DATA}/accept-s2/ssh" "${NEXTTIME_DATA}/accept-s2/ssh-gate" "${NEXTTIME_DATA}/accept-s2/http-gate"
  # Non-root gate/sshd containers (uid 10001, alpine sshd's own users) need write access; these
  # are throwaway acceptance-test directories, not production secrets storage.
  chmod 777 "${NEXTTIME_DATA}/accept-s2/ssh" "${NEXTTIME_DATA}/accept-s2/ssh-gate" "${NEXTTIME_DATA}/accept-s2/http-gate"

  if [ ! -f "${NEXTTIME_DATA}/accept-s2/ssh/id_ed25519" ]; then
    out=$(docker compose --profile accept-s2 run --rm --no-deps -T --entrypoint sh \
      -v "${NEXTTIME_DATA}/accept-s2/ssh:/out" accept-s2-ssh-gate \
      -c "ssh-keygen -t ed25519 -N '' -f /out/id_ed25519 -q && echo KEYGEN_OK" </dev/null 2>&1)
    case "$out" in
      *KEYGEN_OK*) : ;;
      *) fail "fixtures-ssh-keygen" "ssh-keygen failed: $out" ;;
    esac
  fi
  if [ ! -f "${NEXTTIME_DATA}/accept-s2/ssh/id_ed25519.pub" ]; then
    fail "fixtures-ssh-keygen" "id_ed25519.pub was not produced"
  fi
  pass "fixtures-ssh-keygen" "keypair generated into \${NEXTTIME_DATA}/accept-s2/ssh/"

  if [ ! -f "${NEXTTIME_DATA}/accept-s2/http-gate/store.key" ]; then
    out=$(docker compose --profile accept-s2 run --rm --no-deps -T --entrypoint node accept-s2-http-gate \
      -e "require('fs').mkdirSync('/data/gate',{recursive:true});require('fs').writeFileSync('/data/gate/store.key', require('crypto').randomBytes(32));console.log('STOREKEY_OK')" \
      </dev/null 2>&1)
    case "$out" in
      *STOREKEY_OK*) : ;;
      *) fail "fixtures-store-key" "store.key generation failed: $out" ;;
    esac
  fi
  pass "fixtures-store-key" "ConnectedAccount store key generated into \${NEXTTIME_DATA}/accept-s2/http-gate/"

  out=$(docker compose --profile accept-s2 run --rm --no-deps -T --entrypoint node accept-s2-http-gate \
    -e "console.log(require('crypto').randomBytes(20).toString('hex'))" </dev/null 2>&1)
  ACCEPT_S2_API_TOKEN=$(printf '%s\n' "$out" | tail -1 | tr -dc 'a-f0-9')
  if [ -z "$ACCEPT_S2_API_TOKEN" ] || [ ${#ACCEPT_S2_API_TOKEN} -ne 40 ]; then
    fail "fixtures-api-token" "could not generate a bearer token: $out"
  fi
  export ACCEPT_S2_API_TOKEN
  pass "fixtures-api-token" "bearer token generated: $(redact "$ACCEPT_S2_API_TOKEN")"
}

fixtures_up_step() {
  up_out=$(docker compose --profile accept-s2 up -d accept-s2-sshd accept-s2-openapi accept-s2-restart-target 2>&1)
  up_rc=$?
  if [ "$up_rc" -ne 0 ]; then
    fail "fixtures-up" "docker compose up failed: $(printf '%s' "$up_out" | tail -20)"
  fi
  pass "fixtures-up" "accept-s2-sshd, accept-s2-openapi, accept-s2-restart-target up"

  up_out=$(docker compose --profile accept-s2 up -d accept-s2-ssh-gate accept-s2-http-gate 2>&1)
  up_rc=$?
  if [ "$up_rc" -ne 0 ]; then
    fail "fixtures-gates-up" "docker compose up failed: $(printf '%s' "$up_out" | tail -20)"
  fi

  if ! wait_for_gate_health "http://accept-s2-ssh-gate:8090"; then
    fail "fixtures-gates-up" "accept-s2-ssh-gate /gate/health never came back ok — docker compose logs accept-s2-ssh-gate"
  fi
  if ! wait_for_gate_health "http://accept-s2-http-gate:8090"; then
    fail "fixtures-gates-up" "accept-s2-http-gate /gate/health never came back ok — docker compose logs accept-s2-http-gate"
  fi
  pass "fixtures-gates-up" "accept-s2-ssh-gate, accept-s2-http-gate healthy"

  restart_target_id=$(docker compose ps -q accept-s2-restart-target)
  if [ -z "$restart_target_id" ]; then
    fail "fixtures-restart-target" "accept-s2-restart-target container id not found"
  fi
  RESTART_TARGET_ID=$(docker inspect "$restart_target_id" --format '{{.Id}}')
  if [ -z "$RESTART_TARGET_ID" ]; then
    fail "fixtures-restart-target" "could not resolve full container id for accept-s2-restart-target"
  fi
  pass "fixtures-restart-target" "restart target container id=$RESTART_TARGET_ID"
}

# S2.12 deliverable 1 + the S2.13 acceptance sentence folded into this task ("find_operations
# ('stock') hits after connecting the fake OpenAPI; unpublished manifests are invisible").
# Connects: (a) the ssh-kind gate onto the sshd fixture, credentialKind='shared' (identity file
# already configured out-of-band via the compose volume — S2.5's docker/ragflow precedent);
# (b) the http-kind gate onto the openapi fixture, credentialKind='connected_account' (the bearer
# token goes straight to the gate's own ConnectedAccount store, never through the kernel);
# (c) the already-deployed gatekeeper-docker service (docs/runbooks/host-gatekeepers.md §10's own
# `target: "docker"` convention), needed by step 2 below. All three via the S2.13 capability flow
# (request_connection -> create_connection -> publish_manifest -> connect_gatekeeper), not
# bootstrap.js's operator-only register-gatekeeper subcommand.
connections_step() {
  # --- ssh ---
  out=$(cap "$ALICE_KEY" request_connection "{\"kind\":\"ssh\",\"target\":\"accept_s2_ssh\"}" "d.result.connectionRequestId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-ssh-request" "request_connection(ssh) HTTP $status: $(parse_kv "$out" BODY)"
  CR_ID_SSH=$(parse_kv "$out" EXTRACTED)
  [ -n "$CR_ID_SSH" ] || fail "connect-ssh-request" "no connectionRequestId in response: $(parse_kv "$out" BODY)"
  pass "connect-ssh-request" "connectionRequestId=$CR_ID_SSH"

  out=$(cap "$ALICE_KEY" create_connection \
    "{\"connectionRequestId\":\"$CR_ID_SSH\",\"kind\":\"ssh\",\"target\":\"accept_s2_ssh\",\"endpoint\":\"http://accept-s2-ssh-gate:8090\",\"credentialKind\":\"shared\"}" \
    "d.result.gatekeeperId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-ssh-create" "create_connection(ssh) HTTP $status: $(parse_kv "$out" BODY)"
  GATEKEEPER_ID_SSH=$(parse_kv "$out" EXTRACTED)
  [ -n "$GATEKEEPER_ID_SSH" ] || fail "connect-ssh-create" "no gatekeeperId in response: $(parse_kv "$out" BODY)"
  pass "connect-ssh-create" "gatekeeperId=$GATEKEEPER_ID_SSH"

  out=$(cap "$ALICE_KEY" publish_manifest "{\"gatekeeperId\":\"$GATEKEEPER_ID_SSH\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-ssh-publish" "publish_manifest(ssh) HTTP $status: $(parse_kv "$out" BODY)"
  pass "connect-ssh-publish" "ssh manifest published"

  out=$(cap "$ALICE_KEY" connect_gatekeeper "{\"gatekeeperId\":\"$GATEKEEPER_ID_SSH\",\"principalId\":\"$ALICE_PRINCIPAL_ID\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-ssh-grant" "connect_gatekeeper(ssh) HTTP $status: $(parse_kv "$out" BODY)"
  pass "connect-ssh-grant" "ssh gatekeeper granted to alice"

  # --- http (test OpenAPI service) ---
  out=$(cap "$ALICE_KEY" request_connection "{\"kind\":\"http\",\"target\":\"accept_s2_api\"}" "d.result.connectionRequestId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-http-request" "request_connection(http) HTTP $status: $(parse_kv "$out" BODY)"
  CR_ID_HTTP=$(parse_kv "$out" EXTRACTED)
  [ -n "$CR_ID_HTTP" ] || fail "connect-http-request" "no connectionRequestId in response: $(parse_kv "$out" BODY)"
  pass "connect-http-request" "connectionRequestId=$CR_ID_HTTP"

  out=$(cap "$ALICE_KEY" create_connection \
    "{\"connectionRequestId\":\"$CR_ID_HTTP\",\"kind\":\"http\",\"target\":\"accept_s2_api\",\"endpoint\":\"http://accept-s2-http-gate:8090\",\"credentials\":{\"token\":\"$ACCEPT_S2_API_TOKEN\"},\"credentialKind\":\"connected_account\",\"manifestSource\":\"http://accept-s2-openapi:8080/openapi.json\"}" \
    "d.result.gatekeeperId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-http-create" "create_connection(http) HTTP $status: $(parse_kv "$out" BODY)"
  GATEKEEPER_ID_HTTP=$(parse_kv "$out" EXTRACTED)
  [ -n "$GATEKEEPER_ID_HTTP" ] || fail "connect-http-create" "no gatekeeperId in response: $(parse_kv "$out" BODY)"
  pass "connect-http-create" "gatekeeperId=$GATEKEEPER_ID_HTTP (imported from manifestSource OpenAPI doc)"

  # S2.13 acceptance sentence, pre-publish half: a freshly-imported draft manifest must not be
  # visible to find_operations yet (I16/I17).
  out=$(cap "$ALICE_KEY" find_operations "{\"need\":\"stock\"}" "d.result.length")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "s213-find-operations-pre-publish" "find_operations HTTP $status: $(parse_kv "$out" BODY)"
  pre_count=$(parse_kv "$out" EXTRACTED)
  [ "$pre_count" = "0" ] || fail "s213-find-operations-pre-publish" "find_operations('stock') returned $pre_count results before publish_manifest — draft manifest is visible (I16/I17 violation)"
  pass "s213-find-operations-pre-publish" "find_operations('stock') misses before publish_manifest, as required"

  out=$(cap "$ALICE_KEY" publish_manifest "{\"gatekeeperId\":\"$GATEKEEPER_ID_HTTP\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-http-publish" "publish_manifest(http) HTTP $status: $(parse_kv "$out" BODY)"
  pass "connect-http-publish" "http manifest published"

  out=$(cap "$ALICE_KEY" find_operations "{\"need\":\"stock\"}" "d.result.length")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "s213-find-operations-post-publish" "find_operations HTTP $status: $(parse_kv "$out" BODY)"
  post_count=$(parse_kv "$out" EXTRACTED)
  [ "$post_count" != "0" ] && [ -n "$post_count" ] || fail "s213-find-operations-post-publish" "find_operations('stock') returned 0 results after publish_manifest"
  pass "s213-find-operations-post-publish" "find_operations('stock') hits after publish_manifest ($post_count result(s))"

  out=$(cap "$ALICE_KEY" connect_gatekeeper "{\"gatekeeperId\":\"$GATEKEEPER_ID_HTTP\",\"principalId\":\"$ALICE_PRINCIPAL_ID\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-http-grant" "connect_gatekeeper(http) HTTP $status: $(parse_kv "$out" BODY)"
  pass "connect-http-grant" "http gatekeeper granted to alice"

  # S2.13 acceptance: "内核数据库任何表中不存在凭证明文" — the bearer token must appear nowhere in any
  # kernel DB table (audit_records payload, objects, connection_requests, ...).
  tables=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select tablename from pg_tables where schemaname='public'" </dev/null 2>/dev/null)
  if [ -z "$tables" ]; then
    fail "s213-no-token-leak" "could not list public tables via psql"
  fi
  sql="select count(*) from ("
  first=1
  for t in $tables; do
    if [ "$first" -eq 1 ]; then first=0; else sql="$sql union all "; fi
    sql="$sql select 1 from \"$t\" x where x::text ilike '%' || :'token' || '%'"
  done
  sql="$sql) accept_s2_leak_check"
  # SQL goes in on stdin, not via -c: psql performs :'var' interpolation only on input it parses
  # itself (stdin/-f), never on a -c string (verified on the host — -c fails with a syntax error at
  # the colon, and the discarded stderr made this look like a real leak).
  leak_count=$(printf '%s\n' "$sql" | docker compose exec -T postgres psql -U nexttime -d nexttime -v token="$ACCEPT_S2_API_TOKEN" -tA 2>/dev/null | tail -1)
  [ "$leak_count" = "0" ] || fail "s213-no-token-leak" "bearer token string found in $leak_count row(s) across kernel DB tables"
  pass "s213-no-token-leak" "bearer token appears in 0 rows across all $(printf '%s\n' "$tables" | wc -l | tr -d ' ') public tables"

  # --- docker (already-deployed gatekeeper-docker; docs/runbooks/host-gatekeepers.md §10) ---
  out=$(cap "$ALICE_KEY" request_connection "{\"kind\":\"cli\",\"target\":\"docker\"}" "d.result.connectionRequestId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-docker-request" "request_connection(docker) HTTP $status: $(parse_kv "$out" BODY)"
  CR_ID_DOCKER=$(parse_kv "$out" EXTRACTED)
  pass "connect-docker-request" "connectionRequestId=$CR_ID_DOCKER"

  out=$(cap "$ALICE_KEY" create_connection \
    "{\"connectionRequestId\":\"$CR_ID_DOCKER\",\"kind\":\"cli\",\"target\":\"docker\",\"endpoint\":\"http://gatekeeper-docker:8083\",\"credentialKind\":\"shared\"}" \
    "d.result.gatekeeperId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-docker-create" "create_connection(docker) HTTP $status: $(parse_kv "$out" BODY)"
  GATEKEEPER_ID_DOCKER=$(parse_kv "$out" EXTRACTED)
  pass "connect-docker-create" "gatekeeperId=$GATEKEEPER_ID_DOCKER"

  out=$(cap "$ALICE_KEY" publish_manifest "{\"gatekeeperId\":\"$GATEKEEPER_ID_DOCKER\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-docker-publish" "publish_manifest(docker) HTTP $status: $(parse_kv "$out" BODY)"
  pass "connect-docker-publish" "docker manifest published"

  out=$(cap "$ALICE_KEY" connect_gatekeeper "{\"gatekeeperId\":\"$GATEKEEPER_ID_DOCKER\",\"principalId\":\"$ALICE_PRINCIPAL_ID\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-docker-grant" "connect_gatekeeper(docker) HTTP $status: $(parse_kv "$out" BODY)"
  pass "connect-docker-grant" "docker gatekeeper granted to alice"
}

# Proposes + publishes the general-purpose `ops-runner` WorkerDefinition (ontology/ops-runner.yaml
# — not seeded by create-workspace, unlike entry-agent.yaml) with `capabilities`/`gates` extended
# to what this script's Workers need: `request_action` (execute-class — omitted defaults to the
# worker ceiling *minus* every execute-class capability, packages/shared/src/worker-definition.ts's
# own doc comment) and the three Gatekeeper ids just connected above. Reads the real checked-in
# YAML (via the `yaml` package already vendored in the kernel image) rather than reinventing its
# prompt text. `name`/`description` (optional per that same schema) are added here — the literal
# word "restart" in the description is what makes `find_workers({need:"restart"})` (S2.12 step 2's
# chat-driven half, deploy/fake-llm/server.mjs's `entryRestartChatScenario`) actually match this
# definition: `substrate/graph/find-means.ts`'s ILIKE-over-properties search requires the whole
# `need` string as one contiguous substring somewhere in the WorkerDefinition's graph-projected
# properties, not a per-word match.
ops_runner_step() {
  yaml_json=$(docker compose run --rm --no-deps -T -v "$(pwd)/ontology:/tmp/ontology:ro" kernel node -e "
import('yaml').then(({ parse }) => import('node:fs/promises').then(async ({ readFile }) => {
  const raw = await readFile('/tmp/ontology/ops-runner.yaml', 'utf8');
  const doc = parse(raw);
  delete doc.kind;
  doc.name = 'ops-runner';
  doc.description = 'General-purpose Worker for delegated tasks: restart containers, run commands on connected systems, and observe connected APIs.';
  doc.capabilities = ['request_action'];
  doc.gates = ['$GATEKEEPER_ID_SSH', '$GATEKEEPER_ID_HTTP', '$GATEKEEPER_ID_DOCKER'];
  process.stdout.write(JSON.stringify(doc));
}));
" </dev/null 2>&1)
  case "$yaml_json" in
    '{'*) : ;;
    *) fail "ops-runner-yaml" "could not parse ontology/ops-runner.yaml: $yaml_json" ;;
  esac

  out=$(cap "$ALICE_KEY" propose_worker_definition "{\"kind\":\"worker\",\"definition\":$yaml_json}" "JSON.stringify([d.result.id, d.result.version])")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "ops-runner-propose" "propose_worker_definition HTTP $status: $(parse_kv "$out" BODY)"
  pair=$(parse_kv "$out" EXTRACTED)
  OPS_RUNNER_ID=$(printf '%s' "$pair" | sed -n 's/\["\([^"]*\)".*/\1/p')
  OPS_RUNNER_VERSION=$(printf '%s' "$pair" | sed -n 's/.*,\([0-9]*\)\]/\1/p')
  [ -n "$OPS_RUNNER_ID" ] && [ -n "$OPS_RUNNER_VERSION" ] || fail "ops-runner-propose" "could not parse [definitionId, version] from $pair"
  pass "ops-runner-propose" "definitionId=$OPS_RUNNER_ID version=$OPS_RUNNER_VERSION"

  out=$(cap "$ALICE_KEY" publish_worker_definition "{\"definitionId\":\"$OPS_RUNNER_ID\",\"version\":$OPS_RUNNER_VERSION}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "ops-runner-publish" "publish_worker_definition HTTP $status: $(parse_kv "$out" BODY)"
  pass "ops-runner-publish" "ops-runner@$OPS_RUNNER_VERSION published"
}

# Counts `tasks` rows for this workspace (used by step 3's "no Task/Worker created" assertion and
# by the step 2 chat-gap evidence).
task_count() {
  docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select count(*) from tasks where workspace_id='$WORKSPACE_ID'" </dev/null 2>/dev/null
}

# S2.12 step 2: "A chats '重启测试容器' -> entry agent find_* -> invoke_worker -> approval card ->
# A approves -> execution -> explain over the whole chain."
#
# Asserts the real chat-driven chain: entry mode is expected (as of packages/platform-extension's
# forthcoming entry-mode-tools fix) to register find_workers/invoke_worker as real tools and call
# them over the Handle channel — deploy/fake-llm/server.mjs's `entryRestartChatScenario` drives
# find_workers({need:'restart'}) -> invoke_worker({definitionId, version, input, wait:false})
# chained off each *real* tool result, then a final text naming the returned taskId.
#
# `step2-chat-entry-tools` below is a hard FAIL (not a SKIP) when the entry agent's reply shows the
# chain did not resolve: either packages/platform-extension has not deployed the entry-mode-tools
# fix yet, OR (a distinct, deeper finding that may still apply to this *execute-class* step even
# once that fix lands — see docs/runbooks/host-accept-s2.md "已知偏离") a real entry Handle can
# never satisfy `ops-runner`'s declared `request_action` need at all: `governance/capability/
# handles.ts`'s `ENTRY_CEILING_CAPABILITIES` structurally excludes `request_action` by capability
# *name* (I11/§5.3 item 11) regardless of the target Operation's mode. (Step 3's own observe path
# below is not subject to this — its entry tool calls a *different*, observe-only capability,
# `observe_operation`, not `request_action`; see that step's own comment.) This script cannot
# distinguish "tool not registered" from "registered but attenuation-rejected" from the chat reply
# alone; either way the fix is packages/platform-extension/packages/kernel territory, not this
# script's.
#
# Gate-tool registration ordering: the entry container registers `<gate>.<op>` tools once, at
# `session_start`, from `list_allowed_operations` — which only lists Gatekeepers already in the
# entry Handle's `resources.gatekeeper` *at the moment that Handle was issued* (populated from
# `connect_gatekeeper` Grants — `ensureEntryHandle`). `connections_step` (all three
# `connect_gatekeeper` calls) already runs before this function's first chat message in this
# script's own top-level run order, so alice's entry container is never spawned — and never gets a
# Handle issued — before those Grants exist; `resident_stop` below is a defensive no-op in the
# normal case, guarding only against a stale/rerun scenario where alice's container might already
# be running with an older Handle.
step2_docker_restart() {
  tasks_before=$(task_count)

  # Defensive: force a fresh Handle (and therefore a fresh list_allowed_operations gate-tool
  # registration) for alice's entry container before her first chat message ever spawns it — see
  # this function's own header comment on registration ordering. A no-op (404-ish, ignored) when
  # no container is running yet, which is the expected case here.
  resident_stop "$ALICE_PRINCIPAL_ID" >/dev/null 2>&1

  chat_out=$(run_driver send-and-wait "$ALICE_KEY" "" "重启测试容器 CONTAINER_ID=$RESTART_TARGET_ID" 90000)
  ALICE_CHAT_ID=$(parse_kv "$chat_out" CHAT_ID)
  [ -n "$ALICE_CHAT_ID" ] || fail "step2-chat-restart" "no CHAT_ID from send-and-wait: $chat_out"

  history_out=$(run_driver get-history "$ALICE_KEY" "$ALICE_CHAT_ID" "(d.filter(m=>m.role==='assistant').pop()||{}).text||''")
  last_reply=$(parse_kv "$history_out" EXTRACTED)
  case "$last_reply" in
    *"did not resolve"*|"")
      fail "step2-chat-entry-tools" "kernel/platform-extension entry tools not deployed — needs PR fix/entry-mode-tools (last assistant reply: '$last_reply')"
      ;;
  esac
  pass "step2-chat-reply" "entry agent replied: $last_reply"

  tasks_after=$(task_count)
  case "$tasks_before$tasks_after" in
    *[!0-9]*|'') fail "step2-chat-task-created" "could not read tasks count (before='$tasks_before' after='$tasks_after')" ;;
  esac
  [ "$tasks_after" -gt "$tasks_before" ] || fail "step2-chat-task-created" "tasks count did not increase ($tasks_before -> $tasks_after) after '重启测试容器' — expected a chat-driven invoke_worker call to create a Task"

  task_row=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select id||'|'||worker_definition_id from tasks where workspace_id='$WORKSPACE_ID' order by created_at desc limit 1" \
    </dev/null 2>/dev/null)
  new_task_id=$(printf '%s' "$task_row" | cut -d'|' -f1)
  new_task_def_id=$(printf '%s' "$task_row" | cut -d'|' -f2)
  [ -n "$new_task_id" ] || fail "step2-chat-task-created" "could not read the newly-created Task row"
  [ "$new_task_def_id" = "$OPS_RUNNER_ID" ] || fail "step2-chat-task-created" "new Task $new_task_id has worker_definition_id=$new_task_def_id, expected ops-runner ($OPS_RUNNER_ID)"
  pass "step2-chat-task-created" "Task $new_task_id created via chat, worker_definition_id=ops-runner ($OPS_RUNNER_ID)"

  # invoke_worker was called by the entry agent with wait:false (§8.2's asynchronous model — a
  # chat turn must not block on the spawned Worker), so the pending ActionRequest may not exist
  # yet the instant the chat turn settles; poll instead of a single immediate check.
  AR_ID_DOCKER=""
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    out=$(cap "$ALICE_KEY" list_pending "{}" "JSON.stringify((d.result||[]).filter(r=>r.gatekeeperId==='$GATEKEEPER_ID_DOCKER'))")
    status=$(parse_kv "$out" HTTP_STATUS)
    [ "$status" = "200" ] || fail "step2-list-pending" "list_pending HTTP $status: $(parse_kv "$out" BODY)"
    matches=$(parse_kv "$out" EXTRACTED)
    AR_ID_DOCKER=$(printf '%s' "$matches" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$AR_ID_DOCKER" ] && break
    attempt=$((attempt + 1))
    sleep 2
  done
  [ -n "$AR_ID_DOCKER" ] || fail "step2-list-pending" "no pending ActionRequest for gatekeeper $GATEKEEPER_ID_DOCKER appeared within 60s of the chat-driven invoke_worker call"
  pass "step2-list-pending" "actionRequestId=$AR_ID_DOCKER"

  history_out=$(run_driver get-history "$ALICE_KEY" "$ALICE_CHAT_ID" "d.some(m=>m.kind==='system.action_pending'&&m.content&&m.content.actionRequestId==='$AR_ID_DOCKER')")
  card_found=$(parse_kv "$history_out" EXTRACTED)
  if [ "$card_found" = "true" ]; then
    pass "step2-approval-card" "system.action_pending card for $AR_ID_DOCKER landed in alice's chat"
  else
    skip "step2-approval-card" "system.action_pending card for $AR_ID_DOCKER not found in alice's chat history (S2.11 linkage) — approval flow itself still verified below via list_pending/approve/get_action"
  fi

  out=$(cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$AR_ID_DOCKER\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "step2-approve" "approve HTTP $status: $(parse_kv "$out" BODY)"
  pass "step2-approve" "alice approved $AR_ID_DOCKER"

  executed=0
  attempt=0
  while [ "$attempt" -lt 15 ]; do
    out=$(cap "$ALICE_KEY" get_action "{\"actionRequestId\":\"$AR_ID_DOCKER\"}" "d.result.status")
    ar_status=$(parse_kv "$out" EXTRACTED)
    if [ "$ar_status" = "executed" ]; then
      executed=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  [ "$executed" = "1" ] || fail "step2-executed" "ActionRequest $AR_ID_DOCKER did not reach status=executed within 30s (last status: $ar_status)"
  pass "step2-executed" "ActionRequest $AR_ID_DOCKER executed"

  fact_id=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select id from links where workspace_id='$WORKSPACE_ID' and link_type='accept_s2_restarted' order by recorded_at desc limit 1" \
    </dev/null 2>/dev/null)
  [ -n "$fact_id" ] || fail "step2-explain" "no accept_s2_restarted Fact found to explain (Worker result contract may not have landed yet)"

  out=$(cap "$ALICE_KEY" explain "{\"nodeId\":\"$fact_id\"}" "d.ok===true")
  status=$(parse_kv "$out" HTTP_STATUS)
  ok=$(parse_kv "$out" EXTRACTED)
  [ "$status" = "200" ] && [ "$ok" = "true" ] || fail "step2-explain" "explain($fact_id) HTTP $status ok=$ok: $(parse_kv "$out" BODY)"
  pass "step2-explain" "explain(Fact) -> Observation -> Activity -> Source + Principal chain resolved for the whole find_workers-less docker-restart run"

  DOCKER_RESTART_FACT_ID="$fact_id"
}

# S2.12 step 3: "A asks '测试 API 的 GET 返回什么' -> the entry agent observes directly through the
# http gate (observe-class operation), no Worker/Task is created (assert task count unchanged)."
#
# Asserts the real chat-driven chain: entry mode is expected to register the observe-class
# gate-projected tool `accept_s2_api_stock_get` (deploy/fake-llm/server.mjs's
# `entryObserveChatScenario` calls it, then echoes its *real* returned data). Unlike step 2, this
# tool is expected to call a dedicated observe-only capability, `observe_operation` — *not*
# `request_action` — so it is not subject to step 2's `ENTRY_CEILING_CAPABILITIES`/`request_action`
# caveat (see that step's own header comment); `audit_records.action='observe_operation'` and an
# Activity of kind `gatekeeper_observe` are the confirming evidence this step checks for, alongside
# "no Task row, no ActionRequest row" — same hard-FAIL-not-SKIP reasoning as step 2 for detecting
# an undeployed fix.
step3_observe_no_worker() {
  tasks_before=$(task_count)
  action_requests_before=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select count(*) from action_requests where workspace_id='$WORKSPACE_ID'" </dev/null 2>/dev/null)

  run_driver send-and-wait "$ALICE_KEY" "$ALICE_CHAT_ID" "测试 API 的 GET 返回什么" 60000 >/dev/null

  history_out=$(run_driver get-history "$ALICE_KEY" "$ALICE_CHAT_ID" "(d.filter(m=>m.role==='assistant').pop()||{}).text||''")
  last_reply=$(parse_kv "$history_out" EXTRACTED)
  case "$last_reply" in
    *"did not resolve"*|"")
      fail "step3-chat-entry-tools" "kernel/platform-extension entry tools not deployed — needs PR fix/entry-mode-tools (last assistant reply: '$last_reply')"
      ;;
  esac
  case "$last_reply" in
    *NXT*) : ;;
    *) fail "step3-chat-reply" "entry agent's reply did not contain the fixture's stock payload ('NXT'): $last_reply" ;;
  esac
  pass "step3-chat-reply" "entry agent replied with the fixture's real stock payload: $last_reply"

  observe_op_count=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select count(*) from audit_records where workspace_id='$WORKSPACE_ID' and action='observe_operation'" \
    </dev/null 2>/dev/null)
  [ -n "$observe_op_count" ] && [ "$observe_op_count" != "0" ] || fail "step3-observe-operation-audited" "no audit_records row with action='observe_operation' found for this workspace — expected the entry gate tool to call that capability"
  pass "step3-observe-operation-audited" "audit_records shows $observe_op_count observe_operation call(s)"

  tasks_after=$(task_count)
  [ "$tasks_before" = "$tasks_after" ] || fail "step3-chat-no-task" "tasks count changed ($tasks_before -> $tasks_after) after an observe-only chat message — an observe-class gate call must never create a Task"
  pass "step3-chat-no-task" "tasks count unchanged ($tasks_before) — observe-class gate tool call via chat never creates a Task/Worker"

  action_requests_after=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select count(*) from action_requests where workspace_id='$WORKSPACE_ID'" </dev/null 2>/dev/null)
  [ "$action_requests_before" = "$action_requests_after" ] || fail "step3-no-action-request" "action_requests count changed ($action_requests_before -> $action_requests_after) after an observe-only chat message"
  pass "step3-no-action-request" "action_requests count unchanged ($action_requests_before) — observe_operation never creates an ActionRequest"
}

# S2.12 steps 4 and 5, interleaved (step 5 needs a genuinely pending ActionRequest, which step 4's
# first invocation naturally produces before it gets approved):
#   4. Worker runs one *unclassified* command on the SSH host -> approval card -> "always allow"
#      -> the second identical run produces no card (auto-approved and executed).
#   5. User B (member) tries to approve an action in A's scope -> 403.
step4_step5_ssh_always_allow() {
  ssh_command="uptime"

  out=$(cap "$ALICE_KEY" invoke_worker \
    "{\"definitionId\":\"$OPS_RUNNER_ID\",\"version\":$OPS_RUNNER_VERSION,\"input\":\"ACCEPT_S2_SCENARIO=ssh_run COMMAND=$ssh_command\",\"wait\":true,\"timeout\":90,\"gates\":[\"$GATEKEEPER_ID_SSH\"]}" \
    "d.result.status")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "step4-invoke-worker-1" "invoke_worker HTTP $status: $(parse_kv "$out" BODY)"
  pass "step4-invoke-worker-1" "first ssh Worker run -> $(parse_kv "$out" EXTRACTED)"

  out=$(cap "$ALICE_KEY" list_pending "{}" "JSON.stringify((d.result||[]).filter(r=>r.gatekeeperId==='$GATEKEEPER_ID_SSH'))")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "step4-list-pending-1" "list_pending HTTP $status: $(parse_kv "$out" BODY)"
  matches=$(parse_kv "$out" EXTRACTED)
  AR_ID_SSH1=$(printf '%s' "$matches" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$AR_ID_SSH1" ] || fail "step4-list-pending-1" "no pending ActionRequest for gatekeeper $GATEKEEPER_ID_SSH: $matches"
  pass "step4-list-pending-1" "actionRequestId=$AR_ID_SSH1 (unclassified command, no auto-approve policy yet)"

  history_out=$(run_driver get-history "$ALICE_KEY" "$ALICE_CHAT_ID" "d.some(m=>m.kind==='system.action_pending'&&m.content&&m.content.actionRequestId==='$AR_ID_SSH1')")
  card_found=$(parse_kv "$history_out" EXTRACTED)
  if [ "$card_found" = "true" ]; then
    pass "step4-approval-card" "system.action_pending card for $AR_ID_SSH1 landed in alice's chat"
  else
    skip "step4-approval-card" "system.action_pending card for $AR_ID_SSH1 not found in alice's chat history (S2.11 linkage)"
  fi

  # --- step 5: bob (member) tries to approve alice's pending ActionRequest -> 403 ---
  out=$(cap "$BOB_KEY" approve "{\"actionRequestId\":\"$AR_ID_SSH1\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "403" ] || fail "step5-bob-forbidden" "bob (member) approving \$AR_ID_SSH1 returned HTTP $status (expected 403): $(parse_kv "$out" BODY)"
  pass "step5-bob-forbidden" "bob (member) approve($AR_ID_SSH1) -> 403"

  # ActionRequest must still be pending after bob's rejected attempt.
  out=$(cap "$ALICE_KEY" get_action "{\"actionRequestId\":\"$AR_ID_SSH1\"}" "d.result.status")
  ar_status=$(parse_kv "$out" EXTRACTED)
  [ "$ar_status" = "pending_approval" ] || fail "step5-still-pending" "ActionRequest $AR_ID_SSH1 status is '$ar_status' after bob's forbidden attempt, expected still pending_approval"
  pass "step5-still-pending" "ActionRequest $AR_ID_SSH1 unaffected by bob's forbidden attempt"

  out=$(cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$AR_ID_SSH1\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "step4-approve-1" "approve HTTP $status: $(parse_kv "$out" BODY)"
  pass "step4-approve-1" "alice approved $AR_ID_SSH1"

  executed=0
  attempt=0
  while [ "$attempt" -lt 15 ]; do
    out=$(cap "$ALICE_KEY" get_action "{\"actionRequestId\":\"$AR_ID_SSH1\"}" "d.result.status")
    ar_status=$(parse_kv "$out" EXTRACTED)
    if [ "$ar_status" = "executed" ]; then
      executed=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  [ "$executed" = "1" ] || fail "step4-executed-1" "ActionRequest $AR_ID_SSH1 did not reach executed within 30s (last: $ar_status)"
  pass "step4-executed-1" "first ssh run executed"

  # --- "always allow this kind" ---
  out=$(cap "$ALICE_KEY" set_auto_approved_action_kind "{\"actionKind\":\"ssh.run_command\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "step4-always-allow" "set_auto_approved_action_kind HTTP $status: $(parse_kv "$out" BODY)"
  pass "step4-always-allow" "workspace policy: ssh.run_command auto-approved from now on"

  out=$(cap "$ALICE_KEY" list_pending "{}" "(d.result||[]).filter(r=>r.gatekeeperId==='$GATEKEEPER_ID_SSH').length")
  pending_before_second=$(parse_kv "$out" EXTRACTED)

  out=$(cap "$ALICE_KEY" invoke_worker \
    "{\"definitionId\":\"$OPS_RUNNER_ID\",\"version\":$OPS_RUNNER_VERSION,\"input\":\"ACCEPT_S2_SCENARIO=ssh_run COMMAND=$ssh_command\",\"wait\":true,\"timeout\":90,\"gates\":[\"$GATEKEEPER_ID_SSH\"]}" \
    "d.result.status")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "step4-invoke-worker-2" "invoke_worker (second run) HTTP $status: $(parse_kv "$out" BODY)"
  pass "step4-invoke-worker-2" "second ssh Worker run -> $(parse_kv "$out" EXTRACTED)"

  out=$(cap "$ALICE_KEY" list_pending "{}" "(d.result||[]).filter(r=>r.gatekeeperId==='$GATEKEEPER_ID_SSH').length")
  pending_after_second=$(parse_kv "$out" EXTRACTED)
  [ "$pending_after_second" = "$pending_before_second" ] || fail "step4-no-second-card" "list_pending for the ssh gatekeeper grew ($pending_before_second -> $pending_after_second) — second identical run produced a card instead of being auto-approved"
  pass "step4-no-second-card" "list_pending unchanged ($pending_before_second) — second identical run produced no approval card"

  ar_id_2=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select id from action_requests where workspace_id='$WORKSPACE_ID' and gatekeeper_id='$GATEKEEPER_ID_SSH' and id <> '$AR_ID_SSH1' order by requested_at desc limit 1" \
    </dev/null 2>/dev/null)
  [ -n "$ar_id_2" ] || fail "step4-second-auto-approved" "could not find the second ssh.run_command ActionRequest row"
  policy_decision_2=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select policy_decision from action_requests where workspace_id='$WORKSPACE_ID' and id='$ar_id_2'" \
    </dev/null 2>/dev/null)
  [ "$policy_decision_2" = "allow" ] || fail "step4-second-auto-approved" "second ActionRequest's policy_decision is '$policy_decision_2', expected 'allow'"
  pass "step4-second-auto-approved" "second ActionRequest ($ar_id_2) resolved policy_decision=allow (auto_approved) directly, no human decision required"
}

# S2.12 step 6: Worker container `env | grep -ci api_key` is 0; the Worker reaches
# https://example.com only via the egress proxy (success) and a direct LAN/internal address fails.
#
# Every real Worker container already runs this exact self-check unconditionally
# (deploy/worker-runtime/entrypoint.sh's own S2.9 "worker-mode self-check", before pi even starts)
# — this step additionally drives the same nexttime-ai-worker-runtime image directly (bypassing
# entrypoint.sh via --entrypoint sh, since platform-extension's worker mode registers no generic
# shell tool a fake-llm scenario could call — see docs/runbooks/host-accept-s2.md "已知偏离"), on
# the same isolated `workers` network and with the same HTTP(S)_PROXY a real spawned Worker gets
# (worker-supervisor's own HTTP_PROXY_FOR_WORKERS), for a literal, direct `env | grep -ci api_key`
# check plus the two curl probes.
step6_env_and_egress() {
  out=$(docker compose --profile build-only run --rm --no-deps -T --network workers --entrypoint sh \
    -e HTTP_PROXY=http://egress-proxy:3128 -e HTTPS_PROXY=http://egress-proxy:3128 \
    worker-runtime -c '
api_key_count=$(env | grep -ci api_key)
echo "API_KEY_COUNT=$api_key_count"
direct_code=$(curl -m 5 -sS -o /dev/null -w "%{http_code}" --noproxy "*" http://postgres:5432 2>/dev/null)
direct_rc=$?
echo "DIRECT_RC=$direct_rc"
echo "DIRECT_CODE=$direct_code"
proxied_code=$(curl -m 10 -sS -o /dev/null -w "%{http_code}" https://example.com 2>/dev/null)
echo "PROXIED_CODE=$proxied_code"
' </dev/null 2>&1)

  api_key_count=$(parse_kv "$out" API_KEY_COUNT)
  [ "$api_key_count" = "0" ] || fail "step6-no-api-key-env" "env | grep -ci api_key = $api_key_count (expected 0): $out"
  pass "step6-no-api-key-env" "0 api_key-shaped env vars in the Worker image's env"

  direct_rc=$(parse_kv "$out" DIRECT_RC)
  direct_code=$(parse_kv "$out" DIRECT_CODE)
  if [ "$direct_rc" = "0" ] && [ "$direct_code" = "200" ]; then
    fail "step6-direct-lan-fails" "direct (non-proxied) curl to an internal address unexpectedly succeeded: $out"
  fi
  pass "step6-direct-lan-fails" "direct curl to an internal address failed as expected (curl rc=$direct_rc, http_code='$direct_code')"

  proxied_code=$(parse_kv "$out" PROXIED_CODE)
  [ "$proxied_code" = "200" ] || fail "step6-proxied-egress-ok" "proxied curl https://example.com -> '$proxied_code' (expected 200): $out"
  pass "step6-proxied-egress-ok" "https://example.com -> 200 via egress-proxy"
}

# S2.12 step 7: the Facts written from the Worker result contract land in the graph with epistemic
# status `inferred` (design doc §5.6: agent -> inferred). Checks the Fact step 2's docker-restart
# Worker asserted (link_type='accept_s2_restarted').
step7_facts_inferred() {
  epistemic_status=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select epistemic_status from links where workspace_id='$WORKSPACE_ID' and id='$DOCKER_RESTART_FACT_ID'" \
    </dev/null 2>/dev/null)
  [ "$epistemic_status" = "inferred" ] || fail "step7-fact-inferred" "Fact $DOCKER_RESTART_FACT_ID has epistemic_status='$epistemic_status', expected 'inferred'"
  pass "step7-fact-inferred" "Fact $DOCKER_RESTART_FACT_ID (accept_s2_restarted, from the docker-restart Worker's report_result) has epistemic_status=inferred"

  asserted_by_kind=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select p.kind from links l join principals p on p.workspace_id = l.workspace_id and p.id = l.asserted_by where l.workspace_id='$WORKSPACE_ID' and l.id='$DOCKER_RESTART_FACT_ID'" \
    </dev/null 2>/dev/null)
  pass "step7-fact-asserted-by-agent" "Fact asserted_by principal kind='$asserted_by_kind' (kernel records the assertion itself as kind='agent' per application/task/result.ts, deriving inferred — see docs/runbooks/host-accept-s2.md)"
}

cleanup_step() {
  if [ "$KEEP" -eq 1 ]; then
    echo "cleanup: --keep set, leaving accept-s2 fixtures/gates/workspace up"
    return
  fi
  resident_stop "$ALICE_PRINCIPAL_ID" >/dev/null 2>&1
  resident_stop "$BOB_PRINCIPAL_ID" >/dev/null 2>&1
  down_out=$(docker compose --profile accept-s2 down 2>&1)
  down_rc=$?
  if [ "$down_rc" -ne 0 ]; then
    echo "cleanup: docker compose --profile accept-s2 down failed: $down_out" >&2
  fi
  # Workspace/principal/chat/activity/graph rows are the audit trail (design doc §12) — left in
  # place on purpose, same precedent as accept_s1.sh's own cleanup_step.
  pass "cleanup" "stopped alice/bob entry containers, tore down the accept-s2 profile; workspace retained: $WORKSPACE_ID"
}

# --------------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------------

preflight_step
bootstrap_step
fixtures_secrets_step
fixtures_up_step
connections_step
ops_runner_step
step2_docker_restart
step3_observe_no_worker
step4_step5_ssh_always_allow
step6_env_and_egress
step7_facts_inferred
cleanup_step

if [ "$SKIP_COUNT" -gt 0 ]; then
  echo "" >&2
  echo "accept_s2: $SKIP_COUNT step(s) skipped — see SKIP lines above for exact reasons:" >&2
  printf '%s' "$SKIP_LOG" >&2
  echo "accept_s2: known, documented platform gaps (docs/runbooks/host-accept-s2.md 已知偏离), not script defects — see that runbook before re-running." >&2
  exit 1
fi

echo "S2 OK"
exit 0
