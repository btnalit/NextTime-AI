#!/bin/sh
# accept_s4.sh — S4 acceptance script: "every connected system, through the real kernel path."
# POSIX sh, run ON THE HOST from the checkout root — same conventions as scripts/accept_s1.sh/
# accept_s2.sh/accept_s3.sh (this script's own structural template): every docker compose run
# carries </dev/null, every kernel interaction runs through the shared driver
# (deploy/accept/driver.mjs) inside a throwaway kernel-image container, secrets are held only in
# shell variables and printed only via redact(), no temp file is ever written, and a PASS/FAIL/SKIP
# line is printed for every step.
#
# Why (production incident): a member's entry agent could not call a connected system (RagFlow)
# because the platform connector deny list disabled all of its Operations, while the console's
# execution-readiness view (`execution_readiness`, application/gateway/capability-reachability.ts)
# said the gate was fine — that computation does not check the connector deny list at all (it
# reproduces the *scope* half of the enforcement path — Grants / AgentProfile / policy — not the
# per-Operation `disabled_by_platform` half `observe_operation` itself enforces,
# application/gateway/request-action-handler.ts's `assertOperationEnabled`). S1–S3 never exercised
# "every connected system, through the real kernel path" at all — this script does: for every
# platform gate instance enabled for this workspace, it (a) enables + grants it exactly the way an
# operator would (docs/platform-admin-design.md §6.3), (b) reads the kernel's own readiness read
# model (`execution_readiness`) and the entry agent's own per-Operation reachability
# (`find_operations`), and (c) makes one real, governed `observe_operation` call through the same
# Handle-channel path a member's own entry agent would use — then reports whether readiness and
# enforcement agree, and if not, which layer is lying. (d) Since decision D4 was revoked
# (2026-09-27, "只读调用不需要授权"), it repeats the same observe call through a member-role
# principal holding no Grant at all and asserts readiness `direct` + the tool projected + HTTP 200
# (member_probe_setup_step / member_probe). (e) Leftover 97 (maintainer 2026-09-27 "也放开吧"): the
# same call on the *human channel* — an API key held by a member-role principal with no Grant —
# must also return 200 (human_probe_setup_step / human_probe). (f) Leftover 98: the ungranted
# member excludes one readable gate on My Agent (`set_agent_profile`, the capability the console
# uses) — My Agent must offer it as `granted:false`, its observe call must then be refused
# `excluded_by_profile`, its tools must drop out of the projection and readiness must say
# `unreachable/excluded_by_profile`; the exclusion is then restored (exclusion_probe_step).
#
# Usage:
#   sh scripts/accept_s4.sh [--keep] [--connector <name>]
#   ssh <TARGET_HOST> 'cd <CODE_DIR> && sh scripts/accept_s4.sh' </dev/null
#
# --keep: accepted for CLI parity with accept_s1.sh/accept_s2.sh/accept_s3.sh's own `--keep`, but
# this script never starts a resident entry container (no chat Turn is ever run — S4 talks to the
# kernel's capability surface directly, never the entry agent's own chat/runtime), so there is
# nothing of that kind to leave running either way. The ephemeral workspace itself is retained
# regardless of --keep, same convention as S1–S3 (see cleanup_step below).
#
# --connector <name>: only exercise the platform gate instance(s) whose `connector` field (the
# short technical name, e.g. "docker"/"ragflow" — not the human-readable display name) equals
# <name>; every other available instance is skipped silently (not counted as PASS/FAIL/SKIP).
#
# No fake-provider switch: S4 never runs a chat Turn and needs no LLM — every call here is a direct
# kernel capability call (docker/ragflow's own gate manifests only ever describe/observe/apply
# through their own gate protocol, not the entry agent's chat runtime), so, unlike accept_s1.sh/
# accept_s2.sh/accept_s3.sh, this script never touches deploy/accept/docker-compose.fake.yml and
# needs no fake-llm/worker-supervisor/agent-host services running.
#
# Toolset: identical rationale to accept_s1.sh/accept_s2.sh/accept_s3.sh's own header comments —
# every kernel capability call runs through the shared driver, deploy/accept/driver.mjs, bind-
# mounted read-only into a throwaway kernel-image container by the shared `run_driver` helper in
# scripts/lib/ (see that file's own header comment for the exact `docker compose run` invocation —
# no temp file), talking to the real running kernel over the `control` network
# (`http://kernel:8080/api/cap/...`). No `jq` dependency — every JSON field this script needs from a
# *single* result is extracted with a real `JS.parse()`/JS expression evaluated inside the same
# driver.mjs invocation that made the call (see driver.mjs's own header comment for the `cap`
# subcommand's contract); a *list* result (`list_available_gate_instances`/`find_operations`/
# `execution_readiness`'s own `gates[]`/`list_operations`) is instead flattened by the same JS
# expression into one delimited string — records separated by U+001E (RS), fields within a record
# by U+001F (US), both non-printing and never emitted by any real gate/connector/Operation name in
# practice — which this POSIX shell then splits without a JSON parser (`field()`/the `set -f; IFS=
# <RS>; set -- $records` idiom below; the same delimiter trick a POSIX shell needs whenever it must
# walk a variable-length list without jq).
#
# No driver change was needed: `cap <token> <capability> <paramsJson> [extractExpr]` already
# supports every capability this script calls (a Handle-channel capability such as
# `find_operations`/`observe_operation` is called the same way — the kernel's Bearer-token
# resolution tries an API key first, then a Handle JWT, and dispatches to the matching channel;
# `application/gateway/resolve-caller.ts`'s own doc comment: "One Bearer token, tried as an API key
# first"), so `deploy/accept/driver.mjs` and its unit test
# (`packages/kernel/src/interfaces/accept-driver.test.ts`) are unchanged by this script.
#
# Confidentiality (repo is public): the owner's API key and the minted interactive Handle are held
# only in shell variables for this process's lifetime and only ever printed via redact().

set -u

KEEP=0
CONNECTOR_FILTER=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --connector)
      [ "$#" -ge 2 ] || { echo "accept_s4: --connector needs <name>" >&2; exit 1; }
      CONNECTOR_FILTER=$2
      shift
      ;;
    *)
      echo "accept_s4: unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ ! -f "./docker-compose.yml" ]; then
  echo "accept_s4: run this from the checkout root (where docker-compose.yml lives)" >&2
  exit 1
fi
if [ ! -f "./.env" ]; then
  echo "accept_s4: ./.env not found next to docker-compose.yml — see .env.example" >&2
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${NEXTTIME_DATA:-}" ]; then
  echo "accept_s4: .env must set NEXTTIME_DATA" >&2
  exit 1
fi

. "$(dirname "$0")/lib/accept-common.sh"
require_driver

trap 'echo "accept_s4: interrupted" >&2; exit 130' INT TERM HUP PIPE

# --------------------------------------------------------------------------------------------
# Delimiter helpers — see the header comment's "Toolset" paragraph. RS/US are real control bytes
# (never printable, never emitted by a real gate/connector/Operation name) minted once via printf;
# every JS extraction expression below strips any stray U+0000–U+001F byte out of each field's own
# content before joining, so the two real separators these expressions insert are always the only
# such bytes in the resulting string.
# --------------------------------------------------------------------------------------------
RS=$(printf '\036')
US=$(printf '\037')

# field <record> <n> — the nth (1-based) US-delimited field of one record.
field() {
  printf '%s' "$1" | cut -d "$US" -f "$2"
}

# json_escape <string> — minimal JSON string escaping (backslash, double quote) for interpolating a
# platform-controlled value (a connector's display name, an Operation name) into a hand-built
# params JSON literal — the same "no jq, build JSON by hand" convention every accept_s*.sh script
# already uses for its own capability params.
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# warn_fail <step> <detail> — like accept-common.sh's own fail(), but does not exit: one gate's
# setup failure must not stop this script from testing every other connected system.
warn_fail() {
  printf 'FAIL %s %s\n' "$1" "$2" >&2
}

# diag_of <full driver output blob> — BODY= when the call reached the kernel and got an HTTP
# response (the common case), or the tail of the raw driver output otherwise (e.g. the kernel was
# unreachable and the driver's own `ERROR=` path fired instead of ever printing HTTP_STATUS=/BODY=)
# — so a total transport failure is still diagnosable instead of silently printing an empty detail.
diag_of() {
  body=$(parse_kv "$1" BODY)
  if [ -n "$body" ]; then
    printf '%s' "$body" | cut -c1-200
  else
    printf '%s' "$1" | tail -3
  fi
}

# print_verdict <gate> <connector> <readinessStatus> <readinessReason> <op> <call> <verdict> — the
# one required-format line per gate (dispatch's own literal spec).
print_verdict() {
  printf 'S4 gate=%s connector=%s readiness=%s/%s op=%s call=%s verdict=%s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7"
}

GATE_PASS=0
GATE_FAIL=0
GATE_SKIP=0
MEMBER_PASS=0
MEMBER_FAIL=0
HUMAN_PASS=0
HUMAN_FAIL=0
EXCL_PASS=0
EXCL_FAIL=0
# gatekeeperId<US>op<US>display<US>connector for every gate the ungranted member read with 200 —
# the exclusion probe picks its gate from here.
MEMBER_OK_RECORDS=""
ENABLED_RECORDS=""

# --------------------------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------------------------

preflight_step() {
  required_services="postgres kernel"
  running=$(docker compose ps --status running --services 2>/dev/null)
  if [ -z "$running" ]; then
    fail "preflight-services" "docker compose ps returned nothing — is the stack up? (docker compose up -d postgres kernel)"
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
}

bootstrap_step() {
  ts=$(date +%s)
  ws_name="accept-s4-$ts"

  # No --entry-model: S4 never runs a chat Turn, so the entry WorkerDefinition's own `model` field
  # is never read.
  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js create-workspace --name "$ws_name" --owner owner --purpose ephemeral --ttl 7d </dev/null 2>&1)
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

# `list_available_gate_instances` — channel:'human', minRole:'member' (the owner's own API key
# satisfies both) — every platform gate instance whose connector is in platform-preset mode and is
# enabled by a platform administrator (or already linked to this workspace); paramsSchema is empty
# (`{}`). application/gateway/gate-instance-handlers.ts's own module doc comment; wire shape
# `AvailableGateInstanceWireSchema` (packages/shared/src/wire/platform.ts): {gateId, connector,
# displayName, transportKind, target, status, trust, health, operationCount, gatekeeperId}.
list_gate_instances_step() {
  out=$(cap "$OWNER_KEY" list_available_gate_instances '{}' \
    "d.result.items.map(i=>[i.gateId,i.connector,i.displayName,i.status,i.gatekeeperId||''].map(x=>String(x).replace(/[\u0000-\u001f]/g,' ')).join('\u001f')).join('\u001e')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "list-gate-instances" "list_available_gate_instances HTTP $status: $(parse_kv "$out" BODY)"
  INSTANCE_RECORDS=$(parse_kv "$out" EXTRACTED)
  if [ -z "$INSTANCE_RECORDS" ]; then
    pass "list-gate-instances" "no platform gate instances available to this workspace"
  else
    n=$(printf '%s' "$INSTANCE_RECORDS" | tr "$RS" '\n' | grep -c '.')
    pass "list-gate-instances" "$n platform gate instance(s) available (per-gate detail below)"
  fi
}

# Per-instance setup: enable_gate_instance (idempotent per (workspace, gate) — this is a fresh
# ephemeral workspace so it always takes the fresh-registration path), make sure its Operations are
# published (enable_gate_instance already publishes every newly-imported Operation itself —
# gate-instance-handlers.ts's own `enableGateInstanceHandler`: `for (const record of
# imported.imported) await publishOperation(...)` — this is a defensive re-check, not expected to
# ever find work on a fresh workspace), then grant the workspace owner a 'gatekeeper' Grant for it.
#
# The owner's grant keeps this half of the run shaped like a granted member's own entry agent (the
# gate lands in the entry Handle's execute scope, `inEntryScope`). Since design doc §11 "门上的观察"
# (decision D4 revoked 2026-09-27, "只读调用不需要授权") observation itself needs no Grant: the
# reachability read model (application/gateway/capability-reachability.ts) and every observe
# enforcement point call one predicate (`observeRefusal`, application/gates/observe-access.ts), so
# readiness is `direct` with or without it. The *ungranted* case is exercised separately by the
# member probe below (member_probe_setup_step / member_probe).
setup_one_gate() {
  i_gate_id=$1
  i_connector=$2
  i_display=$3

  out=$(cap "$OWNER_KEY" enable_gate_instance "{\"gateId\":\"$(json_escape "$i_gate_id")\"}" \
    "[d.result.gatekeeperId, d.result.linkedExisting, (d.result.publishedOperationNames||[]).length, (d.result.skippedOperationNames||[]).length].join('\u001f')")
  status=$(parse_kv "$out" HTTP_STATUS)
  if [ "$status" != "200" ]; then
    warn_fail "enable-gate-instance:$i_gate_id" "could not enable this platform gate instance in the workspace: HTTP $status $(diag_of "$out")"
    GATE_FAIL=$((GATE_FAIL + 1))
    print_verdict "$i_display" "$i_connector" "-" "-" "-" "-" "FAIL"
    return 1
  fi
  enable_rec=$(parse_kv "$out" EXTRACTED)
  gk_id=$(field "$enable_rec" 1)
  linked=$(field "$enable_rec" 2)
  published_n=$(field "$enable_rec" 3)
  skipped_n=$(field "$enable_rec" 4)
  [ -n "$gk_id" ] || { warn_fail "enable-gate-instance:$i_gate_id" "no gatekeeperId in response: $(diag_of "$out")"; GATE_FAIL=$((GATE_FAIL + 1)); print_verdict "$i_display" "$i_connector" "-" "-" "-" "-" "FAIL"; return 1; }
  pass "enable-gate-instance:$i_gate_id" "gatekeeperId=$gk_id linkedExisting=$linked publishedOperationNames.length=$published_n skippedOperationNames.length=$skipped_n"

  # Defensive re-check: make sure every Operation of this Gatekeeper is published (see the function
  # doc comment above — expected to be a no-op on a fresh workspace).
  ops_out=$(cap "$OWNER_KEY" list_operations "{\"gatekeeperId\":\"$gk_id\"}" \
    "d.result.items.map(o=>[o.name,o.status].map(x=>String(x).replace(/[\u0000-\u001f]/g,' ')).join('\u001f')).join('\u001e')")
  ops_status=$(parse_kv "$ops_out" HTTP_STATUS)
  if [ "$ops_status" = "200" ]; then
    ops_records=$(parse_kv "$ops_out" EXTRACTED)
    old_ifs=$IFS
    IFS=$RS
    set -f
    # shellcheck disable=SC2086
    set -- $ops_records
    set +f
    IFS=$old_ifs
    for op_rec in "$@"; do
      [ -n "$op_rec" ] || continue
      op_n=$(field "$op_rec" 1)
      op_status=$(field "$op_rec" 2)
      if [ "$op_status" != "published" ] && [ -n "$op_n" ]; then
        pub_out=$(cap "$OWNER_KEY" publish_operation "{\"gatekeeperId\":\"$gk_id\",\"name\":\"$(json_escape "$op_n")\"}" "")
        pub_status=$(parse_kv "$pub_out" HTTP_STATUS)
        if [ "$pub_status" = "200" ]; then
          pass "publish-operation:$gk_id:$op_n" "was $op_status, now published"
        else
          warn_fail "publish-operation:$gk_id:$op_n" "publish_operation HTTP $pub_status: $(diag_of "$pub_out") (was $op_status — leaving as-is, not blocking this gate)"
        fi
      fi
    done
  else
    warn_fail "list-operations:$gk_id" "list_operations HTTP $ops_status: $(diag_of "$ops_out") (best-effort publish check skipped, not blocking this gate)"
  fi

  grant_out=$(cap "$OWNER_KEY" grant_capability "{\"principalId\":\"$OWNER_ID\",\"resourceType\":\"gatekeeper\",\"resourceId\":\"$gk_id\"}" "d.result.id")
  grant_status=$(parse_kv "$grant_out" HTTP_STATUS)
  if [ "$grant_status" != "200" ]; then
    warn_fail "grant-gatekeeper:$gk_id" "could not grant the workspace owner a gatekeeper Grant — readiness/enforcement cannot be meaningfully compared without it: HTTP $grant_status $(diag_of "$grant_out")"
    GATE_FAIL=$((GATE_FAIL + 1))
    print_verdict "$i_display" "$i_connector" "-" "-" "-" "-" "FAIL"
    return 1
  fi
  pass "grant-gatekeeper:$gk_id" "granted owner=$OWNER_ID grant=$(parse_kv "$grant_out" EXTRACTED)"

  ENABLED_RECORDS="${ENABLED_RECORDS}${ENABLED_RECORDS:+$RS}$(printf '%s%s%s%s%s%s%s' "$i_gate_id" "$US" "$i_connector" "$US" "$i_display" "$US" "$gk_id")"
  return 0
}

setup_step() {
  old_ifs=$IFS
  IFS=$RS
  set -f
  # shellcheck disable=SC2086
  set -- $INSTANCE_RECORDS
  set +f
  IFS=$old_ifs
  for rec in "$@"; do
    [ -n "$rec" ] || continue
    i_gate_id=$(field "$rec" 1)
    i_connector=$(field "$rec" 2)
    i_display=$(field "$rec" 3)
    if [ -n "$CONNECTOR_FILTER" ] && [ "$i_connector" != "$CONNECTOR_FILTER" ]; then
      continue
    fi
    setup_one_gate "$i_gate_id" "$i_connector" "$i_display" || true
  done
}

# One interactive Handle (`issue_handle`, §5.1.4 mcp_session/"interactive"), minted once *after*
# every gate's grant above is in place — the Handle's own scope ceiling is computed at mint time
# from the caller's *current* Grants (governance/capability/issue-handle-handler.ts's
# `issueHandleHandler`: `listActiveGrantResourceScopes` -> `entryScope(...)`), so minting it earlier
# would silently miss gates granted afterward. This is the same "channel:'handle', par: undefined —
# a root Handle, not an attenuated child" shape `find_operations`' own reachability annotation
# requires (application/gateway/handlers.ts's `findOperationsHandler`: the annotation is added only
# when `ctx.claims.par === undefined`), and the same governed path a real member's own entry agent
# calls `observe_operation` through (`<gate>.<op>` tool projection -> `observe_operation`,
# governance/capability/handles.ts's `ENTRY_CEILING_EXTRA_CAPABILITY_NAMES`).
# ttlSeconds 900: the run needs minutes, and there is no capability to revoke an issued Handle early —
# a short lifetime is the bound (the default is 24h). The token itself only ever lives in a shell var.
issue_handle_step() {
  out=$(cap "$OWNER_KEY" issue_handle '{"sessionKind":"interactive","ttlSeconds":900}' "d.result.handle")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "issue-handle" "issue_handle HTTP $status: $(parse_kv "$out" BODY)"
  MCP_HANDLE=$(parse_kv "$out" EXTRACTED)
  [ -n "$MCP_HANDLE" ] || fail "issue-handle" "no handle in response: $(parse_kv "$out" BODY)"
  pass "issue-handle" "interactive Handle minted: $(redact "$MCP_HANDLE")"
}

# `execution_readiness` (channel:'human', no params -> the caller's own readiness): the console's
# own per-gate read model — `status` direct|via_worker|unreachable, `reason` when unreachable.
# application/gateway/execution-readiness-handler.ts / capability-reachability.ts. One call covers
# every Gatekeeper this workspace has registered.
readiness_step() {
  out=$(cap "$OWNER_KEY" execution_readiness '{}' \
    "d.result.gates.map(g=>[g.gateId,g.status,g.reason||''].map(x=>String(x).replace(/[\u0000-\u001f]/g,' ')).join('\u001f')).join('\u001e')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "execution-readiness" "execution_readiness HTTP $status: $(parse_kv "$out" BODY)"
  READINESS_RECORDS=$(parse_kv "$out" EXTRACTED)
  pass "execution-readiness" "read for owner=$OWNER_ID"
}

# --------------------------------------------------------------------------------------------
# Ungranted-member probe (design doc §11 "门上的观察"; decision D4 revoked 2026-09-27 — the
# maintainer's "只读调用不需要授权"): an observe-class Operation is callable by ANY Handle in the
# workspace, Grant or not. The owner run above always holds a Grant, so it cannot tell whether
# that rule actually reached the host. This probe uses a principal that is neither an owner nor
# granted anything: a `kind='service'`, `role='member'` Principal minted by the operator CLI's
# `issue-service-handle` (the only non-owner Handle a script can mint — `issue_handle` itself is
# `minRole:'owner'`; same CLI path accept_s3.sh already uses for its collector), scoped to exactly
# `observe_operation` + `list_allowed_operations`, no `resources` at all. ~15 minutes of TTL
# (`--ttl-days 0.0105`; the CLI floors to whole seconds) — same "a short lifetime is the bound"
# reasoning as issue_handle_step. For every gate the owner run exercised, it asserts:
#   - the kernel's readiness read model for this member says `direct` (`execution_readiness`,
#     read by the owner with `principalId`),
#   - the tool list this member's Handle is projected (`list_allowed_operations`) contains the
#     Operation, and
#   - one real governed `observe_operation` through this member's Handle returns 200 (audited like
#     any other call — dispatch.ts writes the row whatever the Grant state).
# A gate whose picked Operation is on the platform deny list must instead read `unreachable`, not
# be listed, and be refused `403 operation_disabled` — consistent refusal, still PASS.
# --------------------------------------------------------------------------------------------
member_probe_setup_step() {
  out=$(docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js issue-service-handle \
    --workspace "$WORKSPACE_ID" --name s4-ungranted-reader \
    --scope observe_operation,list_allowed_operations --ttl-days 0.0105 \
    </dev/null 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "member-probe-handle" "issue-service-handle exited $rc: $(printf '%s' "$out" | tail -10)"
  fi
  MEMBER_ID=$(printf '%s\n' "$out" | sed -n 's/^service principal: //p')
  MEMBER_HANDLE=$(printf '%s\n' "$out" | tail -n 1)
  if [ -z "$MEMBER_ID" ] || [ -z "$MEMBER_HANDLE" ]; then
    fail "member-probe-handle" "could not parse the principal / Handle from issue-service-handle output: $(printf '%s' "$out" | tail -10)"
  fi
  pass "member-probe-handle" "ungranted member-role principal=$MEMBER_ID (no gate Grant, not an owner) Handle=$(redact "$MEMBER_HANDLE")"

  out=$(cap "$OWNER_KEY" execution_readiness "{\"principalId\":\"$MEMBER_ID\"}" \
    "d.result.gates.map(g=>[g.gateId,g.status,g.reason||'',g.granted].map(x=>String(x).replace(/[\u0000-\u001f]/g,' ')).join('\u001f')).join('\u001e')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "member-probe-readiness" "execution_readiness(principalId=$MEMBER_ID) HTTP $status: $(parse_kv "$out" BODY)"
  MEMBER_READINESS_RECORDS=$(parse_kv "$out" EXTRACTED)
  granted_n=$(printf '%s' "$MEMBER_READINESS_RECORDS" | tr "$RS" '\n' | awk -F"$US" '$4=="true"' | wc -l | tr -d ' ')
  [ "$granted_n" = "0" ] || fail "member-probe-readiness" "the probe principal unexpectedly holds a gate Grant on $granted_n gate(s) — the probe would not test the ungranted case"
  pass "member-probe-readiness" "read for member=$MEMBER_ID (granted on 0 gates)"

  out=$(cap "$MEMBER_HANDLE" list_allowed_operations '{}' \
    "d.result.items.map(i=>[i.gatekeeperId,i.name,(i.operation&&i.operation.mode)||''].map(x=>String(x).replace(/[\u0000-\u001f]/g,' ')).join('\u001f')).join('\u001e')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "member-probe-tools" "list_allowed_operations HTTP $status: $(parse_kv "$out" BODY)"
  MEMBER_LISTED_RECORDS=$(parse_kv "$out" EXTRACTED)
  execute_n=$(printf '%s' "$MEMBER_LISTED_RECORDS" | tr "$RS" '\n' | awk -F"$US" '$3=="execute"' | wc -l | tr -d ' ')
  [ "$execute_n" = "0" ] || fail "member-probe-tools" "an ungranted Handle was projected $execute_n execute-class Operation(s) — execute projection must stay Grant-scoped"
  listed_n=$(printf '%s' "$MEMBER_LISTED_RECORDS" | tr "$RS" '\n' | grep -c '.')
  pass "member-probe-tools" "$listed_n observe-class Operation(s) projected, 0 execute-class"
}

# --------------------------------------------------------------------------------------------
# Human-channel probe (leftover 97, maintainer 2026-09-27 "也放开吧"): a person observing a gate
# from the console needs no Grant either. The kernel resolves an API key to the *human* channel
# (application/gateway/resolve-caller.ts: "Tries the human channel (API key) first") — the channel
# a console session uses; `observe_operation`'s human branch looks only at the caller's role. The
# owner mints that credential with `create_principal` (owner-only, returns the plaintext key once;
# the same capability automation credentials are made with — a `kind=service` Principal, since
# people join through `add_member`, which issues no key): role `member`, no gate Grant, not an
# owner. The key lives only in a shell variable and is printed only via redact().
# --------------------------------------------------------------------------------------------
human_probe_setup_step() {
  out=$(cap "$OWNER_KEY" create_principal '{"role":"member","displayName":"s4-human-reader"}' \
    "[d.result.principal.id, d.result.apiKey].join('\u001f')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "human-probe-key" "create_principal HTTP $status: $(parse_kv "$out" BODY)"
  rec=$(parse_kv "$out" EXTRACTED)
  HUMAN_ID=$(field "$rec" 1)
  HUMAN_KEY=$(field "$rec" 2)
  if [ -z "$HUMAN_ID" ] || [ -z "$HUMAN_KEY" ]; then
    fail "human-probe-key" "could not parse the principal / API key from create_principal"
  fi

  out=$(cap "$OWNER_KEY" execution_readiness "{\"principalId\":\"$HUMAN_ID\"}" \
    "d.result.gates.filter(g=>g.granted).length")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "human-probe-key" "execution_readiness(principalId=$HUMAN_ID) HTTP $status: $(parse_kv "$out" BODY)"
  granted_n=$(parse_kv "$out" EXTRACTED)
  [ "$granted_n" = "0" ] || fail "human-probe-key" "the human-channel probe principal unexpectedly holds a gate Grant on $granted_n gate(s) — the probe would not test the ungranted case"
  pass "human-probe-key" "member-role principal=$HUMAN_ID (no gate Grant, not an owner) API key=$(redact "$HUMAN_KEY")"
}

# human_probe <gateId> <connector> <display> <gatekeeperId> <op> — one verdict line per gate:
#   S4 human-probe gate=... connector=... op=... call=... verdict=PASS|FAIL
# PASS: 200 (read without a Grant), or 403 operation_disabled (the platform deny list applies on
# every channel). Anything else — notably 403 "holds no active gatekeeper grant" — is FAIL: the
# host's kernel still requires a Grant on the human channel.
human_probe() {
  h_gate_id=$1
  h_connector=$2
  h_display=$3
  h_gk_id=$4
  h_op=$5

  h_out=$(cap "$HUMAN_KEY" observe_operation "{\"gatekeeperId\":\"$h_gk_id\",\"operation\":\"$(json_escape "$h_op")\",\"params\":{}}" \
    "d.result&&d.result.status")
  h_status=$(parse_kv "$h_out" HTTP_STATUS)
  h_body=$(parse_kv "$h_out" BODY)
  [ -n "$h_status" ] || h_status="no-response"

  h_verdict=FAIL
  case "$h_status" in
    200) h_verdict=PASS ;;
    403)
      case "$h_body" in
        *operation_disabled*) h_verdict=PASS ;;
      esac
      ;;
  esac

  printf 'S4 human-probe gate=%s connector=%s op=%s call=%s verdict=%s\n' \
    "$h_display" "$h_connector" "$h_op" "$h_status" "$h_verdict"
  if [ "$h_verdict" = "PASS" ]; then
    HUMAN_PASS=$((HUMAN_PASS + 1))
    pass "human-probe:$h_gate_id" "ungranted member on the human channel observe_operation($h_op) -> $h_status"
  else
    HUMAN_FAIL=$((HUMAN_FAIL + 1))
    warn_fail "human-probe:$h_gate_id" "observe_operation($h_op) on the human channel -> HTTP $h_status $(diag_of "$h_out")"
  fi
}

# member_probe <gateId> <connector> <display> <gatekeeperId> <op> — one verdict line per gate:
#   S4 member-probe gate=... connector=... readiness=<status>/<reason> op=... call=... listed=yes|no verdict=PASS|FAIL
member_probe() {
  p_gate_id=$1
  p_connector=$2
  p_display=$3
  p_gk_id=$4
  p_op=$5

  p_rr=$(readiness_lookup "$p_gk_id" "$MEMBER_READINESS_RECORDS")
  p_r_status=${p_rr%%|*}
  p_r_reason=${p_rr#*|}
  if printf '%s' "$MEMBER_LISTED_RECORDS" | tr "$RS" '\n' | awk -F"$US" -v id="$p_gk_id" -v op="$p_op" '$1==id && $2==op{found=1} END{exit found?0:1}'; then
    p_listed=yes
  else
    p_listed=no
  fi

  p_out=$(cap "$MEMBER_HANDLE" observe_operation "{\"gatekeeperId\":\"$p_gk_id\",\"operation\":\"$(json_escape "$p_op")\",\"params\":{}}" \
    "JSON.stringify({status:d.result&&d.result.status, observedFactCount:d.result&&d.result.observedFactCount})")
  p_status=$(parse_kv "$p_out" HTTP_STATUS)
  p_body=$(parse_kv "$p_out" BODY)
  [ -n "$p_status" ] || p_status="no-response"

  p_verdict=FAIL
  p_detail="readiness=$p_r_status($p_r_reason) listed=$p_listed but observe_operation($p_op) -> HTTP $p_status $(diag_of "$p_out")"
  case "$p_status" in
    200)
      if [ "$p_r_status" = "direct" ] && [ "$p_listed" = "yes" ]; then p_verdict=PASS; fi
      ;;
    403)
      case "$p_body" in
        *operation_disabled*)
          if [ "$p_r_status" = "unreachable" ] && [ "$p_listed" = "no" ]; then p_verdict=PASS; fi
          ;;
      esac
      ;;
  esac

  printf 'S4 member-probe gate=%s connector=%s readiness=%s/%s op=%s call=%s listed=%s verdict=%s\n' \
    "$p_display" "$p_connector" "$p_r_status" "$p_r_reason" "$p_op" "$p_status" "$p_listed" "$p_verdict"
  if [ "$p_verdict" = "PASS" ]; then
    MEMBER_PASS=$((MEMBER_PASS + 1))
    pass "member-probe:$p_gate_id" "ungranted member observe_operation($p_op) -> $p_status, readiness=$p_r_status, listed=$p_listed"
    if [ "$p_status" = "200" ]; then
      MEMBER_OK_RECORDS="${MEMBER_OK_RECORDS}${MEMBER_OK_RECORDS:+$RS}$(printf '%s%s%s%s%s%s%s' "$p_gk_id" "$US" "$p_op" "$US" "$p_display" "$US" "$p_connector")"
    fi
  else
    MEMBER_FAIL=$((MEMBER_FAIL + 1))
    warn_fail "member-probe:$p_gate_id" "$p_detail"
  fi
}

# readiness_lookup <gatekeeperId> [records] — prints "<status>|<reason-or-dash>" for one gate, or
# "unknown|not_in_readiness_result" if execution_readiness's own gates[] has no matching row (should
# never happen for a gate this same script just enabled — surfaced rather than silently defaulted,
# in case a future readiness-side bug drops a gate from that list entirely). [records] defaults to
# the owner's READINESS_RECORDS; the member probe passes its own MEMBER_READINESS_RECORDS.
readiness_lookup() {
  records=${2-$READINESS_RECORDS}
  line=$(printf '%s' "$records" | tr "$RS" '\n' | awk -F"$US" -v id="$1" '$1==id{print;exit}')
  if [ -z "$line" ]; then
    printf 'unknown|not_in_readiness_result'
    return
  fi
  r_status=$(field "$line" 2)
  r_reason=$(field "$line" 3)
  [ -n "$r_reason" ] || r_reason="-"
  printf '%s|%s' "$r_status" "$r_reason"
}

# find_operations_for_gate <gatekeeperId> <need> — mints the OPERATION_RECORDS blob (via the
# interactive Handle) for the Operations matching <need>, then picks the first observe-class
# Operation belonging to <gatekeeperId> whose params_schema has no required fields — the field this
# script actually needs to call with an empty `{}` and expect the gate to accept, per
# `find_operations`'s underlying Object properties (the Operation's own manifest, verbatim —
# substrate/ontology/meta-objects.ts's `registerOperationDraftObject`:
# `properties = {...input.operation, status, origin, ...}` — `params_schema` is a required field of
# `OperationSchema`, packages/shared/src/action-description.ts). Prints the chosen Operation's name,
# or nothing if none qualifies.
pick_observe_operation() {
  gk_id=$1
  need=$2
  out=$(cap "$MCP_HANDLE" find_operations "{\"need\":\"$(json_escape "$need")\"}" \
    "d.result.items.map(i=>[(i.identityKey&&i.identityKey.gatekeeperId)||'',(i.identityKey&&i.identityKey.name)||'',(i.properties&&i.properties.mode)||'',(i.properties&&i.properties.params_schema&&Array.isArray(i.properties.params_schema.required)?i.properties.params_schema.required.length:0),(i.reachability?i.reachability.status:''),(i.reachability&&i.reachability.reason)||''].map(x=>String(x).replace(/[\u0000-\u001f]/g,' ')).join('\u001f')).join('\u001e')")
  status=$(parse_kv "$out" HTTP_STATUS)
  if [ "$status" != "200" ]; then
    printf '||find_operations HTTP %s: %s' "$status" "$(diag_of "$out")"
    return
  fi
  records=$(parse_kv "$out" EXTRACTED)
  matched=$(printf '%s' "$records" | tr "$RS" '\n' | awk -F"$US" -v id="$gk_id" '$1==id' | wc -l | tr -d ' ')
  op_line=$(printf '%s' "$records" | tr "$RS" '\n' | awk -F"$US" -v id="$gk_id" '$1==id && $3=="observe" && $4=="0"{print;exit}')
  if [ -z "$op_line" ]; then
    printf '|%s|no observe-class Operation with an empty required-params schema (find_operations(need=%s) returned %s Operation(s) for this gate)' "$matched" "$need" "$matched"
    return
  fi
  op_name=$(field "$op_line" 2)
  printf '%s||' "$op_name"
}

# For each enabled gate: readiness lookup, pick an Operation, one real observe_operation call
# through the interactive Handle, then the verdict line (dispatch's own decision table).
verify_step() {
  old_ifs=$IFS
  IFS=$RS
  set -f
  # shellcheck disable=SC2086
  set -- $ENABLED_RECORDS
  set +f
  IFS=$old_ifs
  for erec in "$@"; do
    [ -n "$erec" ] || continue
    e_gate_id=$(field "$erec" 1)
    e_connector=$(field "$erec" 2)
    e_display=$(field "$erec" 3)
    e_gk_id=$(field "$erec" 4)

    rr=$(readiness_lookup "$e_gk_id")
    r_status=${rr%%|*}
    r_reason=${rr#*|}

    pick=$(pick_observe_operation "$e_gk_id" "$e_display $e_connector")
    op_name=$(printf '%s' "$pick" | cut -d'|' -f1)
    skip_reason=$(printf '%s' "$pick" | cut -d'|' -f3-)

    if [ -z "$op_name" ]; then
      GATE_SKIP=$((GATE_SKIP + 1))
      print_verdict "$e_display" "$e_connector" "$r_status" "$r_reason" "-" "-" "SKIP"
      skip "verify:$e_gate_id" "$skip_reason"
      continue
    fi

    call_out=$(cap "$MCP_HANDLE" observe_operation "{\"gatekeeperId\":\"$e_gk_id\",\"operation\":\"$(json_escape "$op_name")\",\"params\":{}}" \
      "JSON.stringify({status:d.result&&d.result.status, observedFactCount:d.result&&d.result.observedFactCount})")
    call_status=$(parse_kv "$call_out" HTTP_STATUS)
    call_body=$(parse_kv "$call_out" BODY)

    err_code=$(printf '%s' "$call_body" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
    err_msg=$(printf '%s' "$call_body" | sed -n 's/.*"message":"\(.*\)".*/\1/p' | cut -c1-160)
    # A total transport failure (kernel unreachable before ever answering with an HTTP status) never
    # matches any of the case arms below by number — fall through to the catch-all with a non-empty
    # status placeholder and the driver's own raw output as the diagnostic, instead of printing a
    # blank call= field.
    if [ -z "$call_status" ]; then
      call_status="no-response"
      err_msg=$(diag_of "$call_out")
    fi

    case "$call_status" in
      200)
        if [ "$r_status" = "direct" ] || [ "$r_status" = "via_worker" ]; then
          GATE_PASS=$((GATE_PASS + 1))
          print_verdict "$e_display" "$e_connector" "$r_status" "$r_reason" "$op_name" "200" "PASS"
          pass "verify:$e_gate_id" "observe_operation($op_name) -> $(parse_kv "$call_out" EXTRACTED)"
        else
          GATE_FAIL=$((GATE_FAIL + 1))
          print_verdict "$e_display" "$e_connector" "$r_status" "$r_reason" "$op_name" "200" "FAIL"
          warn_fail "verify:$e_gate_id" "readiness/enforcement disagree: readiness=$r_status($r_reason) but observe_operation($op_name) succeeded"
        fi
        ;;
      403)
        case "$call_body" in
          *operation_disabled*)
            if [ "$r_status" = "unreachable" ]; then
              GATE_PASS=$((GATE_PASS + 1))
              print_verdict "$e_display" "$e_connector" "$r_status" "$r_reason" "$op_name" "403 $err_code operation_disabled" "PASS"
              echo "S4 NOTE gate=$e_display connector=$e_connector all operations disabled by platform connector deny list"
            else
              GATE_FAIL=$((GATE_FAIL + 1))
              print_verdict "$e_display" "$e_connector" "$r_status" "$r_reason" "$op_name" "403 $err_code operation_disabled" "FAIL"
              warn_fail "verify:$e_gate_id" "readiness/enforcement disagree: readiness=$r_status($r_reason) but observe_operation($op_name) was refused operation_disabled — $err_msg"
            fi
            ;;
          *)
            GATE_FAIL=$((GATE_FAIL + 1))
            print_verdict "$e_display" "$e_connector" "$r_status" "$r_reason" "$op_name" "403 $err_code" "FAIL"
            warn_fail "verify:$e_gate_id" "observe_operation($op_name) refused: $err_code $err_msg"
            ;;
        esac
        ;;
      502 | 503 | 504)
        GATE_FAIL=$((GATE_FAIL + 1))
        print_verdict "$e_display" "$e_connector" "$r_status" "$r_reason" "$op_name" "$call_status $err_code" "FAIL"
        warn_fail "verify:$e_gate_id" "gate unreachable: HTTP $call_status $err_code $err_msg"
        ;;
      *)
        GATE_FAIL=$((GATE_FAIL + 1))
        print_verdict "$e_display" "$e_connector" "$r_status" "$r_reason" "$op_name" "$call_status $err_code" "FAIL"
        warn_fail "verify:$e_gate_id" "observe_operation($op_name) failed: HTTP $call_status $err_code $err_msg"
        ;;
    esac

    # Same gate, same Operation, through the ungranted member's Handle (see member_probe_setup_step),
    # then on the human channel (see human_probe_setup_step).
    member_probe "$e_gate_id" "$e_connector" "$e_display" "$e_gk_id" "$op_name"
    human_probe "$e_gate_id" "$e_connector" "$e_display" "$e_gk_id" "$op_name"
  done
}

# --------------------------------------------------------------------------------------------
# Exclusion probe (leftover 98): My Agent lets a member exclude a system their agent may read
# without a Grant. Takes the first gate the ungranted member probe read with 200 and, as the owner
# (`get_agent_profile` / `set_agent_profile` with `principalId` — the capabilities the console's
# My Agent page calls; an owner may edit anyone's profile):
#   1. My Agent offers the gate as readable-but-ungranted: `availableGatekeepers` has it with
#      `granted:false` (the checklist's data source).
#   2. excludes it (`excludedGatekeepers:[gate]`) — the result's entry must turn `inUse:false`;
#   3. the member Handle's `observe_operation` on it is refused 403 `excluded_by_profile`;
#   4. `list_allowed_operations` no longer projects any of its Operations;
#   5. readiness for the member says `unreachable/excluded_by_profile`;
#   6. restores `excludedGatekeepers:[]` and checks the gate is projected again.
# One verdict line:
#   S4 exclusion-probe gate=... connector=... op=... offered=<granted:false|…> call=<status> listed=yes|no readiness=<s>/<r> restored=yes|no verdict=PASS|FAIL
# No gate read with 200 (nothing to exclude): SKIP, not FAIL.
# --------------------------------------------------------------------------------------------
exclusion_probe_step() {
  first=$(printf '%s' "$MEMBER_OK_RECORDS" | tr "$RS" '\n' | head -n 1)
  if [ -z "$first" ]; then
    skip "exclusion-probe" "no gate was read with 200 by the ungranted member — nothing to exclude"
    return 0
  fi
  x_gk_id=$(field "$first" 1)
  x_op=$(field "$first" 2)
  x_display=$(field "$first" 3)
  x_connector=$(field "$first" 4)
  entry_expr="(()=>{const g=((d.result&&d.result.availableGatekeepers)||[]).find(x=>x.gatekeeperId==='$x_gk_id');return g?'granted:'+g.granted+',inUse:'+g.inUse:'absent'})()"

  out=$(cap "$OWNER_KEY" get_agent_profile "{\"principalId\":\"$MEMBER_ID\"}" "$entry_expr")
  x_offered=$(parse_kv "$out" EXTRACTED)
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || x_offered="get_agent_profile-HTTP-$(parse_kv "$out" HTTP_STATUS)"

  out=$(cap "$OWNER_KEY" set_agent_profile "{\"principalId\":\"$MEMBER_ID\",\"excludedGatekeepers\":[\"$x_gk_id\"]}" "$entry_expr")
  x_set_status=$(parse_kv "$out" HTTP_STATUS)
  x_after_set=$(parse_kv "$out" EXTRACTED)

  out=$(cap "$MEMBER_HANDLE" observe_operation "{\"gatekeeperId\":\"$x_gk_id\",\"operation\":\"$(json_escape "$x_op")\",\"params\":{}}" "")
  x_call=$(parse_kv "$out" HTTP_STATUS)
  x_body=$(parse_kv "$out" BODY)
  [ -n "$x_call" ] || x_call="no-response"
  x_refused=no
  if [ "$x_call" = "403" ]; then
    case "$x_body" in
      *excluded_by_profile*) x_refused=yes ;;
    esac
  fi

  out=$(cap "$MEMBER_HANDLE" list_allowed_operations '{}' \
    "d.result.items.filter(i=>i.gatekeeperId==='$x_gk_id').length")
  x_listed_n=$(parse_kv "$out" EXTRACTED)
  if [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] && [ "$x_listed_n" = "0" ]; then x_listed=no; else x_listed=yes; fi

  out=$(cap "$OWNER_KEY" execution_readiness "{\"principalId\":\"$MEMBER_ID\"}" \
    "d.result.gates.map(g=>[g.gateId,g.status,g.reason||'',g.granted].map(x=>String(x).replace(/[\u0000-\u001f]/g,' ')).join('\u001f')).join('\u001e')")
  x_rr=$(readiness_lookup "$x_gk_id" "$(parse_kv "$out" EXTRACTED)")
  x_r_status=${x_rr%%|*}
  x_r_reason=${x_rr#*|}

  out=$(cap "$OWNER_KEY" set_agent_profile "{\"principalId\":\"$MEMBER_ID\",\"excludedGatekeepers\":[]}" "$entry_expr")
  x_restore_status=$(parse_kv "$out" HTTP_STATUS)
  out=$(cap "$MEMBER_HANDLE" list_allowed_operations '{}' \
    "d.result.items.filter(i=>i.gatekeeperId==='$x_gk_id').length")
  x_relisted_n=$(parse_kv "$out" EXTRACTED)
  if [ "$x_restore_status" = "200" ] && [ -n "$x_relisted_n" ] && [ "$x_relisted_n" != "0" ]; then x_restored=yes; else x_restored=no; fi

  x_verdict=FAIL
  if [ "$x_offered" = "granted:false,inUse:true" ] && [ "$x_set_status" = "200" ] \
    && [ "$x_after_set" = "granted:false,inUse:false" ] && [ "$x_refused" = "yes" ] \
    && [ "$x_listed" = "no" ] && [ "$x_r_status" = "unreachable" ] \
    && [ "$x_r_reason" = "excluded_by_profile" ] && [ "$x_restored" = "yes" ]; then
    x_verdict=PASS
  fi

  printf 'S4 exclusion-probe gate=%s connector=%s op=%s offered=%s call=%s listed=%s readiness=%s/%s restored=%s verdict=%s\n' \
    "$x_display" "$x_connector" "$x_op" "$x_offered" "$x_call" "$x_listed" "$x_r_status" "$x_r_reason" "$x_restored" "$x_verdict"
  if [ "$x_verdict" = "PASS" ]; then
    EXCL_PASS=$((EXCL_PASS + 1))
    pass "exclusion-probe:$x_gk_id" "excluded on My Agent -> observe 403 excluded_by_profile, not projected, readiness unreachable/excluded_by_profile; restored"
  else
    EXCL_FAIL=$((EXCL_FAIL + 1))
    warn_fail "exclusion-probe:$x_gk_id" "offered=$x_offered set=$x_set_status after_set=$x_after_set call=$x_call $(printf '%s' "$x_body" | cut -c1-160) listed=$x_listed readiness=$x_r_status($x_r_reason) restore=$x_restore_status relisted=$x_relisted_n"
  fi
}

cleanup_step() {
  if [ "$KEEP" -eq 1 ]; then
    echo "cleanup: --keep set (no-op — S4 never starts a resident entry container to leave running)"
  fi
  # Workspace/principal/Gatekeeper/Grant/audit rows are the audit trail (design doc §12) — left in
  # place on purpose, same convention accept_s1.sh/accept_s2.sh/accept_s3.sh already establish for
  # their own workspaces. Ephemeral, 7-day TTL: purged once expired by
  # `sh scripts/delete-workspaces-matching.sh --expired --yes`.
  pass "cleanup" "workspace retained: $WORKSPACE_ID (purged by: sh scripts/delete-workspaces-matching.sh --expired --yes once its 7-day TTL passes)"
}

# --------------------------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------------------------

preflight_step
bootstrap_step
list_gate_instances_step

if [ -z "$INSTANCE_RECORDS" ]; then
  cleanup_step
  echo "S4 OK (0 gates pass, 0 skipped)"
  exit 0
fi

setup_step

if [ -z "$ENABLED_RECORDS" ]; then
  cleanup_step
  if [ "$GATE_FAIL" -gt 0 ]; then
    echo "S4 FAIL ($GATE_PASS pass, $GATE_SKIP skip, $GATE_FAIL fail)"
    exit 1
  fi
  echo "S4 OK ($GATE_PASS gates pass, $GATE_SKIP skipped)"
  exit 0
fi

issue_handle_step
readiness_step
member_probe_setup_step
human_probe_setup_step
verify_step
exclusion_probe_step
cleanup_step

if [ "$GATE_FAIL" -gt 0 ] || [ "$MEMBER_FAIL" -gt 0 ] || [ "$HUMAN_FAIL" -gt 0 ] || [ "$EXCL_FAIL" -gt 0 ]; then
  echo "S4 FAIL ($GATE_PASS pass, $GATE_SKIP skip, $GATE_FAIL fail; ungranted-member probe $MEMBER_PASS pass, $MEMBER_FAIL fail; human-channel probe $HUMAN_PASS pass, $HUMAN_FAIL fail; exclusion probe $EXCL_PASS pass, $EXCL_FAIL fail)"
  exit 1
fi
echo "S4 OK ($GATE_PASS gates pass, $GATE_SKIP skipped; ungranted-member probe $MEMBER_PASS pass; human-channel probe $HUMAN_PASS pass; exclusion probe $EXCL_PASS pass)"
exit 0
