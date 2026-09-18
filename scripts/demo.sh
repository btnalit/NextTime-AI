#!/bin/sh
# scripts/demo.sh — S5.8 "交付与演示闭环" item 3 (docs/development-tasks.md §S5.8): a 15-minute,
# single-command demo. POSIX sh, run ON THE HOST from the checkout root — same conventions as
# scripts/accept_s2.sh/accept_s3.sh (this script's own structural template): every docker compose
# run/exec carries </dev/null, every kernel interaction runs through the shared driver
# (deploy/accept/driver.mjs, bind-mounted read-only into a throwaway kernel-image container by
# scripts/lib/accept-common.sh's `run_driver`), secrets are held only in shell variables and
# printed only via redact(), and no temp file is ever written under the repo — the one file this
# script does write, the Markdown result page, always lands under ${NEXTTIME_DATA}.
#
# What it does: create-workspace --purpose ephemeral → run the host-inventory collector once
# against the current host → ask the REAL entry agent three preset questions (Q1 依赖关系; Q2 一条
# 边的来源与最近确认时间; Q3 重启一个测试容器并走审批) → write a one-page Markdown result. It
# doubles as an S5.7 real-model scenario — `--model` is a real `<provider/model>` id, same rule as
# accept_s2.sh/accept_s3.sh's own `--real`: never defaulted.
#
# Usage:
#   sh scripts/demo.sh --model <provider/model> [--keep] [--out <path>]
#   make demo DEMO_MODEL=<provider/model>
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/demo.sh --model <provider/model>' </dev/null
#
# --keep leaves the accept-s2-restart-target fixture container and the workspace's resident entry
# container running (the ephemeral workspace's rows are always retained regardless — see
# cleanup_step; periodic cleanup: `sh scripts/delete-workspaces-matching.sh '^demo-' --yes`).
# --out overrides the default result path (${NEXTTIME_DATA}/demo/demo-<UTC ts>.md); it must not
# resolve under the checkout root.
#
# Preconditions (see docs/runbooks/demo.md for the full walkthrough):
#   - `docker compose up -d` already running (postgres, kernel, llm-proxy, egress-proxy,
#     worker-supervisor, agent-host, docker-socket-proxy-collector, gatekeeper-docker — all
#     default-profile services, no fake-provider override needed: this script always talks to the
#     real, already-deployed provider).
#   - gatekeeper-docker has already announced itself to the platform catalog and its connector is
#     `platform_preset` (docs/runbooks/host-gatekeepers.md) — this script enables the instance in
#     its own ephemeral workspace (idempotent, same "administrator's one click as SQL" precedent as
#     scripts/accept_s2.sh's own connections_step) but does not create the catalog row itself.
#   - `${NEXTTIME_DATA}/secrets/gate_token` and the other host-bootstrap secrets already exist.
#
# Unlike scripts/accept_s3.sh, this script never touches the production collector's secret:
# `make demo` is meant to be run casually on a delivered host with a real model, and a single run
# silently redirecting the host's real `collector-host-inventory` deployment into a throwaway demo
# workspace (accept_s3.sh's own trade-off, acceptable only in a dedicated verification environment)
# is not acceptable here. collector_handle_mint_step instead mints this run's collector Handle into
# a demo-private file under ${NEXTTIME_DATA}/demo/ and collector_run_step points the collector at
# it for this one `--once` invocation via `NEXTTIME_HANDLE_TOKEN_FILE`
# (collectors/host-inventory/src/config.ts reads that env var fresh on every run, falling back to
# `/run/secrets/collector_host_inventory_token` only when it is unset — the production path is
# never read or written by this script). cleanup_step deletes that demo-private token file
# unconditionally (even with --keep — it is a credential, nothing about it is kept).
#
# Duplication note: this script deliberately duplicates small pieces of scripts/accept_s2.sh and
# scripts/accept_s3.sh (bootstrap-workspace parsing, the gatekeeper-docker catalog-enable SQL, the
# ops-runner WorkerDefinition template read, the collector "run complete" field parser, the
# resident-stop helper) rather than importing them — nobody can test a behavior-preserving refactor
# of host-only shell in this environment, and accept_s2.sh/accept_s3.sh are out of scope for this
# lane. Every duplicated piece is called out at its own definition below.

set -u

MODEL=""
KEEP=0
OUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model)
      [ "$#" -ge 2 ] || { echo "demo: --model needs <provider/model>" >&2; exit 1; }
      MODEL=$2
      shift
      ;;
    --keep) KEEP=1 ;;
    --out)
      [ "$#" -ge 2 ] || { echo "demo: --out needs <path>" >&2; exit 1; }
      OUT=$2
      shift
      ;;
    *)
      echo "demo: unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# Never defaulted — same rule as accept_s2.sh/accept_s3.sh's own --real <provider/model>.
[ -n "$MODEL" ] || {
  echo "demo: --model <provider/model> is required (never defaulted — see docs/runbooks/demo.md §2)" >&2
  exit 1
}

if [ ! -f "./docker-compose.yml" ]; then
  echo "demo: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "demo: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${NEXTTIME_DATA:-}" ]; then
  echo "demo: .env must set NEXTTIME_DATA" >&2
  exit 1
fi

. "$(dirname "$0")/lib/accept-common.sh"
require_driver

CHECKOUT_ROOT=$(pwd)
[ -n "$OUT" ] || OUT="${NEXTTIME_DATA}/demo/demo-$(date -u +%Y%m%dT%H%M%SZ).md"
case "$OUT" in
  /*) : ;;
  *) OUT="${CHECKOUT_ROOT}/${OUT}" ;;
esac
case "$OUT" in
  "$CHECKOUT_ROOT"/*)
    echo "demo: --out must not resolve under the checkout root ($CHECKOUT_ROOT) — write under \${NEXTTIME_DATA} instead" >&2
    exit 1
    ;;
esac
mkdir -p "$(dirname "$OUT")" || { echo "demo: could not create $(dirname "$OUT")" >&2; exit 1; }

# --------------------------------------------------------------------------------------------
# Per-step timing (dispatch contract: `STEP <name> ok (<s>s)` / `FAIL <name> <detail>`, first
# failure aborts). Integer seconds, same resolution `ts=$(date +%s)` already used throughout
# accept_s2.sh/accept_s3.sh for workspace-name timestamps — no sub-second timer exists in POSIX sh
# without a non-portable dependency.
# --------------------------------------------------------------------------------------------

DEMO_START=$(date +%s)
STEP_T0=0
STEP_LOG=""

step_begin() {
  STEP_T0=$(date +%s)
}

step_ok() {
  name=$1
  detail=${2:-}
  now=$(date +%s)
  elapsed=$((now - STEP_T0))
  if [ -n "$detail" ]; then
    printf 'STEP %s ok (%ss) %s\n' "$name" "$elapsed" "$detail"
  else
    printf 'STEP %s ok (%ss)\n' "$name" "$elapsed"
  fi
  STEP_LOG="${STEP_LOG}| ${name} | ${elapsed}s | ${detail} |
"
}

step_fail() {
  name=$1
  detail=$2
  printf 'FAIL %s %s\n' "$name" "$detail" >&2
  echo "demo: see docs/runbooks/demo.md §6 常见问题 for this failure" >&2
  exit 1
}

# psql_ws <sql>: one scalar, no workspace scoping implied by the name (duplicated verbatim from
# scripts/accept_s2.sh's own helper of the same name — used only by worker_setup_step's
# gatekeeper-docker catalog check, which reads platform-wide tables).
psql_ws() {
  docker compose exec -T postgres psql -U nexttime -d nexttime -tAc "$1" </dev/null 2>/dev/null
}

# Duplicated from scripts/accept_s3.sh's own resident_stop (cleanup_step only).
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

# Unlike scripts/accept_s3.sh's own run_collector_once, this run is pointed at the demo-private
# token file (DEMO_COLLECTOR_TOKEN_FILE, set by collector_handle_mint_step) via
# NEXTTIME_HANDLE_TOKEN_FILE, never at the production ${NEXTTIME_DATA}/secrets/
# collector-host-inventory.token / /run/secrets/collector_host_inventory_token path the compose
# service's own `environment:`/`secrets:` blocks declare (collectors/host-inventory/src/config.ts's
# `loadConfig`: `env.NEXTTIME_HANDLE_TOKEN_FILE ?? DEFAULT_HANDLE_TOKEN_FILE`, read fresh on every
# run — a `docker compose run -e` override for one invocation is enough, no compose-file edit
# needed; scripts/drill-restore.sh's own `docker compose run --rm -e BACKUP_NOW=1 backup` is the
# same established pattern). The bind-mount target `/run/demo-collector-token` is a fresh path
# under `/run` — the service's own `secrets: [collector_host_inventory_token]` already proves a
# `/run/...` bind target works under this service's `read_only: true` (Docker sets up bind/secret
# mounts before the container's root filesystem's read-only flag applies to the container process;
# it never blocks mount *setup*, only in-container writes afterward).
run_collector_once() {
  docker compose run --rm --no-deps -T \
    -e NEXTTIME_HANDLE_TOKEN_FILE=/run/demo-collector-token \
    -v "${DEMO_COLLECTOR_TOKEN_FILE}:/run/demo-collector-token:ro" \
    collector-host-inventory node dist/index.js --once </dev/null 2>&1
}

collector_run_complete_field() {
  printf '%s\n' "$1" | grep '"message":"run complete"' | tail -1 | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p"
}

# --------------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------------

# preflight: stack + gatekeeper-docker up, collector image built, the throwaway test-container
# fixture available. Driver readability was already asserted by require_driver above (same
# ordering as accept_s2.sh/accept_s3.sh's own top-level `require_driver` call, before their first
# named step).
preflight_step() {
  step_begin
  required_services="postgres kernel llm-proxy egress-proxy worker-supervisor agent-host docker-socket-proxy-collector gatekeeper-docker"
  running=$(docker compose ps --status running --services 2>/dev/null)
  if [ -z "$running" ]; then
    step_fail preflight "docker compose ps returned nothing — is the stack up? (docker compose up -d)"
  fi
  missing=""
  for s in $required_services; do
    if ! printf '%s\n' "$running" | grep -qx "$s"; then
      missing="$missing $s"
    fi
  done
  [ -z "$missing" ] || step_fail preflight "services not running:$missing"

  build_out=$(docker compose build collector-host-inventory 2>&1)
  build_rc=$?
  [ "$build_rc" -eq 0 ] || step_fail preflight "docker compose build collector-host-inventory failed: $(printf '%s' "$build_out" | tail -20)"

  # accept-s2-restart-target (docker-compose.yml, profile "accept-s2"): the deterministic,
  # never-a-real-business-container restart target gatekeeper-docker acts on — same fixture
  # scripts/accept_s2.sh's own fixtures_up_step brings up for the same reason.
  up_out=$(docker compose --profile accept-s2 up -d accept-s2-restart-target 2>&1)
  up_rc=$?
  [ "$up_rc" -eq 0 ] || step_fail preflight "docker compose up accept-s2-restart-target failed: $(printf '%s' "$up_out" | tail -20)"
  restart_target_id=$(docker compose ps -q accept-s2-restart-target)
  [ -n "$restart_target_id" ] || step_fail preflight "accept-s2-restart-target container id not found"
  RESTART_TARGET_ID=$(docker inspect "$restart_target_id" --format '{{.Id}}')
  [ -n "$RESTART_TARGET_ID" ] || step_fail preflight "could not resolve full container id for accept-s2-restart-target"

  step_ok preflight "services up; collector image built; restart target=$RESTART_TARGET_ID"
}

# create-workspace --purpose ephemeral (design decision: never delete it — see cleanup_step).
workspace_create_step() {
  step_begin
  ts=$(date +%s)
  ws_name="demo-$ts"
  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js create-workspace \
    --name "$ws_name" --owner owner --entry-model "$MODEL" --purpose ephemeral --ttl 1d </dev/null 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] || step_fail workspace-create "create-workspace exited $rc: $(printf '%s' "$out" | tail -10)"
  WORKSPACE_ID=$(printf '%s\n' "$out" | sed -n 's/^workspace created: //p')
  OWNER_ID=$(printf '%s\n' "$out" | sed -n 's/^owner principal:   //p')
  OWNER_KEY=$(printf '%s\n' "$out" | awk '/^API key/{getline; print; exit}')
  EXPIRES_AT=$(printf '%s\n' "$out" | sed -n 's/.*(expires \(.*\))/\1/p')
  [ -n "$WORKSPACE_ID" ] && [ -n "$OWNER_ID" ] && [ -n "$OWNER_KEY" ] || step_fail workspace-create "could not parse create-workspace output: $(printf '%s' "$out" | tail -10)"
  step_ok workspace-create "workspace=$WORKSPACE_ID owner=$OWNER_ID key=$(redact "$OWNER_KEY") expires=${EXPIRES_AT:-unknown}"
}

# S3.9(a) equivalent: publish ops-assets v1 — required before the collector's first
# submit_observations (unknown_object_type otherwise). Verbatim mechanics of
# scripts/accept_s3.sh's own seed_domain_pack_step.
domain_pack_seed_step() {
  step_begin
  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js seed-domain-pack \
    --workspace "$WORKSPACE_ID" --principal "$OWNER_ID" --pack-name ops-assets --file-name ops-assets-v1.yaml \
    </dev/null 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] || step_fail domain-pack-seed "seed-domain-pack exited $rc: $(printf '%s' "$out" | tail -10)"
  case "$out" in
    *"domain pack published: ops-assets"*) : ;;
    *) step_fail domain-pack-seed "unexpected output: $out" ;;
  esac
  step_ok domain-pack-seed "$(printf '%s' "$out" | tail -1)"
}

# S3.9(b) equivalent, WITHOUT scripts/accept_s3.sh's own collector_fixtures_step's shared-state
# trade-off: mints the collector's own service Handle the same way (bootstrap.js
# issue-service-handle), but writes it to a demo-private file under ${NEXTTIME_DATA}/demo/ instead
# of the production ${NEXTTIME_DATA}/secrets/collector-host-inventory.token path — see this file's
# own header comment ("Unlike scripts/accept_s3.sh, ..."). Deleted unconditionally in cleanup_step.
#
# File mode: this is a plain bind mount (`-v host:container:ro` in run_collector_once), not a
# docker-compose `secrets:` entry — a `secrets:` entry is re-exposed inside the container as a
# root-owned 0444 file regardless of the host file's own mode (why the production token file can
# stay 640 on the host), but a plain bind mount preserves the host file's own permission bits
# as-is. collectors/host-inventory/Dockerfile runs the collector as uid 10001 (`USER nexttime`, a
# uid unrelated to whoever runs this script) — the same reasoning scripts/lib/accept-common.sh's
# `require_world_readable` already documents for the driver/transcript files it bind-mounts. The
# token file therefore needs an explicit "other" read bit; 644 (not narrower) is used rather than
# `chmod a+r` since this is a freshly-created file this step fully controls. The directory itself
# is 0750 — the container never traverses the host directory tree for a bind-mounted file (only the
# mounted file's own inode/mode is visible inside the container's mount namespace), so narrowing the
# directory costs nothing and keeps it out of casual `ls` by other host users.
collector_handle_mint_step() {
  step_begin
  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js issue-service-handle \
    --workspace "$WORKSPACE_ID" --name host-inventory --scope register_source,submit_observations \
    </dev/null 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] || step_fail collector-handle-mint "issue-service-handle exited $rc: $(printf '%s' "$out" | tail -10)"
  collector_token=$(printf '%s\n' "$out" | tail -n 1)
  [ -n "$collector_token" ] || step_fail collector-handle-mint "could not parse a Handle token from output: $(printf '%s' "$out" | tail -10)"
  mkdir -p "${NEXTTIME_DATA}/demo"
  chmod 0750 "${NEXTTIME_DATA}/demo"
  DEMO_COLLECTOR_TOKEN_FILE="${NEXTTIME_DATA}/demo/collector-$(date -u +%Y%m%dT%H%M%SZ).token"
  printf '%s' "$collector_token" >"$DEMO_COLLECTOR_TOKEN_FILE"
  chmod 644 "$DEMO_COLLECTOR_TOKEN_FILE"
  step_ok collector-handle-mint "token minted into a demo-private file (never ${NEXTTIME_DATA}/secrets/collector-host-inventory.token): $(redact "$collector_token")"
}

# Runs the collector once against the current host; objectsUpserted/factsAsserted from its own
# "run complete" line become this page's object/fact counts (no dedicated count capability exists
# — packages/shared/src/capabilities.ts's `search`/`list_*` are keyset-paginated envelopes with no
# total, so the collector's own authoritative counters from this run are used instead).
collector_run_step() {
  step_begin
  out=$(run_collector_once)
  rc=$?
  [ "$rc" -eq 0 ] || step_fail collector-run "collector-host-inventory --once exited $rc: $(printf '%s' "$out" | tail -20)"
  case "$out" in
    *'"message":"run complete"'*) : ;;
    *) step_fail collector-run "no 'run complete' line in output: $(printf '%s' "$out" | tail -20)" ;;
  esac
  OBJECT_COUNT=$(collector_run_complete_field "$out" objectsUpserted)
  FACT_COUNT=$(collector_run_complete_field "$out" factsAsserted)
  case "$FACT_COUNT" in
    '' | 0) step_fail collector-run "factsAsserted=$FACT_COUNT on the first-ever run (expected > 0): $(printf '%s' "$out" | tail -20)" ;;
  esac
  step_ok collector-run "objectsUpserted=$OBJECT_COUNT factsAsserted=$FACT_COUNT"
}

# Q1: "哪个服务依赖哪个" through the real entry agent. chat_assistant_text (scripts/lib/
# accept-common.sh) polls get_chat_history until the assembled assistant text stabilizes — a real
# model may emit several assistant messages per Turn (that helper's own doc comment).
q1_dependency_step() {
  step_begin
  chat_out=$(run_driver send-and-wait "$OWNER_KEY" "" "哪个服务依赖哪个" 180000)
  chat_id=$(parse_kv "$chat_out" CHAT_ID)
  turn_status=$(parse_kv "$chat_out" TURN_STATUS)
  Q1_TC=$(parse_kv "$chat_out" TOOL_CALLS); Q1_TE=$(parse_kv "$chat_out" TOOL_ERRORS); Q1_TN=$(parse_kv "$chat_out" TOOL_NAMES)
  [ -n "$chat_id" ] || step_fail q1-dependency "no CHAT_ID from send-and-wait: $chat_out"
  [ "$turn_status" = "completed" ] || step_fail q1-dependency "turn status=$turn_status (expected completed within 180s)"
  Q1_REPLY=$(chat_assistant_text "$OWNER_KEY" "$chat_id")
  [ -n "$Q1_REPLY" ] || step_fail q1-dependency "empty assistant reply"
  step_ok q1-dependency "turn_tools=${Q1_TC:-0}/${Q1_TE:-0}[${Q1_TN}]"
}

# Q2: the entry agent is asked about one real edge (kernel depends_on postgres — this repo's own
# docker-compose.yml declares it, same reasoning as scripts/accept_s3.sh's own chat_dependency_step
# doc comment), plus an independent `explain` call on that same Fact for the provenance chain this
# page reports (source kind/uri, and `lastObservation.createdAt` — wire/graph.ts's own doc comment
# on ExplainFactRefSchema.lastObservation: "最近何时确认" — the exact thing Q2 asks in Chinese).
q2_provenance_step() {
  step_begin
  chat_out=$(run_driver send-and-wait "$OWNER_KEY" "" "kernel 依赖 postgres 这条边，它的来源是什么？最近一次确认是什么时候？" 180000)
  chat_id=$(parse_kv "$chat_out" CHAT_ID)
  turn_status=$(parse_kv "$chat_out" TURN_STATUS)
  Q2_TC=$(parse_kv "$chat_out" TOOL_CALLS); Q2_TE=$(parse_kv "$chat_out" TOOL_ERRORS); Q2_TN=$(parse_kv "$chat_out" TOOL_NAMES)
  [ -n "$chat_id" ] || step_fail q2-provenance "no CHAT_ID from send-and-wait: $chat_out"
  [ "$turn_status" = "completed" ] || step_fail q2-provenance "turn status=$turn_status (expected completed within 180s)"
  Q2_REPLY=$(chat_assistant_text "$OWNER_KEY" "$chat_id")
  [ -n "$Q2_REPLY" ] || step_fail q2-provenance "empty assistant reply"

  # Independent graph-side rediscovery of the same Fact (not parsed out of the chat transcript) —
  # identical to scripts/accept_s3.sh's own chat_dependency_step reasoning.
  out=$(cap "$OWNER_KEY" search '{"query":"","objectType":"Container"}' "d.result.items.find(i=>i.identityKey&&i.identityKey.serviceName==='kernel')&&d.result.items.find(i=>i.identityKey&&i.identityKey.serviceName==='kernel').id||''")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || step_fail q2-provenance "search HTTP $status: $(parse_kv "$out" BODY)"
  kernel_container_id=$(parse_kv "$out" EXTRACTED)
  [ -n "$kernel_container_id" ] || step_fail q2-provenance "no Container with identityKey.serviceName='kernel' found"

  out=$(cap "$OWNER_KEY" traverse "{\"fromId\":\"$kernel_container_id\",\"linkType\":\"depends_on\",\"depth\":1}" "d.result.edges[0]&&d.result.edges[0].linkId||''")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || step_fail q2-provenance "traverse HTTP $status: $(parse_kv "$out" BODY)"
  DEPENDS_ON_FACT_ID=$(parse_kv "$out" EXTRACTED)
  [ -n "$DEPENDS_ON_FACT_ID" ] || step_fail q2-provenance "no depends_on edge from kernel Container $kernel_container_id"

  out=$(cap "$OWNER_KEY" explain "{\"nodeId\":\"$DEPENDS_ON_FACT_ID\"}" \
    "JSON.stringify({sourceKind: d.result.activity.observations[0]&&d.result.activity.observations[0].source&&d.result.activity.observations[0].source.kind, sourceUri: d.result.activity.observations[0]&&d.result.activity.observations[0].source&&d.result.activity.observations[0].source.uri, originObservedAt: d.result.activity.observations[0]&&d.result.activity.observations[0].createdAt, lastConfirmedAt: d.result.fact&&d.result.fact.lastObservation&&d.result.fact.lastObservation.createdAt})")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || step_fail q2-provenance "explain HTTP $status: $(parse_kv "$out" BODY)"
  Q2_EXPLAIN_JSON=$(parse_kv "$out" EXTRACTED)
  case "$Q2_EXPLAIN_JSON" in
    *host-inventory-collector*) : ;;
    *) step_fail q2-provenance "explain($DEPENDS_ON_FACT_ID) did not resolve to the collector's Source: $Q2_EXPLAIN_JSON" ;;
  esac
  step_ok q2-provenance "turn_tools=${Q2_TC:-0}/${Q2_TE:-0}[${Q2_TN}] fact=$DEPENDS_ON_FACT_ID"
}

# Prep for Q3 (not a preset question itself): enable the already-deployed gatekeeper-docker in this
# ephemeral workspace and publish a throwaway ops-runner-shaped WorkerDefinition pinned to $MODEL.
# Duplicated mechanics: scripts/accept_s2.sh's own connections_step (the "--- docker ---" block:
# catalog enable-as-SQL, same "administrator's one click" precedent) and ops_runner_step (the
# ontology/ops-runner.yaml template read). No ontology publish step here (unlike accept_s2.sh's own
# ontology_step): that publishes LinkTypes only fake-llm's scripted dockerRestartScenario asserts
# via `assert_fact` — this WorkerDefinition's `capabilities` never includes `assert_fact`, so a real
# model driving it cannot call it regardless.
worker_setup_step() {
  step_begin

  docker_gate_status=$(psql_ws "select status from gate_instances where gate_id='gatekeeper-docker'")
  case "$docker_gate_status" in
    enabled) : ;;
    discovered)
      psql_ws "update gate_instances set status='enabled', updated_at=now() where gate_id='gatekeeper-docker' and status='discovered'" >/dev/null
      ;;
    "") step_fail worker-setup "gatekeeper-docker has not announced itself to the kernel (no gate_instances row) — is the gatekeeper-docker service up?" ;;
    *) step_fail worker-setup "gate instance gatekeeper-docker is '$docker_gate_status' — an administrator's decision, see docs/runbooks/host-gatekeepers.md" ;;
  esac
  docker_connector_mode=$(psql_ws "select mode from connectors where name='docker'")
  [ "$docker_connector_mode" = "platform_preset" ] || step_fail worker-setup "connector 'docker' is in mode '$docker_connector_mode', not platform_preset — see docs/runbooks/host-gatekeepers.md"

  docker_gate_ready=""
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    docker_gate_ready=$(psql_ws "select (last_seen_at is not null and jsonb_array_length(operations) > 0)::text from gate_instances where gate_id='gatekeeper-docker'")
    [ "$docker_gate_ready" = "true" ] && break
    attempt=$((attempt + 1))
    sleep 2
  done
  [ "$docker_gate_ready" = "true" ] || step_fail worker-setup "gatekeeper-docker announced no Operations within 60s"

  out=$(cap "$OWNER_KEY" enable_gate_instance '{"gateId":"gatekeeper-docker"}' "d.result.gatekeeperId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || step_fail worker-setup "enable_gate_instance HTTP $status: $(parse_kv "$out" BODY)"
  GATEKEEPER_ID_DOCKER=$(parse_kv "$out" EXTRACTED)
  [ -n "$GATEKEEPER_ID_DOCKER" ] || step_fail worker-setup "no gatekeeperId in response: $(parse_kv "$out" BODY)"

  out=$(cap "$OWNER_KEY" connect_gatekeeper "{\"gatekeeperId\":\"$GATEKEEPER_ID_DOCKER\",\"principalId\":\"$OWNER_ID\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || step_fail worker-setup "connect_gatekeeper HTTP $status: $(parse_kv "$out" BODY)"

  yaml_json=$(docker compose run --rm --no-deps -T -v "$(pwd)/ontology:/tmp/ontology:ro" kernel node -e "
import('yaml').then(({ parse }) => import('node:fs/promises').then(async ({ readFile }) => {
  const raw = await readFile('/tmp/ontology/ops-runner.yaml', 'utf8');
  const doc = parse(raw);
  delete doc.kind;
  doc.name = 'demo-ops-runner';
  doc.description = 'S5.8 demo Worker: restart the throwaway test container via the docker gate.';
  doc.capabilities = ['request_action'];
  doc.gates = ['$GATEKEEPER_ID_DOCKER'];
  doc.model = '$MODEL';
  process.stdout.write(JSON.stringify(doc));
}));
" </dev/null 2>&1)
  case "$yaml_json" in
    '{'*) : ;;
    *) step_fail worker-setup "could not parse ontology/ops-runner.yaml: $yaml_json" ;;
  esac

  out=$(cap "$OWNER_KEY" propose_worker_definition "{\"kind\":\"worker\",\"definition\":$yaml_json}" "JSON.stringify([d.result.id, d.result.version])")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || step_fail worker-setup "propose_worker_definition HTTP $status: $(parse_kv "$out" BODY)"
  pair=$(parse_kv "$out" EXTRACTED)
  OPS_RUNNER_ID=$(printf '%s' "$pair" | sed -n 's/\["\([^"]*\)".*/\1/p')
  OPS_RUNNER_VERSION=$(printf '%s' "$pair" | sed -n 's/.*,\([0-9]*\)\]/\1/p')
  [ -n "$OPS_RUNNER_ID" ] && [ -n "$OPS_RUNNER_VERSION" ] || step_fail worker-setup "could not parse [definitionId, version] from $pair"

  out=$(cap "$OWNER_KEY" publish_worker_definition "{\"definitionId\":\"$OPS_RUNNER_ID\",\"version\":$OPS_RUNNER_VERSION}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || step_fail worker-setup "publish_worker_definition HTTP $status: $(parse_kv "$out" BODY)"

  step_ok worker-setup "gatekeeperId=$GATEKEEPER_ID_DOCKER demo-ops-runner@$OPS_RUNNER_VERSION published"
}

# Q3: "重启测试容器" — same chat text and auto-approve mechanics as scripts/accept_s2.sh's own
# real_docker_restart_run (W7 real-model mode): send-and-wait's own auto-approve=<gatekeeperId>
# approves any ActionRequest that lands while the Turn is in flight; invoke_worker(wait:false) means
# the Worker's own request may land after the Turn settles, so a follow-up poll (via
# list_action_requests, capability-only — no psql needed, this ephemeral workspace has never issued
# a docker-gate ActionRequest before this call) covers that case too. Judged the same way as
# real_docker_restart_run: the ActionRequest reaches `executed` AND the fixture container's
# `StartedAt` actually changes.
q3_restart_step() {
  step_begin
  started_before=$(docker inspect -f '{{.State.StartedAt}}' "$RESTART_TARGET_ID" 2>/dev/null)
  [ -n "$started_before" ] || step_fail q3-restart "could not read StartedAt for $RESTART_TARGET_ID before the restart"

  chat_out=$(run_driver send-and-wait "$OWNER_KEY" "" "重启测试容器 CONTAINER_ID=$RESTART_TARGET_ID" 240000 "auto-approve=$GATEKEEPER_ID_DOCKER")
  turn_status=$(parse_kv "$chat_out" TURN_STATUS)
  Q3_TC=$(parse_kv "$chat_out" TOOL_CALLS); Q3_TE=$(parse_kv "$chat_out" TOOL_ERRORS); Q3_TN=$(parse_kv "$chat_out" TOOL_NAMES)
  Q3_APPROVED=$(parse_kv "$chat_out" APPROVED)

  ar_id=""
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    out=$(cap "$OWNER_KEY" list_action_requests "{\"gatekeeperId\":\"$GATEKEEPER_ID_DOCKER\"}" "d.result.items[0]&&d.result.items[0].id||''")
    ar_id=$(parse_kv "$out" EXTRACTED)
    [ -n "$ar_id" ] && break
    attempt=$((attempt + 1))
    sleep 2
  done
  [ -n "$ar_id" ] || step_fail q3-restart "no ActionRequest appeared for gatekeeper $GATEKEEPER_ID_DOCKER within 120s (turn status=$turn_status)"

  out=$(cap "$OWNER_KEY" get_action "{\"actionRequestId\":\"$ar_id\"}" "d.result.status")
  ar_status=$(parse_kv "$out" EXTRACTED)
  if [ "$ar_status" = "pending_approval" ]; then
    cap "$OWNER_KEY" approve "{\"actionRequestId\":\"$ar_id\"}" "" >/dev/null
  fi

  executed=0
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    out=$(cap "$OWNER_KEY" get_action "{\"actionRequestId\":\"$ar_id\"}" "JSON.stringify({status: d.result.status, policyDecision: d.result.policyDecision})")
    Q3_ACTION_JSON=$(parse_kv "$out" EXTRACTED)
    case "$Q3_ACTION_JSON" in
      *'"status":"executed"'*) executed=1; break ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done
  [ "$executed" -eq 1 ] || step_fail q3-restart "ActionRequest $ar_id did not reach executed within 60s (last: $Q3_ACTION_JSON)"

  started_after=$(docker inspect -f '{{.State.StartedAt}}' "$RESTART_TARGET_ID" 2>/dev/null)
  [ "$started_after" != "$started_before" ] || step_fail q3-restart "container $RESTART_TARGET_ID StartedAt did not change (still $started_before) — ActionRequest executed but the container was not actually restarted"

  Q3_AR_ID=$ar_id
  Q3_STARTED_BEFORE=$started_before
  Q3_STARTED_AFTER=$started_after
  step_ok q3-restart "actionRequestId=$ar_id turn_tools=${Q3_TC:-0}/${Q3_TE:-0}[${Q3_TN}] auto-approved=${Q3_APPROVED:-none}"
}

# Writes the one-page Markdown result under ${NEXTTIME_DATA} (never the repo — enforced above).
report_write_step() {
  step_begin
  total_elapsed=$(( $(date +%s) - DEMO_START ))
  if [ "$total_elapsed" -le 900 ]; then budget_line="ok"; else budget_line="exceeded"; fi

  cat >"$OUT" <<MDEOF
# NextTime-AI 演示结果：交付与演示闭环（S5.8）

- 时间（UTC）：$(date -u +%Y-%m-%dT%H:%M:%SZ)
- 模型：$MODEL
- workspace：$WORKSPACE_ID（purpose=ephemeral，到期 ${EXPIRES_AT:-unknown}）
- 预算：15 分钟（900s）；总耗时：${total_elapsed}s；BUDGET ${budget_line}

## 步骤耗时

| 步骤 | 耗时 | 说明 |
|---|---|---|
${STEP_LOG}
## 采集：对象数 / 事实数（本次 collector-host-inventory --once）

- objectsUpserted：$OBJECT_COUNT
- factsAsserted：$FACT_COUNT

## Q1：哪个服务依赖哪个

- 回复：$Q1_REPLY
- turn_tools：${Q1_TC:-0}/${Q1_TE:-0} [${Q1_TN:-}]

## Q2：kernel 依赖 postgres 这条边的来源与最近确认时间

- 回复：$Q2_REPLY
- turn_tools：${Q2_TC:-0}/${Q2_TE:-0} [${Q2_TN:-}]
- explain 溯源（Fact=$DEPENDS_ON_FACT_ID）：$Q2_EXPLAIN_JSON

## Q3：重启测试容器并走审批

- 容器：$RESTART_TARGET_ID
- ActionRequest：$Q3_AR_ID — $Q3_ACTION_JSON
- 执行结果：StartedAt $Q3_STARTED_BEFORE → $Q3_STARTED_AFTER（容器已重启）
- turn_tools：${Q3_TC:-0}/${Q3_TE:-0} [${Q3_TN:-}]；send-and-wait 期间 auto-approve 命中：${Q3_APPROVED:-none}
MDEOF

  step_ok report-write "$OUT"
}

# Cleanup fixtures unless --keep. The ephemeral workspace itself is never deleted (design decision
# — see this file's own header comment and scripts/accept_s3.sh's cleanup_step precedent): its
# graph/chat/audit rows are the audit trail, and it expires on its own TTL.
cleanup_step() {
  # The demo-private collector token is a credential, not a fixture — deleted regardless of
  # --keep (see this file's own header comment). The production
  # ${NEXTTIME_DATA}/secrets/collector-host-inventory.token file was never read or written by this
  # run.
  if [ -n "${DEMO_COLLECTOR_TOKEN_FILE:-}" ]; then
    rm -f "$DEMO_COLLECTOR_TOKEN_FILE"
    echo "cleanup: deleted the demo-private collector token ($DEMO_COLLECTOR_TOKEN_FILE) — the production collector's own secret was never touched"
  fi

  if [ "$KEEP" -eq 1 ]; then
    echo "cleanup: --keep set, leaving the accept-s2-restart-target fixture and the owner's entry container running"
    return
  fi
  resident_stop "$OWNER_ID" >/dev/null 2>&1
  rm_out=$(docker compose --profile accept-s2 rm -sf accept-s2-restart-target 2>&1)
  rm_rc=$?
  if [ "$rm_rc" -ne 0 ]; then
    echo "cleanup: docker compose rm -sf accept-s2-restart-target failed: $rm_out" >&2
  fi
  echo "cleanup: stopped the owner's entry container, removed the accept-s2-restart-target fixture; workspace retained: $WORKSPACE_ID (expires ${EXPIRES_AT:-unknown})"
}

# --------------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------------

preflight_step
workspace_create_step
domain_pack_seed_step
collector_handle_mint_step
collector_run_step
q1_dependency_step
q2_provenance_step
worker_setup_step
q3_restart_step
report_write_step
cleanup_step

FINAL_ELAPSED=$(( $(date +%s) - DEMO_START ))
if [ "$FINAL_ELAPSED" -le 900 ]; then FINAL_BUDGET="ok"; else FINAL_BUDGET="exceeded"; fi
echo "demo: result written to $OUT"
printf 'TOTAL %ss BUDGET %s\n' "$FINAL_ELAPSED" "$FINAL_BUDGET"
echo "demo OK"
exit 0
