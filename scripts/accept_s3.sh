#!/bin/sh
# accept_s3.sh — S3 acceptance script (docs/development-tasks.md §S3.9: "采集 → 入口 agent 回答
# 「哪个服务依赖哪个」并 explain → Explorer 端点返回图 → Claude Code 经 MCP 观察同一图" — "退出 0
# 打印 S3 OK"). POSIX sh, run ON THE HOST from the checkout root — same conventions as
# scripts/accept_s1.sh/accept_s2.sh (this script's own structural template): every docker compose
# run/exec carries </dev/null, every kernel interaction runs through one mounted driver script
# inside a throwaway kernel-image container, secrets are held only in shell variables and printed
# only via redact(), no temp file is ever written (the driver is a checked-in file mounted by
# path), and PASS/FAIL lines abort on the first real defect.
#
# Usage:
#   sh scripts/accept_s3.sh [--keep]
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s3.sh' </dev/null
#
# --keep leaves the resident entry container running and skips tearing anything down (workspace
# rows are always retained regardless — see cleanup_step). --keep does not skip the fake-provider
# restore below — the EXIT trap always runs.
#
# Preconditions (see docs/runbooks/host-accept-s3.md for the full walkthrough):
#   - `docker compose up -d` (or at least: postgres kernel llm-proxy egress-proxy worker-supervisor
#     agent-host docker-socket-proxy-collector) already running. The script switches llm-proxy /
#     worker-supervisor / fake-llm to the fake provider itself via
#     deploy/accept/docker-compose.fake.yml and restores production wiring from an EXIT trap, so
#     ${NEXTTIME_DATA}/config/llm-providers.yaml and models.json are never modified — no manual
#     provider switch is needed before or after.
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
# capability call and every Explorer/MCP HTTP call runs through the shared driver,
# deploy/accept/driver.mjs, bind-mounted read-only into a throwaway kernel-image container by
# the shared `run_driver` helper in scripts/lib/ (see that file's own header comment for the exact
# `docker compose run` invocation — no temp file), talking to the real running kernel over the
# `control` network
# (`http://kernel:8080/...`) — never through caddy (docs/development-tasks.md §S3.9 (d) is
# explicit: "call the kernel directly from the kernel image like other steps, not via caddy"). No
# `jq` dependency — every JSON field this script needs is extracted with a real `JS.parse()`/JS
# expression evaluated inside the same driver.mjs invocation that made the call — see driver.mjs's
# own header comment for the `cap`/`send-and-wait`/`get-history`/`explorer`/`mcp` subcommand
# contracts.
#
# Confidentiality (repo is public): every generated secret (the collector's service-Handle token,
# API keys) is held only in shell variables/files under ${NEXTTIME_DATA} for this process's
# lifetime and only ever printed via redact().

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

. "$(dirname "$0")/lib/accept-common.sh"
require_driver

# Traps first, switch second: if the recreate fails half-way the EXIT trap still restores
# whatever landed on the override; HUP/PIPE cover a dropped ssh session (the documented way
# to run this script), which would otherwise kill the shell without running the EXIT trap.
trap accept_provider_restore EXIT
trap 'accept_provider_restore; exit 130' INT TERM HUP PIPE
accept_provider_up || fail "preflight-fake-provider" "could not switch the stack to the fake provider (deploy/accept/docker-compose.fake.yml)"
pass "preflight-fake-provider" "llm-proxy / worker-supervisor / fake-llm recreated on deploy/accept/docker-compose.fake.yml; production provider config untouched"

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

# docs/STATUS.md §2.2's own known blind spot: the only Conflict assertion above
# (collector_second_run_step) checks that TWO IDENTICAL collector runs open zero Conflicts — a
# defect that *suppresses* Conflict-opening entirely would still pass that check. This step
# exercises the actual open-a-Conflict path (substrate/graph/sql-store.ts's `assertFact`, W5.5):
# an assertion from a DIFFERENT Source, with DIFFERENT content, against the SAME
# (linkType, sourceObjectId, targetObjectId) identity as an existing active Fact must open exactly
# one `open` Conflict. Reuses the real Container/Host pair `collector_first_run_step` already
# established ($container_id, plus the Host discovered here via the same `runs_on` traverse) so
# the contradicting assertion lands on a real active Fact, not a fixture. Both `register_source`
# and `submit_observations` are handle-channel capabilities, but `cap "$OWNER_KEY" ...` already
# calls handle-channel capabilities with the owner API key elsewhere in this script (e.g.
# `list_conflicts` just above) — `authorizeCapabilityCall` only blocks human-only capabilities for
# handles, not the reverse. Leaves the Conflict open on purpose: the workspace is retained
# (cleanup_step) but not reused across acceptance runs, and `chat_dependency_step`'s own `explain`
# below targets a `depends_on` Fact (kernel -> postgres), not this `runs_on` Fact, so it is
# unaffected by the open Conflict left behind here.
collector_conflict_positive_step() {
  out=$(cap "$OWNER_KEY" register_source '{"kind":"host-inventory-collector","name":"accept-s3-second-source","visibility":"workspace"}' "d.result.id")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "collector-conflict-positive-source" "register_source HTTP $status: $(parse_kv "$out" BODY)"
  second_source_id=$(parse_kv "$out" EXTRACTED)
  [ -n "$second_source_id" ] || fail "collector-conflict-positive-source" "no id in register_source response: $(parse_kv "$out" BODY)"
  pass "collector-conflict-positive-source" "second Source=$second_source_id"

  out=$(cap "$OWNER_KEY" get_object "{\"objectId\":\"$container_id\"}" "d.result&&d.result.identityKey")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "collector-conflict-positive-identity" "get_object(container $container_id) HTTP $status: $(parse_kv "$out" BODY)"
  container_identity=$(parse_kv "$out" EXTRACTED)
  [ -n "$container_identity" ] || fail "collector-conflict-positive-identity" "no identityKey on Container $container_id: $(parse_kv "$out" BODY)"

  out=$(cap "$OWNER_KEY" traverse "{\"fromId\":\"$container_id\",\"linkType\":\"runs_on\",\"depth\":1}" "d.result.edges[0]&&d.result.edges[0].targetObjectId||''")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "collector-conflict-positive-identity" "traverse(runs_on) from Container $container_id HTTP $status: $(parse_kv "$out" BODY)"
  host_id=$(parse_kv "$out" EXTRACTED)
  [ -n "$host_id" ] || fail "collector-conflict-positive-identity" "no runs_on edge from Container $container_id to resolve the Host identity from: $(parse_kv "$out" BODY)"

  out=$(cap "$OWNER_KEY" get_object "{\"objectId\":\"$host_id\"}" "d.result&&d.result.identityKey")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "collector-conflict-positive-identity" "get_object(host $host_id) HTTP $status: $(parse_kv "$out" BODY)"
  host_identity=$(parse_kv "$out" EXTRACTED)
  [ -n "$host_identity" ] || fail "collector-conflict-positive-identity" "no identityKey on Host $host_id: $(parse_kv "$out" BODY)"
  pass "collector-conflict-positive-identity" "container=$container_identity host=$host_identity"

  submit_params="{\"sourceId\":\"$second_source_id\",\"observations\":[{\"objectType\":\"Container\",\"identity\":$container_identity,\"links\":[{\"linkType\":\"runs_on\",\"target\":{\"objectType\":\"Host\",\"identity\":$host_identity},\"properties\":{\"accept_s3_marker\":\"contradiction\"}}]}]}"
  out=$(cap "$OWNER_KEY" submit_observations "$submit_params" "d.result.factsAsserted")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "collector-conflict-positive-submit" "submit_observations HTTP $status: $(parse_kv "$out" BODY)"
  facts_asserted=$(parse_kv "$out" EXTRACTED)
  [ "$facts_asserted" = "1" ] || fail "collector-conflict-positive-submit" "factsAsserted=$facts_asserted (expected 1 — a contradicting assertion from a different Source inserts a new active Fact alongside the prior one and opens a Conflict, substrate/graph/sql-store.ts's assertFact): $(parse_kv "$out" BODY)"
  pass "collector-conflict-positive-submit" "second Source's contradicting runs_on assertion: factsAsserted=1"

  out=$(cap "$OWNER_KEY" list_conflicts '{"status":"open"}' "JSON.stringify({count: d.result.items.length, factAId: d.result.items[0]&&d.result.items[0].factAId, factBId: d.result.items[0]&&d.result.items[0].factBId})")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "collector-conflict-positive-open-count" "list_conflicts HTTP $status: $(parse_kv "$out" BODY)"
  conflict_summary=$(parse_kv "$out" EXTRACTED)
  case "$conflict_summary" in
    *'"count":1'*) : ;;
    *) fail "collector-conflict-positive-open-count" "expected exactly 1 open Conflict after the contradicting cross-Source assertion, got: $conflict_summary ($(parse_kv "$out" BODY))" ;;
  esac
  pass "collector-conflict-positive-open-count" "1 open Conflict: $conflict_summary"
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
collector_conflict_positive_step
chat_dependency_step
explorer_step
mcp_step
cleanup_step

echo "S3 OK"
exit 0
