#!/bin/sh
# accept_s2.sh — S2 acceptance script (docs/development-tasks.md S2.12; design doc §14/§15-style
# verification, extended for S2). POSIX sh, run ON THE HOST from the checkout root — same
# conventions as scripts/accept_s1.sh (this script's structural template): every docker compose
# run/exec carries </dev/null, a mounted driver script drives every kernel interaction from inside
# a throwaway kernel-image container (the host has no node/corepack), secrets are held only in
# shell variables and printed only via redact(), and no temp file is ever written (the driver is
# a checked-in file mounted by path).
#
# Usage:
#   sh scripts/accept_s2.sh [--keep]
#   sh scripts/accept_s2.sh --real <provider/model> [--runs N] [--keep]   # W7 real-model mode
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s2.sh' </dev/null
#
# --real <provider/model>: leave the deployed (real) provider in place, pin the entry agent and
# the ops-runner Worker to that models.json id, and replace the fake-scripted steps 2/3/4/5/7
# with outcome-judged scenarios repeated --runs times (default 3) — see the "W7 real-model mode"
# section below and docs/runbooks/host-accept-real-model.md. Never defaults the model.
#
# --keep skips removing the accept-s2 fixture containers (leaves the fixtures/gates/workspace up
# for inspection). --keep does not skip the fake-provider restore below — the EXIT trap always
# runs.
#
# Preconditions (see docs/runbooks/host-accept-s2.md for the full walkthrough):
#   - `docker compose --profile test up -d` already running plus `docker compose up -d
#     gatekeeper-docker`. The script switches llm-proxy / worker-supervisor / fake-llm to the fake
#     provider itself via deploy/accept/docker-compose.fake.yml and restores production wiring
#     from an EXIT trap, so ${NEXTTIME_DATA}/config/llm-providers.yaml and models.json are never
#     modified — no manual provider switch is needed before or after.
#   - `docker compose --profile accept-s2 build` has been run at least once (images built).
#   - `docker compose build worker-runtime` (profile build-only) has produced
#     `nexttime-ai-worker-runtime` — step 6's fallback env/egress probe runs that image directly.
#
# Toolset: identical rationale to accept_s1.sh's own header comment — every kernel interaction
# (chat WS, and here also every `POST /api/cap/<name>` capability call) runs through the shared
# driver, deploy/accept/driver.mjs, bind-mounted read-only into a throwaway `kernel`-image
# container by the shared `run_driver` helper in scripts/lib/ (see that file's own header comment for
# the exact `docker compose run` invocation — no temp file), talking to the real running kernel
# over the `control` network
# (`http://kernel:8080/...`, `ws://kernel:8080/ws`) — not through caddy's self-signed TLS,
# same reasoning as accept_s1.sh's own header comment (this script has no single "the one step
# that deliberately goes through caddy" the way accept_s1.sh's explain_step does; every capability
# call here uses the same internal path uniformly, matching docs/runbooks/host-gatekeepers.md's own
# `docker compose exec -T kernel node -e "fetch('http://localhost:8080/...')"` precedent — the
# difference being `run --rm --no-deps` + the service DNS name `kernel`, not `exec` inside the
# already-running container + `localhost`, because this script's driver runs in its *own* fresh
# container each invocation, same as accept_s1.sh's own driver invocation).
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
REAL=0
REAL_MODEL=""
RUNS=3
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --real)
      [ "$#" -ge 2 ] || { echo "accept_s2: --real needs <provider/model>" >&2; exit 1; }
      REAL=1
      REAL_MODEL=$2
      shift
      ;;
    --runs)
      [ "$#" -ge 2 ] || { echo "accept_s2: --runs needs <N>" >&2; exit 1; }
      RUNS=$2
      shift
      ;;
    *)
      echo "accept_s2: unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done
case "$RUNS" in
  ''|*[!0-9]*|0) echo "accept_s2: --runs must be a positive integer" >&2; exit 1 ;;
esac

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

. "$(dirname "$0")/lib/accept-common.sh"
require_driver

# Traps first, switch second: if the recreate fails half-way the EXIT trap still restores
# whatever landed on the override; HUP/PIPE cover a dropped ssh session (the documented way
# to run this script), which would otherwise kill the shell without running the EXIT trap.
if [ "$REAL" -eq 0 ]; then
  trap accept_provider_restore EXIT
  trap 'accept_provider_restore; exit 130' INT TERM HUP PIPE
  accept_provider_up || fail "preflight-fake-provider" "could not switch the stack to the fake provider (deploy/accept/docker-compose.fake.yml)"
  pass "preflight-fake-provider" "llm-proxy / worker-supervisor / fake-llm recreated on deploy/accept/docker-compose.fake.yml; production provider config untouched"
else
  # W7 real-model mode: the stack stays on whatever provider is deployed; every entry agent and
  # Worker this script creates is pinned to $REAL_MODEL (must be one of that provider's
  # models.json ids). No fake-llm, no override, nothing to restore.
  ACCEPT_S2_MODEL=$REAL_MODEL
  export ACCEPT_S2_MODEL
  pass "preflight-real-provider" "real provider left as deployed; entry agent and ops-runner pinned to model=$REAL_MODEL, runs=$RUNS per scenario"
fi

resident_stop() {
  docker compose run --rm --no-deps -T kernel node -e "
fetch('http://worker-supervisor:8081/resident/stop', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ principalId: '$1' }),
}).then((r) => console.log('STATUS=' + r.status));
" </dev/null 2>&1
}

# --------------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------------

preflight_step() {
  required_services="postgres kernel caddy llm-proxy egress-proxy worker-supervisor agent-host fake-llm gatekeeper-docker"
  [ "$REAL" -eq 1 ] && required_services="postgres kernel caddy llm-proxy egress-proxy worker-supervisor agent-host gatekeeper-docker"
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

  build_out=$(docker compose --profile accept-s2 build accept-s2-sshd accept-s2-openapi accept-s2-mcp accept-s2-ssh-gate accept-s2-http-gate 2>&1)
  build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    fail "preflight-accept-s2-build" "docker compose --profile accept-s2 build failed: $(printf '%s' "$build_out" | tail -20)"
  fi
  pass "preflight-accept-s2-build" "accept-s2 fixture/gate images built"
}

bootstrap_step() {
  ts=$(date +%s)
  ws_name="accept-s2-$ts"

  # --entry-model pins alice's entry agent to the fake provider (config/llm-providers.fake.example.yaml
  # `fake/fake-echo`): without it the seeded entry WorkerDefinition has no `model` and the runtime
  # falls back to the host's default provider — on the first host run that was the real DeepSeek,
  # fake-llm never saw a request and every chat reply came back empty.
  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js create-workspace --name "$ws_name" --owner alice --entry-model "${ACCEPT_S2_MODEL:-fake/fake-echo}" </dev/null 2>&1)
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
  out=$(cap "$ALICE_KEY" request_connection "{\"kind\":\"ssh\",\"target\":\"accept_s2_ssh\"}" "d.result.id")
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
  out=$(cap "$ALICE_KEY" request_connection "{\"kind\":\"http\",\"target\":\"accept_s2_api\"}" "d.result.id")
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
  out=$(cap "$ALICE_KEY" find_operations "{\"need\":\"stock\"}" "d.result.items.length")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "s213-find-operations-pre-publish" "find_operations HTTP $status: $(parse_kv "$out" BODY)"
  pre_count=$(parse_kv "$out" EXTRACTED)
  [ "$pre_count" = "0" ] || fail "s213-find-operations-pre-publish" "find_operations('stock') returned $pre_count results before publish_manifest — draft manifest is visible (I16/I17 violation)"
  pass "s213-find-operations-pre-publish" "find_operations('stock') misses before publish_manifest, as required"

  out=$(cap "$ALICE_KEY" publish_manifest "{\"gatekeeperId\":\"$GATEKEEPER_ID_HTTP\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-http-publish" "publish_manifest(http) HTTP $status: $(parse_kv "$out" BODY)"
  pass "connect-http-publish" "http manifest published"

  out=$(cap "$ALICE_KEY" find_operations "{\"need\":\"stock\"}" "d.result.items.length")
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
  out=$(cap "$ALICE_KEY" request_connection "{\"kind\":\"cli\",\"target\":\"docker\"}" "d.result.id")
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
  // Same fake model as alice's entry agent — a Worker without \`model\` falls back to the host's
  // default provider, which is the real one outside this script.
  doc.model = '${ACCEPT_S2_MODEL:-fake/fake-echo}';
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
    # Select the row's own `id` on the JS side: a greedy sed over the JSON picked the *last*
    # `"id":"…"` — which is the container id inside `params` (container.restart {id}) — and the
    # seventh host run then approved a container id (500) and looked for a card under it (miss).
    out=$(cap "$ALICE_KEY" list_pending "{}" "String((((d.result.items||[]).filter(r=>r.gatekeeperId==='$GATEKEEPER_ID_DOCKER'))[0]||{}).id||'')")
    status=$(parse_kv "$out" HTTP_STATUS)
    [ "$status" = "200" ] || fail "step2-list-pending" "list_pending HTTP $status: $(parse_kv "$out" BODY)"
    AR_ID_DOCKER=$(parse_kv "$out" EXTRACTED)
    [ -n "$AR_ID_DOCKER" ] && break
    attempt=$((attempt + 1))
    sleep 2
  done
  [ -n "$AR_ID_DOCKER" ] || fail "step2-list-pending" "no pending ActionRequest for gatekeeper $GATEKEEPER_ID_DOCKER appeared within 60s of the chat-driven invoke_worker call"
  pass "step2-list-pending" "actionRequestId=$AR_ID_DOCKER"

  # A system card is a chat message whose `content` carries `kind`/`actionRequestId`
  # (application/linkage/content.ts); the driver may also expose them flattened — accept both.
  history_out=$(run_driver get-history "$ALICE_KEY" "$ALICE_CHAT_ID" "d.some(m=>{const c=(m&&m.content&&typeof m.content==='object')?m.content:m;return c&&c.kind==='system.action_pending'&&c.actionRequestId==='$AR_ID_DOCKER';})")
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

  # New chat, not the step-2 one: fake-llm matches scenarios against the whole message history, so
  # asking in the restart chat replays the restart scenario (eighth host run). The linkage routes
  # system cards to alice's *most recent* chat (application/linkage/chat-targets.ts), so later card
  # checks must follow this new chat id too — hence ALICE_CHAT_ID is reassigned, not a second var.
  chat_out=$(run_driver send-and-wait "$ALICE_KEY" "" "测试 API 的 GET 返回什么" 60000)
  ALICE_CHAT_ID=$(parse_kv "$chat_out" CHAT_ID)
  [ -n "$ALICE_CHAT_ID" ] || fail "step3-chat-observe" "no CHAT_ID from send-and-wait: $chat_out"

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

  out=$(cap "$ALICE_KEY" list_pending "{}" "JSON.stringify((d.result.items||[]).filter(r=>r.gatekeeperId==='$GATEKEEPER_ID_SSH'))")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "step4-list-pending-1" "list_pending HTTP $status: $(parse_kv "$out" BODY)"
  matches=$(parse_kv "$out" EXTRACTED)
  AR_ID_SSH1=$(printf '%s' "$matches" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$AR_ID_SSH1" ] || fail "step4-list-pending-1" "no pending ActionRequest for gatekeeper $GATEKEEPER_ID_SSH: $matches"
  pass "step4-list-pending-1" "actionRequestId=$AR_ID_SSH1 (unclassified command, no auto-approve policy yet)"

  history_out=$(run_driver get-history "$ALICE_KEY" "$ALICE_CHAT_ID" "d.some(m=>{const c=(m&&m.content&&typeof m.content==='object')?m.content:m;return c&&c.kind==='system.action_pending'&&c.actionRequestId==='$AR_ID_SSH1';})")
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
  out=$(cap "$ALICE_KEY" set_auto_approved_action_kind "{\"actionKindTag\":\"ssh.run_command\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "step4-always-allow" "set_auto_approved_action_kind HTTP $status: $(parse_kv "$out" BODY)"
  pass "step4-always-allow" "workspace policy: ssh.run_command auto-approved from now on"

  out=$(cap "$ALICE_KEY" list_pending "{}" "(d.result.items||[]).filter(r=>r.gatekeeperId==='$GATEKEEPER_ID_SSH').length")
  pending_before_second=$(parse_kv "$out" EXTRACTED)

  out=$(cap "$ALICE_KEY" invoke_worker \
    "{\"definitionId\":\"$OPS_RUNNER_ID\",\"version\":$OPS_RUNNER_VERSION,\"input\":\"ACCEPT_S2_SCENARIO=ssh_run COMMAND=$ssh_command\",\"wait\":true,\"timeout\":90,\"gates\":[\"$GATEKEEPER_ID_SSH\"]}" \
    "d.result.status")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "step4-invoke-worker-2" "invoke_worker (second run) HTTP $status: $(parse_kv "$out" BODY)"
  pass "step4-invoke-worker-2" "second ssh Worker run -> $(parse_kv "$out" EXTRACTED)"

  out=$(cap "$ALICE_KEY" list_pending "{}" "(d.result.items||[]).filter(r=>r.gatekeeperId==='$GATEKEEPER_ID_SSH').length")
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
# check plus the curl probes.
#
# Egress is fail-closed per *source* since the runtime hardening (review lane 6 / F6,
# `EGRESS_DENY_UNKNOWN_SOURCE` default on): the proxy only forwards for a client IP that
# worker-supervisor registered in its source map when it spawned that container. The ad-hoc
# `docker run` container below is deliberately NOT such a source, so it must now be *denied*
# (`unknown-source`, 403 — the 2026-09-08 regression run first surfaced this as a curl `000` on
# the old "expect 200" assertion, which was asserting the pre-hardening fail-open behaviour). The
# positive half of the invariant — a registered container does reach the public internet through
# the proxy — is checked from inside alice's resident entry container, which worker-supervisor
# spawned for steps 2–3 (registered as `entry:<workspace>:<alice>`; same image, same curl).
step6_env_and_egress() {
  # Plain `docker run` on the compose project's `workers` network: `docker compose run --network`
  # is not accepted by the compose version on the host (fourteenth run: "unknown flag: --network"),
  # and the build-only worker-runtime service declares no networks of its own. Same image, same
  # non-root user, same proxy env a real Worker receives (worker-supervisor spawn-spec) — but no
  # source registration, so the proxied probe uses plain http:// (a denied CONNECT would only show
  # up as curl exit 56 / http_code 000; a denied plain-HTTP request carries the proxy's own 403).
  # The proxy is named explicitly with `-x`: curl deliberately ignores an *uppercase* `HTTP_PROXY`
  # (httpoxy mitigation — only lowercase `http_proxy` is read for plain http, while `HTTPS_PROXY`
  # in either case is honoured), so relying on the env above sent the http:// probe direct, where
  # the internal `workers` network has no resolver (curl rc 6 / 000, third regression run).
  # worker-supervisor's spawn-spec sets both cases on real containers for exactly this reason
  # (its own S1.5a note); this ad-hoc run only mirrors the uppercase pair.
  out=$(docker run --rm --network "${COMPOSE_PROJECT_NAME:-nexttime-ai}_workers" --entrypoint sh \
    -e HTTP_PROXY=http://egress-proxy:3128 -e HTTPS_PROXY=http://egress-proxy:3128 \
    nexttime-ai-worker-runtime -c '
api_key_count=$(env | grep -ci api_key)
echo "API_KEY_COUNT=$api_key_count"
direct_code=$(curl -m 5 -sS -o /dev/null -w "%{http_code}" --noproxy "*" http://postgres:5432 2>/dev/null)
direct_rc=$?
echo "DIRECT_RC=$direct_rc"
echo "DIRECT_CODE=$direct_code"
unregistered_code=$(curl -m 10 -sS -o /dev/null -w "%{http_code}" -x http://egress-proxy:3128 http://example.com 2>/dev/null)
unregistered_rc=$?
echo "UNREGISTERED_RC=$unregistered_rc"
echo "UNREGISTERED_CODE=$unregistered_code"
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

  unregistered_code=$(parse_kv "$out" UNREGISTERED_CODE)
  [ "$unregistered_code" = "403" ] || fail "step6-unregistered-source-denied" "proxied curl http://example.com from an unregistered container -> '$unregistered_code' (expected 403 unknown-source): $out"
  pass "step6-unregistered-source-denied" "unregistered container -> 403 from egress-proxy (fail-closed per source)"

  # Positive half: alice's resident entry container was spawned (and its IP registered as an egress
  # source) by worker-supervisor for steps 2–3, and is still up (ENTRY_IDLE_TIMEOUT_MS default 30m).
  entry_container="nexttime-entry-${ALICE_PRINCIPAL_ID}"
  entry_running=$(docker inspect -f '{{.State.Running}}' "$entry_container" 2>/dev/null)
  [ "$entry_running" = "true" ] || fail "step6-registered-egress-ok" "alice's entry container $entry_container is not running (State.Running='$entry_running') — steps 2–3 should have left it up"
  registered_code=$(docker exec "$entry_container" curl -m 10 -sS -o /dev/null -w '%{http_code}' -x http://egress-proxy:3128 https://example.com </dev/null 2>/dev/null)
  [ "$registered_code" = "200" ] || fail "step6-registered-egress-ok" "proxied curl https://example.com from alice's registered entry container -> '$registered_code' (expected 200)"
  pass "step6-registered-egress-ok" "registered entry container -> https://example.com 200 via egress-proxy"
}

# S2.12 step 7: the Facts written from the Worker result contract land in the graph with epistemic
# status `inferred` (design doc §5.6: agent -> inferred), asserted_by a real agent principal that
# identifies the WorkerDefinition (design decision replacing PR #84's interim
# `CallerPrincipal.viaAgent` downgrade flag — application/task/agent-principal.ts's
# `ensureWorkerAgentPrincipal`), with alice (the Task's on_behalf_of human) kept as provenance on
# the Activity, not as the asserter. Checks the Fact step 2's docker-restart Worker asserted
# (link_type='accept_s2_restarted').
step7_facts_inferred() {
  epistemic_status=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select epistemic_status from links where workspace_id='$WORKSPACE_ID' and id='$DOCKER_RESTART_FACT_ID'" \
    </dev/null 2>/dev/null)
  [ "$epistemic_status" = "inferred" ] || fail "step7-fact-inferred" "Fact $DOCKER_RESTART_FACT_ID has epistemic_status='$epistemic_status', expected 'inferred'"
  pass "step7-fact-inferred" "Fact $DOCKER_RESTART_FACT_ID (accept_s2_restarted, from the docker-restart Worker's report_result) has epistemic_status=inferred"

  asserted_by_kind=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select p.kind from links l join principals p on p.workspace_id = l.workspace_id and p.id = l.asserted_by where l.workspace_id='$WORKSPACE_ID' and l.id='$DOCKER_RESTART_FACT_ID'" \
    </dev/null 2>/dev/null)
  [ "$asserted_by_kind" = "agent" ] || fail "step7-fact-asserted-by-agent" "Fact $DOCKER_RESTART_FACT_ID asserted_by principal kind='$asserted_by_kind', expected 'agent' (application/task/agent-principal.ts's ensureWorkerAgentPrincipal)"

  asserted_by_display_name=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select p.display_name from links l join principals p on p.workspace_id = l.workspace_id and p.id = l.asserted_by where l.workspace_id='$WORKSPACE_ID' and l.id='$DOCKER_RESTART_FACT_ID'" \
    </dev/null 2>/dev/null)
  case "$asserted_by_display_name" in
    worker:*) ;;
    *) fail "step7-fact-asserted-by-agent" "Fact $DOCKER_RESTART_FACT_ID asserted_by principal display_name='$asserted_by_display_name', expected to start with 'worker:'" ;;
  esac
  pass "step7-fact-asserted-by-agent" "Fact asserted_by principal kind='agent' display_name='$asserted_by_display_name' (application/task/agent-principal.ts's ensureWorkerAgentPrincipal, one per (workspace, WorkerDefinition) — see docs/runbooks/host-accept-s2.md)"

  on_behalf_of=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select a.metadata->>'onBehalfOf' from links l join activities a on a.workspace_id = l.workspace_id and a.id = l.activity_id where l.workspace_id='$WORKSPACE_ID' and l.id='$DOCKER_RESTART_FACT_ID'" \
    </dev/null 2>/dev/null)
  [ "$on_behalf_of" = "$ALICE_PRINCIPAL_ID" ] || fail "step7-fact-on-behalf-of-alice" "worker_result Activity metadata.onBehalfOf='$on_behalf_of', expected alice's principal id '$ALICE_PRINCIPAL_ID'"
  pass "step7-fact-on-behalf-of-alice" "worker_result Activity metadata.onBehalfOf=$ALICE_PRINCIPAL_ID (human kept as provenance alongside the agent asserted_by — application/task/result.ts)"
}

# S3.12's own acceptance sentence ("接入一个 fixture MCP server ... 并 publish 后，对话中出现
# <gate>.<op> 工具" — the chat-tool-registration half is out of this script's scope, S3.13's
# session_start projection; this step covers the connection-flow half: "find_operations 命中").
# Mirrors connections_step's http-gate flow (request_connection -> create_connection ->
# publish_manifest -> find_operations) for kind:'mcp': no fronting Gatekeeper process is needed
# for the import itself (docker-compose.yml's accept-s2-mcp service comment) — `endpoint` and
# `manifestSource` both point straight at the fixture's own address, `credentialKind:'shared'`
# (the fixture's two tools need no credential, and 'shared' is also the one value that never
# makes `create_connection` POST a ConnectedAccount credential anywhere — the only thing that
# would actually need a live gate listening at `endpoint`). Appended after step 7 — additive only,
# steps 1-7 above are unchanged.
step8_mcp_connect() {
  up_out=$(docker compose --profile accept-s2 up -d accept-s2-mcp 2>&1)
  up_rc=$?
  if [ "$up_rc" -ne 0 ]; then
    fail "connect-mcp-fixture-up" "docker compose up failed: $(printf '%s' "$up_out" | tail -20)"
  fi
  pass "connect-mcp-fixture-up" "accept-s2-mcp up"

  out=$(cap "$ALICE_KEY" request_connection "{\"kind\":\"mcp\",\"target\":\"accept_s2_mcp\"}" "d.result.id")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-mcp-request" "request_connection(mcp) HTTP $status: $(parse_kv "$out" BODY)"
  CR_ID_MCP=$(parse_kv "$out" EXTRACTED)
  [ -n "$CR_ID_MCP" ] || fail "connect-mcp-request" "no connectionRequestId in response: $(parse_kv "$out" BODY)"
  pass "connect-mcp-request" "connectionRequestId=$CR_ID_MCP"

  out=$(cap "$ALICE_KEY" create_connection \
    "{\"connectionRequestId\":\"$CR_ID_MCP\",\"kind\":\"mcp\",\"target\":\"accept_s2_mcp\",\"endpoint\":\"http://accept-s2-mcp:8080\",\"credentialKind\":\"shared\",\"manifestSource\":\"http://accept-s2-mcp:8080\"}" \
    "d.result.gatekeeperId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-mcp-create" "create_connection(mcp) HTTP $status: $(parse_kv "$out" BODY)"
  GATEKEEPER_ID_MCP=$(parse_kv "$out" EXTRACTED)
  [ -n "$GATEKEEPER_ID_MCP" ] || fail "connect-mcp-create" "no gatekeeperId in response: $(parse_kv "$out" BODY)"
  create_body=$(parse_kv "$out" BODY)
  case "$create_body" in
    *accept_s2_mcp_echo*) : ;;
    *) fail "connect-mcp-create" "importedOperationNames missing accept_s2_mcp_echo: $create_body" ;;
  esac
  case "$create_body" in
    *accept_s2_mcp_note*) : ;;
    *) fail "connect-mcp-create" "importedOperationNames missing accept_s2_mcp_note: $create_body" ;;
  esac
  pass "connect-mcp-create" "gatekeeperId=$GATEKEEPER_ID_MCP (imported both fixture tools from manifestSource tools/list)"

  # Pre-publish half of the same I16/I17 invariant s213-find-operations-pre-publish already checks
  # for the http gate: a freshly-imported draft manifest must not be visible yet.
  out=$(cap "$ALICE_KEY" find_operations "{\"need\":\"accept_s2_mcp\"}" "d.result.items.length")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-mcp-find-operations-pre-publish" "find_operations HTTP $status: $(parse_kv "$out" BODY)"
  pre_count=$(parse_kv "$out" EXTRACTED)
  [ "$pre_count" = "0" ] || fail "connect-mcp-find-operations-pre-publish" "find_operations('accept_s2_mcp') returned $pre_count results before publish_manifest — draft manifest is visible (I16/I17 violation)"
  pass "connect-mcp-find-operations-pre-publish" "find_operations('accept_s2_mcp') misses before publish_manifest, as required"

  out=$(cap "$ALICE_KEY" publish_manifest "{\"gatekeeperId\":\"$GATEKEEPER_ID_MCP\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-mcp-publish" "publish_manifest(mcp) HTTP $status: $(parse_kv "$out" BODY)"
  pass "connect-mcp-publish" "mcp manifest published"

  out=$(cap "$ALICE_KEY" find_operations "{\"need\":\"accept_s2_mcp\"}" "d.result.items.length")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "connect-mcp-find-operations-post-publish" "find_operations HTTP $status: $(parse_kv "$out" BODY)"
  post_count=$(parse_kv "$out" EXTRACTED)
  [ "$post_count" = "2" ] || fail "connect-mcp-find-operations-post-publish" "find_operations('accept_s2_mcp') returned $post_count results after publish_manifest, expected both fixture tools (2)"
  pass "connect-mcp-find-operations-post-publish" "find_operations('accept_s2_mcp') sees both fixture tools after publish_manifest ($post_count result(s))"
}

cleanup_step() {
  if [ "$KEEP" -eq 1 ]; then
    echo "cleanup: --keep set, leaving accept-s2 fixtures/gates/workspace up"
    return
  fi
  resident_stop "$ALICE_PRINCIPAL_ID" >/dev/null 2>&1
  resident_stop "$BOB_PRINCIPAL_ID" >/dev/null 2>&1
  # `down` on a profile also stops every default-profile service (postgres/kernel/…), which broke
  # running accept_s3.sh right after this script (STATUS leftover 26) — `rm -sf` the six accept-s2
  # fixture/gate containers by name instead, leaving the rest of the stack untouched.
  down_out=$(docker compose --profile accept-s2 rm -sf accept-s2-sshd accept-s2-openapi accept-s2-mcp accept-s2-ssh-gate accept-s2-http-gate accept-s2-restart-target 2>&1)
  down_rc=$?
  if [ "$down_rc" -ne 0 ]; then
    echo "cleanup: docker compose --profile accept-s2 rm -sf failed: $down_out" >&2
  fi
  # Workspace/principal/chat/activity/graph rows are the audit trail (design doc §12) — left in
  # place on purpose, same precedent as accept_s1.sh's own cleanup_step.
  pass "cleanup" "stopped alice/bob entry containers, removed the accept-s2 fixture containers; workspace retained: $WORKSPACE_ID"
}

# --------------------------------------------------------------------------------------------
# W7 real-model mode (--real <provider/model> [--runs N]; docs/runbooks/host-accept-real-model.md)
#
# The fake provider replays a hard-coded tool script, so the fake-mode steps above can assert the
# exact tool order and the exact Fact the Worker writes. A real model decides for itself, so each
# scenario below is judged only on its *outcome* — the governed action really reached `executed`,
# the container really restarted, the Task really completed, the reply really carries the
# fixture's payload — repeated RUNS times, and the per-Turn / per-Worker tool-call outcomes the
# driver counts (TOOL_* from chat.stream; transcript-stats from the Worker's pi session JSONL)
# are summed into the REAL summary lines at the end. A single failed run is a data point, not a
# script failure: only a scenario with zero successes fails the script.
# --------------------------------------------------------------------------------------------

REAL_SUMMARY=""

# psql_ws <sql>: one scalar for this workspace (the SQL references $WORKSPACE_ID itself).
psql_ws() {
  docker compose exec -T postgres psql -U nexttime -d nexttime -tAc "$1" </dev/null 2>/dev/null
}

# Tool-outcome accumulators, one set per scenario key (POSIX sh: no arrays — eval'd names).
real_stat_add() {
  # $1 scenario key, $2 ok(1/0), $3 turn tool calls, $4 turn tool errors, $5 worker tool calls, $6 worker tool errors
  eval "REAL_N_$1=\$(( \${REAL_N_$1:-0} + 1 ))"
  eval "REAL_OK_$1=\$(( \${REAL_OK_$1:-0} + $2 ))"
  eval "REAL_TC_$1=\$(( \${REAL_TC_$1:-0} + ${3:-0} ))"
  eval "REAL_TE_$1=\$(( \${REAL_TE_$1:-0} + ${4:-0} ))"
  eval "REAL_WC_$1=\$(( \${REAL_WC_$1:-0} + ${5:-0} ))"
  eval "REAL_WE_$1=\$(( \${REAL_WE_$1:-0} + ${6:-0} ))"
}

real_run_line() {
  # $1 scenario, $2 run index, $3 ok|fail, $4 reason/detail (no secrets)
  printf 'RUN scenario=%s run=%s outcome=%s %s\n' "$1" "$2" "$3" "$4"
}

# Worker transcript stats for a Task: the `worker_session` Source's uri is the container path
# (`/workspace/...`); on the host that is ${NEXTTIME_DATA}/workspaces/tasks/<taskId>/... . Sets
# WT_CALLS / WT_ERRORS / WT_NAMES ("" when no transcript is on file yet).
worker_transcript_stats() {
  WT_CALLS=""; WT_ERRORS=""; WT_NAMES=""
  uri=$(psql_ws "select uri from sources where workspace_id='$WORKSPACE_ID' and kind='worker_session' and metadata->>'taskId'='$1' order by created_at desc limit 1")
  [ -n "$uri" ] || return 0
  case "$uri" in
    /workspace/*) host_path="${NEXTTIME_DATA}/workspaces/tasks/$1/${uri#/workspace/}" ;;
    *) return 0 ;;
  esac
  [ -r "$host_path" ] || return 0
  chmod a+r "$host_path" 2>/dev/null || true
  st=$(run_driver_mount "$host_path" transcript-stats /tmp/mounted)
  WT_CALLS=$(parse_kv "$st" TOOL_CALLS)
  WT_ERRORS=$(parse_kv "$st" TOOL_ERRORS)
  WT_NAMES=$(parse_kv "$st" TOOL_NAMES)
}

# Newest Task of this workspace created after $1 (a psql timestamp); empty when none.
task_created_after() {
  psql_ws "select id from tasks where workspace_id='$WORKSPACE_ID' and created_at > '$1' order by created_at desc limit 1"
}

# Scenario A: "重启测试容器" through chat → entry agent finds a Worker → Worker calls the docker
# gate → the ActionRequest is approved (by the driver, as alice) → executed → the fixture
# container actually restarted → the Task completed.
real_docker_restart_run() {
  i=$1
  run_ts=$(psql_ws "select now()")
  started_before=$(docker inspect -f '{{.State.StartedAt}}' "$RESTART_TARGET_ID" 2>/dev/null)
  [ "$i" -eq 1 ] && resident_stop "$ALICE_PRINCIPAL_ID" >/dev/null 2>&1

  chat_out=$(run_driver send-and-wait "$ALICE_KEY" "" "重启测试容器 CONTAINER_ID=$RESTART_TARGET_ID" 240000 "auto-approve=$GATEKEEPER_ID_DOCKER")
  turn_status=$(parse_kv "$chat_out" TURN_STATUS)
  tc=$(parse_kv "$chat_out" TOOL_CALLS); te=$(parse_kv "$chat_out" TOOL_ERRORS); tn=$(parse_kv "$chat_out" TOOL_NAMES)
  approved=$(parse_kv "$chat_out" APPROVED)

  ar_status=""
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    ar_status=$(psql_ws "select status from action_requests where workspace_id='$WORKSPACE_ID' and gatekeeper_id='$GATEKEEPER_ID_DOCKER' and requested_at > '$run_ts' order by requested_at desc limit 1")
    [ "$ar_status" = "executed" ] && break
    if [ "$ar_status" = "pending_approval" ]; then
      ar_id=$(psql_ws "select id from action_requests where workspace_id='$WORKSPACE_ID' and gatekeeper_id='$GATEKEEPER_ID_DOCKER' and requested_at > '$run_ts' and status='pending_approval' order by requested_at desc limit 1")
      cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$ar_id\"}" "" >/dev/null
    fi
    attempt=$((attempt + 1))
    sleep 3
  done

  task_id=$(task_created_after "$run_ts")
  task_status=""
  if [ -n "$task_id" ]; then
    wt=$(run_driver wait-task "$ALICE_KEY" "$task_id" 150000)
    task_status=$(parse_kv "$wt" TASK_STATUS)
    worker_transcript_stats "$task_id"
  else
    WT_CALLS=""; WT_ERRORS=""; WT_NAMES=""
  fi
  started_after=$(docker inspect -f '{{.State.StartedAt}}' "$RESTART_TARGET_ID" 2>/dev/null)
  restarted=0
  [ -n "$started_before" ] && [ "$started_after" != "$started_before" ] && restarted=1

  ok=0
  [ "$ar_status" = "executed" ] && [ "$restarted" -eq 1 ] && [ "$task_status" = "completed" ] && ok=1
  detail="turn=$turn_status task=${task_id:-none}:${task_status:-none} action=${ar_status:-none} restarted=$restarted approved=${approved:-none} turn_tools=${tc:-0}/${te:-0}[${tn}] worker_tools=${WT_CALLS:-?}/${WT_ERRORS:-?}[${WT_NAMES}]"
  real_run_line docker_restart "$i" "$([ "$ok" -eq 1 ] && echo ok || echo fail)" "$detail"
  real_stat_add docker "$ok" "${tc:-0}" "${te:-0}" "${WT_CALLS:-0}" "${WT_ERRORS:-0}"
  [ "$ok" -eq 1 ] && [ -z "$DOCKER_TASK_ID" ] && DOCKER_TASK_ID=$task_id
  return 0
}

# Scenario B: "测试 API 的 GET 返回什么" → the entry agent observes through the http gate directly
# (observe-class, no Task, no ActionRequest) and its reply carries the fixture's payload.
real_api_observe_run() {
  i=$1
  tasks_before=$(task_count)
  obs_before=$(psql_ws "select count(*) from audit_records where workspace_id='$WORKSPACE_ID' and action='observe_operation'")
  chat_out=$(run_driver send-and-wait "$ALICE_KEY" "" "测试 API 的 GET 返回什么" 180000)
  chat_id=$(parse_kv "$chat_out" CHAT_ID)
  turn_status=$(parse_kv "$chat_out" TURN_STATUS)
  tc=$(parse_kv "$chat_out" TOOL_CALLS); te=$(parse_kv "$chat_out" TOOL_ERRORS); tn=$(parse_kv "$chat_out" TOOL_NAMES)
  history_out=$(run_driver get-history "$ALICE_KEY" "$chat_id" "(d.filter(m=>m.role==='assistant').pop()||{}).text||''")
  last_reply=$(parse_kv "$history_out" EXTRACTED)
  obs_after=$(psql_ws "select count(*) from audit_records where workspace_id='$WORKSPACE_ID' and action='observe_operation'")
  tasks_after=$(task_count)
  has_payload=0
  case "$last_reply" in *NXT*) has_payload=1 ;; esac
  ok=0
  [ "$turn_status" = "completed" ] && [ "$has_payload" -eq 1 ] && [ "${obs_after:-0}" -gt "${obs_before:-0}" ] && [ "$tasks_before" = "$tasks_after" ] && ok=1
  detail="turn=$turn_status payload_in_reply=$has_payload observe_calls=$((${obs_after:-0} - ${obs_before:-0})) tasks_unchanged=$([ "$tasks_before" = "$tasks_after" ] && echo 1 || echo 0) turn_tools=${tc:-0}/${te:-0}[${tn}]"
  real_run_line api_observe "$i" "$([ "$ok" -eq 1 ] && echo ok || echo fail)" "$detail"
  real_stat_add observe "$ok" "${tc:-0}" "${te:-0}" 0 0
  return 0
}

# Scenario C: a Worker asked, in plain language, to run one command on the connected SSH host →
# the unclassified command needs approval → approved (by this script, as alice) → executed → the
# Task completed. $2 = "auto" for the post-"always allow" run, which must NOT produce a pending
# ActionRequest at all (policy_decision=allow).
real_ssh_run() {
  i=$1
  mode=${2:-approve}
  run_ts=$(psql_ws "select now()")
  out=$(cap "$ALICE_KEY" invoke_worker \
    "{\"definitionId\":\"$OPS_RUNNER_ID\",\"version\":$OPS_RUNNER_VERSION,\"input\":\"Run the command \`uptime\` on the connected SSH host and report its raw output in your result summary.\",\"wait\":false,\"gates\":[\"$GATEKEEPER_ID_SSH\"]}" \
    "d.result.id")
  status=$(parse_kv "$out" HTTP_STATUS)
  task_id=$(parse_kv "$out" EXTRACTED)
  if [ "$status" != "200" ] || [ -z "$task_id" ]; then
    real_run_line "ssh_run_$mode" "$i" fail "invoke_worker HTTP $status"
    real_stat_add "ssh_$mode" 0 0 0 0 0
    return 0
  fi
  ar_status=""; saw_pending=0; policy=""
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    ar_status=$(psql_ws "select status from action_requests where workspace_id='$WORKSPACE_ID' and gatekeeper_id='$GATEKEEPER_ID_SSH' and requested_at > '$run_ts' order by requested_at desc limit 1")
    [ "$ar_status" = "executed" ] && break
    if [ "$ar_status" = "pending_approval" ]; then
      saw_pending=1
      ar_id=$(psql_ws "select id from action_requests where workspace_id='$WORKSPACE_ID' and gatekeeper_id='$GATEKEEPER_ID_SSH' and requested_at > '$run_ts' and status='pending_approval' order by requested_at desc limit 1")
      cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$ar_id\"}" "" >/dev/null
    fi
    attempt=$((attempt + 1))
    sleep 3
  done
  policy=$(psql_ws "select policy_decision from action_requests where workspace_id='$WORKSPACE_ID' and gatekeeper_id='$GATEKEEPER_ID_SSH' and requested_at > '$run_ts' order by requested_at desc limit 1")
  wt=$(run_driver wait-task "$ALICE_KEY" "$task_id" 150000)
  task_status=$(parse_kv "$wt" TASK_STATUS)
  worker_transcript_stats "$task_id"
  ok=0
  if [ "$mode" = "auto" ]; then
    [ "$ar_status" = "executed" ] && [ "$saw_pending" -eq 0 ] && [ "$policy" = "allow" ] && [ "$task_status" = "completed" ] && ok=1
  else
    [ "$ar_status" = "executed" ] && [ "$saw_pending" -eq 1 ] && [ "$task_status" = "completed" ] && ok=1
  fi
  detail="task=$task_id:${task_status:-none} action=${ar_status:-none} saw_pending=$saw_pending policy=${policy:-none} worker_tools=${WT_CALLS:-?}/${WT_ERRORS:-?}[${WT_NAMES}]"
  real_run_line "ssh_run_$mode" "$i" "$([ "$ok" -eq 1 ] && echo ok || echo fail)" "$detail"
  real_stat_add "ssh_$mode" "$ok" 0 0 "${WT_CALLS:-0}" "${WT_ERRORS:-0}"
  return 0
}

real_scenarios_step() {
  DOCKER_TASK_ID=""
  i=1
  while [ "$i" -le "$RUNS" ]; do real_docker_restart_run "$i"; i=$((i + 1)); done
  i=1
  while [ "$i" -le "$RUNS" ]; do real_api_observe_run "$i"; i=$((i + 1)); done
  i=1
  while [ "$i" -le "$RUNS" ]; do real_ssh_run "$i" approve; i=$((i + 1)); done

  out=$(cap "$ALICE_KEY" set_auto_approved_action_kind "{\"actionKindTag\":\"ssh.run_command\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "real-always-allow" "set_auto_approved_action_kind HTTP $status: $(parse_kv "$out" BODY)"
  pass "real-always-allow" "workspace policy: ssh.run_command auto-approved from now on"
  real_ssh_run 1 auto
}

# Real-mode replacement for step7_facts_inferred: a real model is free to assert any Facts (or
# none), so assert the platform-side evidence instead — the docker Task's Worker run registered
# its `worker_run` Source (application/task/result.ts) and a `worker_result` Activity exists.
real_evidence_step() {
  if [ -z "$DOCKER_TASK_ID" ]; then
    skip "real-worker-evidence" "no successful docker_restart run to inspect"
    return 0
  fi
  n=$(psql_ws "select count(*) from sources where workspace_id='$WORKSPACE_ID' and kind='worker_run' and metadata->>'taskId'='$DOCKER_TASK_ID'")
  [ "${n:-0}" -ge 1 ] || fail "real-worker-evidence" "no worker_run Source for Task $DOCKER_TASK_ID"
  pass "real-worker-evidence" "Task $DOCKER_TASK_ID has $n worker_run Source(s) (report_task_result landed)"
}

real_summary_step() {
  zero=0
  for key in docker observe ssh_approve ssh_auto; do
    eval "n=\${REAL_N_$key:-0}; ok=\${REAL_OK_$key:-0}; tc=\${REAL_TC_$key:-0}; te=\${REAL_TE_$key:-0}; wc=\${REAL_WC_$key:-0}; we=\${REAL_WE_$key:-0}"
    printf 'REAL scenario=%s ok=%s/%s turn_tool_calls=%s turn_tool_errors=%s worker_tool_calls=%s worker_tool_errors=%s\n' "$key" "$ok" "$n" "$tc" "$te" "$wc" "$we"
    [ "$n" -gt 0 ] && [ "$ok" -eq 0 ] && zero=1
  done
  [ "$zero" -eq 0 ] || fail "real-summary" "at least one scenario had zero successful runs (see REAL lines)"
  pass "real-summary" "every scenario succeeded at least once under model=$REAL_MODEL"
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
if [ "$REAL" -eq 1 ]; then
  real_scenarios_step
  step6_env_and_egress
  real_evidence_step
  step8_mcp_connect
  cleanup_step
  real_summary_step
else
  step2_docker_restart
  step3_observe_no_worker
  step4_step5_ssh_always_allow
  step6_env_and_egress
  step7_facts_inferred
  step8_mcp_connect
  cleanup_step
fi

if [ "$SKIP_COUNT" -gt 0 ]; then
  echo "" >&2
  echo "accept_s2: $SKIP_COUNT step(s) skipped — see SKIP lines above for exact reasons:" >&2
  printf '%s' "$SKIP_LOG" >&2
  echo "accept_s2: known, documented platform gaps (docs/runbooks/host-accept-s2.md 已知偏离), not script defects — see that runbook before re-running." >&2
  exit 1
fi

echo "S2 OK"
exit 0
