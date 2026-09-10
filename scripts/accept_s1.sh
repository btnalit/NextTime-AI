#!/bin/sh
# accept_s1.sh — S1 acceptance script (docs/development-tasks.md S1.10; design doc
# graph-ai-middle-platform-design.md §14 verification table, §15 S1 acceptance sentence). POSIX
# sh, run ON THE HOST from the checkout root (docker compose reads ./docker-compose.yml and
# ./.env from cwd — same convention as scripts/restore.sh).
#
# Usage:
#   sh scripts/accept_s1.sh [--keep]
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s1.sh' </dev/null
#
# --keep skips the cleanup step (leaves alice/bob's entry containers running for inspection).
#
# Every docker compose run/exec below carries </dev/null: this script is meant to work when
# piped or invoked non-interactively over ssh, where stdin may not be a terminal — a command that
# tries to read stdin (docker's own attach behavior for `run`/`exec` without -T, or a REPL if one
# were ever accidentally invoked) would otherwise hang forever waiting for input that never comes.
#
# Toolset (task brief: "uses only docker compose + curl + node *inside the kernel image*" — the
# host has neither node nor corepack, docs/runbooks/host-worker-runtime.md §10): every JSON-RPC
# interaction with the kernel's chat WebSocket runs through the shared driver, deploy/accept/
# driver.mjs, bind-mounted read-only into a throwaway kernel-image container per invocation by
# the shared `run_driver` helper in scripts/lib/ (see that file's own header comment for the exact
# `docker compose run` invocation — no temp file) rather than passed inline via `node -e "..."` —
# the script is long enough (event
# handling, promises, several subcommands) that inlining it as a single -e argument would be
# unreadable and risk shell-quoting mistakes; a few short one-off calls (worker-supervisor
# status/stop) use `node -e "..."` directly instead, matching
# docs/runbooks/host-worker-runtime.md's own established pattern. Every such node process talks to
# the kernel's `/ws` and `/api/cap/*` surface directly inside the `control` network
# (ws://kernel:8080/ws) rather than through caddy's self-signed TLS — except the `explain` step,
# which the task brief explicitly routes through caddy with `curl -sk` (exercising the one
# host-reachable path, caddy's published port, for that specific assertion) — see driver.mjs's own
# header comment and the explain_step() comment below for why each transport was chosen.
#
# Confidentiality (repo is public): API keys are held only in shell variables and container env
# vars for this process's lifetime, never written to a file, and only ever printed via redact()
# (first 6 characters). Keys are passed to the driver as CLI arguments at each `docker compose run`
# invocation, never baked into a file.

set -u

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *)
      echo "accept_s1: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "./docker-compose.yml" ]; then
  echo "accept_s1: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "accept_s1: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${NEXTTIME_DATA:-}" ] || [ -z "${KERNEL_BIND_ADDR:-}" ]; then
  echo "accept_s1: .env must set NEXTTIME_DATA and KERNEL_BIND_ADDR" >&2
  exit 1
fi

. "$(dirname "$0")/lib/accept-common.sh"
require_driver

# GET /resident/<principalId> via the kernel image's own fetch() against worker-supervisor
# (control-network-only — no host port; docs/runbooks/host-worker-runtime.md's own established
# `node -e "fetch(...)..."` pattern, run from the kernel image here rather than exec'ing into the
# already-running worker-supervisor container, since the task brief specifically calls out node
# running "inside the kernel image"). `/resident/*` is gated on the internal-plane token since the
# runtime hardening (F6 / PR #78) — the kernel container has the same token at
# /run/secrets/internal_token, so the probe sends it as a Bearer; without it the 401 body used to be
# misread as "found, but no restarts" (2026-09-08 regression run).
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
  required_services="postgres kernel caddy llm-proxy egress-proxy worker-supervisor agent-host fake-llm"
  running=$(docker compose --profile test ps --status running --services 2>/dev/null)
  if [ -z "$running" ]; then
    fail "preflight-services" "docker compose --profile test ps returned nothing — is the stack up?"
  fi
  missing=""
  for s in $required_services; do
    if ! printf '%s\n' "$running" | grep -qx "$s"; then
      missing="$missing $s"
    fi
  done
  if [ -n "$missing" ]; then
    fail "preflight-services" "not running:$missing — run: docker compose --profile test up -d"
  fi
  pass "preflight-services" "running: $required_services"

  providers_file="${NEXTTIME_DATA}/config/llm-providers.yaml"
  if [ ! -f "$providers_file" ]; then
    fail "preflight-fake-provider" "$providers_file not found — see docs/runbooks/host-agent-host.md §3: cp config/llm-providers.fake.example.yaml \"\$NEXTTIME_DATA/config/llm-providers.yaml\" && echo 'FAKE_LLM_API_KEY=fake' >> \"\$NEXTTIME_DATA/secrets/llm-proxy.env\" && make gen-models"
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
}

bootstrap_step() {
  ts=$(date +%s)
  ws_name="accept-s1-$ts"

  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js create-workspace --name "$ws_name" --owner alice </dev/null 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "bootstrap-workspace" "create-workspace exited $rc: $(printf '%s' "$out" | tail -5)"
  fi
  # bootstrap.js's own two id lines aren't `KEY=value` shaped (they're `workspace created: <id>` /
  # `owner principal:   <id>`, human-readable CLI output) — extracted with sed, not parse_kv.
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

entry_worker_definition_step() {
  # S2.6 landed the WorkerDefinition registry — create-workspace now seeds and publishes v1 of
  # the entry WorkerDefinition (ontology/entry-agent.yaml) in the same transaction as the
  # workspace/owner rows (packages/kernel/src/cli/bootstrap.ts). Read directly with psql, same
  # convention egress_step already uses for a row no capability projects verbatim.
  entry_count=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select count(*) from worker_definitions where workspace_id='$WORKSPACE_ID' and kind='entry' and status='published'" \
    </dev/null 2>/dev/null)
  if [ "$entry_count" != "1" ]; then
    fail "entry-worker-definition-seeded" "expected exactly 1 published entry WorkerDefinition for workspace $WORKSPACE_ID, got '$entry_count'"
  fi
  entry_def_id=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
    "select id from worker_definitions where workspace_id='$WORKSPACE_ID' and kind='entry' and status='published' limit 1" \
    </dev/null 2>/dev/null)
  if [ -z "$entry_def_id" ]; then
    fail "entry-worker-definition-seeded" "could not read the seeded entry WorkerDefinition's id"
  fi
  pass "entry-worker-definition-seeded" "workspace $WORKSPACE_ID has a published entry WorkerDefinition ($entry_def_id@1)"

  # Propose v2 via the human channel, through caddy — same transport explain_step already uses
  # (task brief: "POST /api/cap/propose_worker_definition through caddy with the owner's key").
  propose_resp=$(curl -sk -X POST "https://${KERNEL_BIND_ADDR}:8443/api/cap/propose_worker_definition" \
    -H "Authorization: Bearer $ALICE_KEY" \
    -H 'content-type: application/json' \
    -d "{\"definitionId\":\"$entry_def_id\",\"kind\":\"entry\",\"definition\":{\"systemPrompt\":\"accept_s1 v2 entry prompt\",\"capabilities\":[\"get_object\"]}}")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "entry-worker-definition-propose-v2" "curl to caddy failed (rc=$rc)"
  fi
  case "$propose_resp" in
    *'"ok":true'*) : ;;
    *) fail "entry-worker-definition-propose-v2" "propose_worker_definition failed: $propose_resp" ;;
  esac
  v2_version=$(printf '%s' "$propose_resp" | sed -n 's/.*"version":\([0-9]*\).*/\1/p')
  if [ -z "$v2_version" ]; then
    fail "entry-worker-definition-propose-v2" "could not parse version from response: $propose_resp"
  fi
  pass "entry-worker-definition-propose-v2" "proposed $entry_def_id@$v2_version (draft)"

  # Publish v2, same transport.
  publish_resp=$(curl -sk -X POST "https://${KERNEL_BIND_ADDR}:8443/api/cap/publish_worker_definition" \
    -H "Authorization: Bearer $ALICE_KEY" \
    -H 'content-type: application/json' \
    -d "{\"definitionId\":\"$entry_def_id\",\"version\":$v2_version}")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "entry-worker-definition-publish-v2" "curl to caddy failed (rc=$rc)"
  fi
  case "$publish_resp" in
    *'"ok":true'*) pass "entry-worker-definition-publish-v2" "published $entry_def_id@$v2_version" ;;
    *) fail "entry-worker-definition-publish-v2" "publish_worker_definition failed: $publish_resp" ;;
  esac

  # I16: a Handle-channel publish attempt must be rejected 403. Minting a real Capability Handle
  # from this POSIX shell script is not cheap (no node/corepack on the host —
  # docs/runbooks/host-worker-runtime.md §10 — and no capability mints one for arbitrary shell
  # use; issuance is internal to agent-host's own kernel link) — asserted instead by a kernel unit
  # test that exercises the real gateway pipeline end to end
  # (packages/kernel/src/application/gateway/handlers.test.ts, "gateway/handlers — S2.6
  # worker-definition registry + I16": "publish_worker_definition is rejected on the handle
  # channel (I16, human-only)", run in CI). See docs/runbooks/accept-s1.md "已知缺口".
  skip "entry-worker-definition-handle-403 (asserted by a kernel unit test — see docs/runbooks/accept-s1.md)"
}

chat_step() {
  out=$(run_driver send-and-wait "$ALICE_KEY" "" "hello from alice" 120000 strict)
  if printf '%s\n' "$out" | grep -q '^ERROR='; then
    fail "chat-alice" "$(parse_kv "$out" ERROR)"
  fi
  ALICE_CHAT_ID=$(parse_kv "$out" CHAT_ID)
  ALICE_TURN1_ID=$(parse_kv "$out" TURN_ID)
  status=$(parse_kv "$out" TURN_STATUS)
  echo_seen=$(parse_kv "$out" ECHO_SEEN)
  history_count=$(parse_kv "$out" HISTORY_COUNT)
  [ -n "$ALICE_CHAT_ID" ] || fail "chat-alice" "no CHAT_ID in driver output: $out"
  [ "$status" = "completed" ] || fail "chat-alice" "turn status=$status (expected completed): $out"
  [ "$echo_seen" = "1" ] || fail "chat-alice" "no assistant message containing 'echo:' observed: $out"
  [ "$history_count" = "2" ] || fail "chat-alice" "chat history has $history_count message(s), expected 2: $out"
  pass "chat-alice" "chat=$ALICE_CHAT_ID turn=$ALICE_TURN1_ID status=$status history=$history_count"

  out=$(run_driver send-and-wait "$BOB_KEY" "" "hello from bob" 120000 strict)
  if printf '%s\n' "$out" | grep -q '^ERROR='; then
    fail "chat-bob" "$(parse_kv "$out" ERROR)"
  fi
  BOB_CHAT_ID=$(parse_kv "$out" CHAT_ID)
  status=$(parse_kv "$out" TURN_STATUS)
  echo_seen=$(parse_kv "$out" ECHO_SEEN)
  history_count=$(parse_kv "$out" HISTORY_COUNT)
  [ -n "$BOB_CHAT_ID" ] || fail "chat-bob" "no CHAT_ID in driver output: $out"
  [ "$status" = "completed" ] || fail "chat-bob" "turn status=$status (expected completed): $out"
  [ "$echo_seen" = "1" ] || fail "chat-bob" "no assistant message containing 'echo:' observed: $out"
  [ "$history_count" = "2" ] || fail "chat-bob" "chat history has $history_count message(s), expected 2: $out"
  pass "chat-bob" "chat=$BOB_CHAT_ID status=$status history=$history_count"
}

isolation_step() {
  out=$(run_driver isolation-check "$BOB_KEY" "$ALICE_CHAT_ID")
  if printf '%s\n' "$out" | grep -q '^ERROR='; then
    fail "isolation" "$(parse_kv "$out" ERROR)"
  fi
  err_code=$(parse_kv "$out" HISTORY_ERROR_CODE)
  contains=$(parse_kv "$out" LIST_CONTAINS_OTHER)

  [ "$err_code" = "-32004" ] || fail "isolation-history" "bob's get_chat_history on alice's chat returned code=$err_code, expected -32004"
  pass "isolation-history" "bob get_chat_history(alice's chat) -> JSON-RPC error $err_code"

  [ "$contains" = "0" ] || fail "isolation-list" "bob's list_chats includes alice's chat"
  pass "isolation-list" "bob's list_chats does not include alice's chat"
}

kill_and_continue_step() {
  alice_container="nexttime-entry-$ALICE_PRINCIPAL_ID"
  if ! docker kill "$alice_container" >/dev/null 2>&1; then
    fail "kill-alice-entry" "docker kill $alice_container failed (was it running?)"
  fi
  pass "kill-alice-entry" "killed $alice_container"

  out=$(run_driver send-and-wait "$ALICE_KEY" "$ALICE_CHAT_ID" "hello again from alice" 120000 strict)
  if printf '%s\n' "$out" | grep -q '^ERROR='; then
    fail "continue-alice" "$(parse_kv "$out" ERROR)"
  fi
  ALICE_TURN2_ID=$(parse_kv "$out" TURN_ID)
  status=$(parse_kv "$out" TURN_STATUS)
  echo_seen=$(parse_kv "$out" ECHO_SEEN)
  history_count=$(parse_kv "$out" HISTORY_COUNT)
  [ "$status" = "completed" ] || fail "continue-alice" "second turn status=$status (expected completed): $out"
  [ "$echo_seen" = "1" ] || fail "continue-alice" "no assistant echo observed on second turn: $out"
  [ "$history_count" = "4" ] || fail "continue-alice" "chat history has $history_count message(s), expected 4: $out"
  pass "continue-alice" "second turn=$ALICE_TURN2_ID status=$status history=$history_count"

  out=$(resident_status "$ALICE_PRINCIPAL_ID")
  restarts=$(parse_kv "$out" RESTARTS)
  case "$restarts" in
    '' | *[!0-9]*) fail "continue-restarts" "could not parse RESTARTS from resident status: $out" ;;
  esac
  [ "$restarts" -ge 1 ] || fail "continue-restarts" "restarts=$restarts, expected >= 1: $out"
  pass "continue-restarts" "GET /resident/$ALICE_PRINCIPAL_ID restarts=$restarts"
}

# POST /api/cap/explain via caddy (task brief: "via caddy, alice's API key") — the one step that
# deliberately goes through caddy's published, self-signed-TLS port rather than the internal
# control-network path everything else in this script uses, per the task brief's own wording.
explain_step() {
  resp=$(curl -sk -X POST "https://${KERNEL_BIND_ADDR}:8443/api/cap/explain" \
    -H "Authorization: Bearer $ALICE_KEY" \
    -H 'content-type: application/json' \
    -d "{\"nodeId\":\"$ALICE_TURN2_ID\"}")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "explain" "curl to caddy failed (rc=$rc) — is caddy up and KERNEL_BIND_ADDR reachable?"
  fi
  case "$resp" in
    *'"ok":true'*) : ;;
    *) fail "explain" "response was not ok: $resp" ;;
  esac
  case "$resp" in
    *"$ALICE_PRINCIPAL_ID"*)
      pass "explain" "principal $ALICE_PRINCIPAL_ID reached via explain(turn=$ALICE_TURN2_ID)"
      ;;
    *) fail "explain" "principal id not found in explain response: $resp" ;;
  esac
}

egress_step() {
  alice_container="nexttime-entry-$ALICE_PRINCIPAL_ID"

  # Fire a fresh Turn without waiting for it, then immediately exercise egress from inside the
  # entry container — aiming to overlap the curl with the Turn actually running (task brief:
  # "send a message, immediately exec the curl, then wait for completion"). The kernel's own
  # attribution fallback (a short grace window onto the most recently-ended Turn — see
  # packages/kernel/src/application/host-bridge/egress-observations.ts) makes the exact timing
  # non-critical either way.
  send_out=$(run_driver send-only "$ALICE_KEY" "$ALICE_CHAT_ID" "egress check $(date +%s)")
  if printf '%s\n' "$send_out" | grep -q '^ERROR='; then
    fail "egress-turn-start" "$(parse_kv "$send_out" ERROR)"
  fi
  egress_turn_id=$(parse_kv "$send_out" TURN_ID)
  [ -n "$egress_turn_id" ] || fail "egress-turn-start" "no TURN_ID in driver output: $send_out"

  public_code=$(docker exec "$alice_container" curl -sS -o /dev/null -w '%{http_code}' https://example.com 2>/dev/null)
  if [ "$public_code" != "200" ]; then
    fail "egress-public-allowed" "docker exec $alice_container curl https://example.com -> '$public_code' (expected 200)"
  fi
  pass "egress-public-allowed" "https://example.com -> 200"

  internal_code=$(docker exec "$alice_container" curl -m 5 -sS -o /dev/null -w '%{http_code}' http://postgres:5432 2>/dev/null)
  internal_rc=$?
  if [ "$internal_rc" -eq 0 ] && [ "$internal_code" = "200" ]; then
    fail "egress-internal-denied" "docker exec $alice_container curl http://postgres:5432 unexpectedly returned 200"
  fi
  pass "egress-internal-denied" "http://postgres:5432 -> denied (curl rc=$internal_rc, http_code='$internal_code')"

  # Poll up to 30s for 'example.com' to land in this Turn's activities.metadata.egress —
  # egress-proxy reports asynchronously with backoff (packages/egress-proxy/src/report.ts).
  # Read directly with psql (task brief: "audit_query/explain/a direct psql read" — audit_query
  # cannot see it, this write bypasses the capability/audit path entirely by design; explain's own
  # projection does not expose raw metadata — see substrate/epistemic/explain.ts).
  found=0
  attempt=0
  last_md=""
  while [ "$attempt" -lt 15 ]; do
    last_md=$(docker compose exec -T postgres psql -U nexttime -d nexttime -tAc \
      "select metadata->'egress' from activities where workspace_id='$WORKSPACE_ID' and id='$egress_turn_id'" \
      </dev/null 2>/dev/null)
    case "$last_md" in
      *example.com*)
        found=1
        break
        ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done
  if [ "$found" -ne 1 ]; then
    fail "egress-domain-recorded" "example.com not found in activities.metadata.egress for turn $egress_turn_id within 30s (last read: $last_md)"
  fi
  pass "egress-domain-recorded" "example.com recorded in metadata.egress for turn $egress_turn_id"
}

env_step() {
  alice_container="nexttime-entry-$ALICE_PRINCIPAL_ID"
  env_dump=$(docker exec "$alice_container" env)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "env" "docker exec $alice_container env failed"
  fi

  api_key_count=$(printf '%s\n' "$env_dump" | grep -c '_API_KEY=')
  if [ "$api_key_count" != "0" ]; then
    fail "env-no-api-keys" "found $api_key_count *_API_KEY= var(s) in entry container env"
  fi
  pass "env-no-api-keys" "0 *_API_KEY= vars in entry container env"

  handle_count=$(printf '%s\n' "$env_dump" | grep -c '^CAPABILITY_HANDLE=')
  if [ "$handle_count" != "1" ]; then
    fail "env-capability-handle" "expected exactly 1 CAPABILITY_HANDLE= var, found $handle_count"
  fi
  pass "env-capability-handle" "CAPABILITY_HANDLE present exactly once (value never printed)"
}

cleanup_step() {
  if [ "$KEEP" -eq 1 ]; then
    echo "cleanup: --keep set, leaving alice/bob entry containers running"
    return
  fi
  resident_stop "$ALICE_PRINCIPAL_ID" >/dev/null 2>&1
  resident_stop "$BOB_PRINCIPAL_ID" >/dev/null 2>&1
  # Workspace/principal/chat/activity rows are the audit trail (design doc §12) — left in place on
  # purpose, per the task brief ("leave the workspace rows ... but print the workspace id").
  pass "cleanup" "stopped alice/bob entry containers via the supervisor API; workspace retained: $WORKSPACE_ID"
}

# --------------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------------

preflight_step
bootstrap_step
entry_worker_definition_step
chat_step
isolation_step
kill_and_continue_step
explain_step
egress_step
env_step
cleanup_step

echo "S1 OK"
exit 0
