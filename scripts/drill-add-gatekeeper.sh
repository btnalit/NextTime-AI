#!/bin/sh
# drill-add-gatekeeper.sh — S3.10 operational drill (docs/development-tasks.md §S3.10 acceptance:
# "按「新增接入包」手册接入一个 fake 系统成功"). POSIX sh, run ON THE HOST from the checkout root,
# same conventions as scripts/accept_s1.sh/accept_s2.sh (every docker compose run/exec carries
# </dev/null, secrets held only in shell variables and printed only via redact(), PASS/FAIL lines,
# an EXIT trap that cleans up every temp file regardless of how the script terminates).
#
# What this drills: walks docs/runbooks/add-gatekeeper.md end to end — request_connection (as a
# member) -> create_connection (as owner, importing an OpenAPI manifest) -> publish_manifest ->
# connect_gatekeeper (grant to the member) -> request_action (the member observes one Operation,
# confirming a Fact is written) — exactly the "接入一个 fake 系统" acceptance sentence. It reuses
# the *same* accept-s2 OpenAPI fixture (deploy/accept-s2/openapi-fixture/, one Operation:
# `stock.get`) scripts/accept_s2.sh's own http-connection block already exercises — not a second,
# parallel fixture — because that fixture already models exactly what a fake "接入包" (the
# add-gatekeeper.md scenario) looks like from the kernel's side: a real HTTP service + a fronting
# Gatekeeper process.
#
# Usage:
#   sh scripts/drill-add-gatekeeper.sh [--keep]
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/drill-add-gatekeeper.sh' </dev/null
#
# --keep leaves accept-s2-openapi/accept-s2-http-gate running and skips stopping them (still
# leaves the created workspace either way — see "cleanup" below, same convention accept_s1.sh/
# accept_s2.sh already establish for their own workspaces).
#
# Preconditions (docs/runbooks/add-gatekeeper.md §3, this drill's own subset of it):
#   - `docker compose up -d postgres kernel` (or the full stack) already running.
#   - `docker compose --profile accept-s2 build accept-s2-openapi accept-s2-http-gate` has been
#     run at least once (images built) — same precondition accept_s2.sh's own preflight_step
#     checks for the full accept-s2 fixture/gate set.
#   - `${NEXTTIME_DATA}/secrets/gate_token` exists (host-gatekeepers.md §0 — every Gatekeeper,
#     including this fixture one, refuses to start without it).
#
# Shared-fixture warning: accept-s2-openapi/accept-s2-http-gate and
# ${NEXTTIME_DATA}/accept-s2/http-gate/ are the *same* fixture directory/services
# scripts/accept_s2.sh itself uses — this drill regenerates the same
# ACCEPT_S2_API_TOKEN-equivalent bearer token accept_s2.sh generates and recreates both
# containers with it (docker compose recreates a service whose environment changed) each time it
# runs. Do not run this drill concurrently with an in-flight scripts/accept_s2.sh — whichever one
# started its containers first will have them recreated out from under it with a different token.
#
# Toolset: identical rationale to accept_s1.sh/accept_s2.sh's own header comments — every kernel
# capability call runs through one mounted driver script (DRIVER_JS below) inside a throwaway
# kernel-image container (`docker compose run --rm --no-deps -T kernel node /tmp/driver.mjs cap
# ...`), talking to the real running kernel over the `control` network
# (`http://kernel:8080/api/cap/...`) — the host has no node/corepack (docs/runbooks/
# host-worker-runtime.md §10). No jq dependency — JSON field extraction happens inside the same
# driver.mjs invocation via a real `JSON.parse()` (an optional trailing argv element, a JS
# expression evaluated against the parsed body, bound to `d` — verbatim copy of accept_s2.sh's own
# driver.mjs `cap` subcommand, trimmed to just that one subcommand since this drill needs no
# chat/WS interaction).
#
# Confidentiality (repo is public): the generated bearer token is held only in a shell variable
# for this process's lifetime and only ever printed via redact(); the one temp file this script
# creates (the mounted driver.mjs) never contains a secret and is removed by the EXIT trap
# regardless of how the script terminates.

set -u

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *)
      echo "drill-add-gatekeeper: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "./docker-compose.yml" ]; then
  echo "drill-add-gatekeeper: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "drill-add-gatekeeper: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${NEXTTIME_DATA:-}" ]; then
  echo "drill-add-gatekeeper: .env must set NEXTTIME_DATA" >&2
  exit 1
fi

# --------------------------------------------------------------------------------------------
# PASS/FAIL helpers — abort on the first FAIL (a real defect), same contract accept_s1.sh uses.
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
# driver.mjs — mounted read-only into a throwaway kernel-image container per call. Verbatim copy
# of accept_s2.sh's own `cap` subcommand (see that script's own header comment for the full
# rationale) — every other subcommand accept_s2.sh's driver has (send-and-wait/get-history) is
# omitted, this drill never touches chat.
# --------------------------------------------------------------------------------------------

DRIVER_HOST_PATH=$(mktemp /tmp/nt-drill-add-gatekeeper-driver.XXXXXX.mjs) || {
  echo "drill-add-gatekeeper: mktemp failed" >&2
  exit 1
}
# mktemp defaults to mode 0600 — the kernel image's own container process runs as a non-root uid
# that will not generally match whatever uid runs this script on the host, so the bind-mounted
# file needs to be world-readable (same reasoning as accept_s1.sh's own WS_CLIENT_HOST_PATH
# comment). Contains no secret — see this file's "Confidentiality" header comment.
chmod 644 "$DRIVER_HOST_PATH"

cleanup_tmp() {
  rm -f "$DRIVER_HOST_PATH"
}
trap cleanup_tmp EXIT INT TERM

cat >"$DRIVER_HOST_PATH" <<'DRIVER_JS'
// driver.mjs — drill-add-gatekeeper.sh's own minimal driver. See that script's own header
// comment for why this exists as a mounted file and the `cap` subcommand's contract.

const KERNEL_HTTP = 'http://kernel:8080';

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

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd !== 'cap') throw new Error(`unknown subcommand: ${cmd}`);
  await cmdCap(rest);
}

// Flush stdout before exiting: inside a container stdout is not a synchronous pipe, and
// process.exit() right after a large console.log drops the tail of the output (accept_s3's
// explain step lost its EXTRACTED= line that way). write('', cb) fires only after every
// earlier chunk has been flushed.
main()
  .then(() => process.stdout.write('', () => process.exit(0)))
  .catch((err) => {
    console.log(`ERROR=${(err && err.message) || String(err)}`);
    process.stdout.write('', () => process.exit(1));
  });
DRIVER_JS

run_driver() {
  docker compose run --rm --no-deps -T -v "$DRIVER_HOST_PATH:/tmp/driver.mjs:ro" kernel \
    node /tmp/driver.mjs "$@" </dev/null 2>&1
}

# One capability call. Prints HTTP_STATUS=/BODY=/EXTRACTED= — callers extract with parse_kv.
cap() {
  run_driver cap "$1" "$2" "$3" "${4:-}"
}

# Polls one gate's /gate/health from inside the kernel image — verbatim copy of accept_s2.sh's own
# wait_for_gate_health helper (see that script's own comment for the gate-token/timing rationale).
wait_for_gate_health() {
  gate_url="$1"
  attempt=0
  while [ "$attempt" -lt 15 ]; do
    out=$(docker compose run --rm --no-deps -T kernel node -e "
const token = require('fs').readFileSync('/run/secrets/gate_token', 'utf8').trim();
fetch('$gate_url/gate/health', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json()).then((b) => console.log('OK=' + (b.ok === true)))
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
  running=$(docker compose ps --status running --services 2>/dev/null)
  if [ -z "$running" ]; then
    fail "preflight-services" "docker compose ps returned nothing — is the stack up? (docker compose up -d postgres kernel ...)"
  fi
  for s in postgres kernel; do
    if ! printf '%s\n' "$running" | grep -qx "$s"; then
      fail "preflight-services" "not running: $s — run: docker compose up -d postgres kernel"
    fi
  done
  pass "preflight-services" "postgres, kernel running"

  build_out=$(docker compose --profile accept-s2 build accept-s2-openapi accept-s2-http-gate 2>&1)
  build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    fail "preflight-build" "docker compose --profile accept-s2 build failed: $(printf '%s' "$build_out" | tail -20)"
  fi
  pass "preflight-build" "accept-s2-openapi, accept-s2-http-gate images built"
}

bootstrap_step() {
  ts=$(date +%s)
  ws_name="drill-add-gatekeeper-$ts"

  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js create-workspace --name "$ws_name" --owner owner </dev/null 2>&1)
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

  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js add-principal --workspace "$WORKSPACE_ID" --name member --role member </dev/null 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "bootstrap-member" "add-principal exited $rc: $(printf '%s' "$out" | tail -5)"
  fi
  MEMBER_ID=$(printf '%s\n' "$out" | sed -n 's/^principal created: //p')
  MEMBER_KEY=$(printf '%s\n' "$out" | awk '/^API key/{getline; print; exit}')
  if [ -z "$MEMBER_ID" ] || [ -z "$MEMBER_KEY" ]; then
    fail "bootstrap-member" "could not parse add-principal output: $(printf '%s' "$out" | tail -10)"
  fi
  pass "bootstrap-member" "member=$MEMBER_ID key=$(redact "$MEMBER_KEY")"
}

# Same fixture directory/secret-generation convention as accept_s2.sh's own fixtures_secrets_step
# (http-only half) — see this script's own "Shared-fixture warning" header comment for why this is
# deliberate, not an accident.
fixtures_up_step() {
  mkdir -p "${NEXTTIME_DATA}/accept-s2/http-gate"
  chmod 777 "${NEXTTIME_DATA}/accept-s2/http-gate"

  if [ ! -f "${NEXTTIME_DATA}/accept-s2/http-gate/store.key" ]; then
    out=$(docker compose --profile accept-s2 run --rm --no-deps -T --entrypoint node accept-s2-http-gate \
      -e "require('fs').mkdirSync('/data/gate',{recursive:true});require('fs').writeFileSync('/data/gate/store.key', require('crypto').randomBytes(32));console.log('STOREKEY_OK')" \
      </dev/null 2>&1)
    case "$out" in
      *STOREKEY_OK*) : ;;
      *) fail "fixtures-store-key" "store.key generation failed: $out" ;;
    esac
  fi
  pass "fixtures-store-key" "ConnectedAccount store key present at \${NEXTTIME_DATA}/accept-s2/http-gate/"

  out=$(docker compose --profile accept-s2 run --rm --no-deps -T --entrypoint node accept-s2-http-gate \
    -e "console.log(require('crypto').randomBytes(20).toString('hex'))" </dev/null 2>&1)
  API_TOKEN=$(printf '%s\n' "$out" | tail -1 | tr -dc 'a-f0-9')
  if [ -z "$API_TOKEN" ] || [ ${#API_TOKEN} -ne 40 ]; then
    fail "fixtures-api-token" "could not generate a bearer token: $out"
  fi
  export ACCEPT_S2_API_TOKEN="$API_TOKEN"
  pass "fixtures-api-token" "bearer token generated: $(redact "$API_TOKEN")"

  up_out=$(docker compose --profile accept-s2 up -d accept-s2-openapi accept-s2-http-gate 2>&1)
  up_rc=$?
  if [ "$up_rc" -ne 0 ]; then
    fail "fixtures-up" "docker compose up failed: $(printf '%s' "$up_out" | tail -20)"
  fi
  if ! wait_for_gate_health "http://accept-s2-http-gate:8090"; then
    fail "fixtures-up" "accept-s2-http-gate /gate/health never came back ok — docker compose logs accept-s2-http-gate"
  fi
  pass "fixtures-up" "accept-s2-openapi, accept-s2-http-gate up and healthy"
}

# The runbook walk-through itself: request -> create -> publish_manifest -> grant -> observe.
connection_flow_step() {
  # 1. request_connection — add-gatekeeper.md §7 step 1 ("任何 member 都能发起").
  out=$(cap "$MEMBER_KEY" request_connection '{"kind":"http","target":"drill-add-gatekeeper"}' "d.result.id")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "request-connection" "request_connection HTTP $status: $(parse_kv "$out" BODY)"
  CR_ID=$(parse_kv "$out" EXTRACTED)
  [ -n "$CR_ID" ] || fail "request-connection" "no id in response: $(parse_kv "$out" BODY)"
  pass "request-connection" "connectionRequestId=$CR_ID (requested by member)"

  # 2. create_connection — add-gatekeeper.md §7 step 3(b): import via manifestSource (the OpenAPI
  # document), owner-only.
  out=$(cap "$OWNER_KEY" create_connection \
    "{\"connectionRequestId\":\"$CR_ID\",\"kind\":\"http\",\"target\":\"drill-add-gatekeeper\",\"endpoint\":\"http://accept-s2-http-gate:8090\",\"credentials\":{\"token\":\"$ACCEPT_S2_API_TOKEN\"},\"credentialKind\":\"connected_account\",\"manifestSource\":\"http://accept-s2-openapi:8080/openapi.json\"}" \
    "d.result.gatekeeperId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "create-connection" "create_connection HTTP $status: $(parse_kv "$out" BODY)"
  GATEKEEPER_ID=$(parse_kv "$out" EXTRACTED)
  [ -n "$GATEKEEPER_ID" ] || fail "create-connection" "no gatekeeperId in response: $(parse_kv "$out" BODY)"
  pass "create-connection" "gatekeeperId=$GATEKEEPER_ID (imported stock.get from OpenAPI manifest)"

  # 3. publish_manifest — add-gatekeeper.md §7 step 4.
  out=$(cap "$OWNER_KEY" publish_manifest "{\"gatekeeperId\":\"$GATEKEEPER_ID\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "publish-manifest" "publish_manifest HTTP $status: $(parse_kv "$out" BODY)"
  pass "publish-manifest" "manifest published"

  # 4. connect_gatekeeper — add-gatekeeper.md §7 step 5 (grant to the member — the "target user").
  out=$(cap "$OWNER_KEY" connect_gatekeeper "{\"gatekeeperId\":\"$GATEKEEPER_ID\",\"principalId\":\"$MEMBER_ID\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-gatekeeper" "connect_gatekeeper HTTP $status: $(parse_kv "$out" BODY)"
  pass "connect-gatekeeper" "gatekeeper granted to member $MEMBER_ID"

  # 5. observe one Operation — add-gatekeeper.md §10 verification ("observe 类：走一次
  # request_action，确认落 Fact"), called by the *member* (the granted principal), not the owner —
  # proves the grant itself, not just that an owner can always reach everything.
  out=$(cap "$MEMBER_KEY" request_action "{\"gatekeeperId\":\"$GATEKEEPER_ID\",\"operation\":\"stock.get\",\"params\":{}}" "JSON.stringify([d.result.status, d.result.observedFactCount])")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "observe-operation" "request_action HTTP $status: $(parse_kv "$out" BODY)"
  pair=$(parse_kv "$out" EXTRACTED)
  RESULT_STATUS=$(printf '%s' "$pair" | sed -n 's/\["\([^"]*\)".*/\1/p')
  OBSERVED_FACT_COUNT=$(printf '%s' "$pair" | sed -n 's/.*,\([0-9]*\)\]/\1/p')
  [ "$RESULT_STATUS" = "ok" ] || fail "observe-operation" "request_action result.status=$RESULT_STATUS (expected ok): $(parse_kv "$out" BODY)"
  case "$OBSERVED_FACT_COUNT" in
    '' | 0) fail "observe-operation" "observedFactCount=$OBSERVED_FACT_COUNT (expected >= 1) — no Fact was written: $(parse_kv "$out" BODY)" ;;
  esac
  pass "observe-operation" "stock.get -> status=ok observedFactCount=$OBSERVED_FACT_COUNT (member observed through the granted gatekeeper)"
}

cleanup_step() {
  if [ "$KEEP" -eq 1 ]; then
    echo "cleanup: --keep set, leaving accept-s2-openapi/accept-s2-http-gate running"
  else
    docker compose --profile accept-s2 stop accept-s2-openapi accept-s2-http-gate >/dev/null 2>&1
    echo "cleanup: stopped accept-s2-openapi, accept-s2-http-gate"
  fi
  # Workspace/principal/Gatekeeper/Grant/Fact/audit rows are the audit trail (design doc §12) —
  # left in place on purpose, same convention accept_s1.sh/accept_s2.sh already establish for
  # their own workspaces. Periodic cleanup: sh scripts/delete-workspaces-matching.sh
  # '^drill-add-gatekeeper' --yes.
  pass "cleanup" "workspace retained: $WORKSPACE_ID (clean up periodically with: sh scripts/delete-workspaces-matching.sh '^drill-add-gatekeeper' --yes)"
}

# --------------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------------

preflight_step
bootstrap_step
fixtures_up_step
connection_flow_step
cleanup_step

echo "DRILL-ADD-GATEKEEPER OK"
exit 0
