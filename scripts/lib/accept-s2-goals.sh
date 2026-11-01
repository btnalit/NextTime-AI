# scripts/lib/accept-s2-goals.sh — S11 GO7a: goal scenarios S1, S2 and S4 to S12 of
# docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §7.2, S13 — the goal planner of
# GO9a/GO9b (legacy 549) — and S14 — files between a goal's steps (GO14) — run by scripts/accept_s2.sh in
# its fake-provider path after step 9 (which covers proposing from chat, confirming, the platform's
# acceptance and S3's idempotent propose/confirm). Sourced by accept_s2.sh right after
# accept-common.sh; POSIX sh, same conventions (pass/fail, cap, parse_kv, no temp file, no jq).
#
# Everything here runs on what accept_s2.sh already set up: alice (owner) and bob (member, holding
# no gate until S9 grants some) with their API keys, the ops-runner Worker (fake model), the http
# gate in front of the accept-s2 OpenAPI fixture. The fixture's test ledger (`ledger.get` observe /
# `ledger.add` execute with `await_decision`, see deploy/accept-s2/openapi-fixture/server.mjs)
# counts at the gate's side how often a write really ran, so the scenarios read the effect itself
# rather than the platform's own record of it; under a `lose-` key it adds the entry and drops the
# answer (S4). No credential is involved beyond the fixture token accept_s2.sh already generates.
#
# S2, S8 and S12 need a Worker kept alive at a moment the script picks: a step's input may carry
# `HOLD=<name>`, and fake-llm then keeps that Worker's model turn back until the script releases
# the name (fake_llm_release; fake-llm answers by itself after 120 s). S12 and S2 also lock one row
# of their own goal the way an advance does (goal_row_lock_take: goal_runs or step_runs, a row
# lock only, bounded in time, ended by the scenario and again by cleanup_step), and S2 kills the
# kernel (SIGKILL) twice and restarts worker-supervisor.
#
# S12 and S2 interrupt service — every connection to the kernel drops twice, every Task container
# loses its supervisor for a moment, a goal's row stays locked for up to 90 s (S12) or 180 s (S2)
# — so they run only with ACCEPT_DISRUPTIVE=1 in the environment. Without it they are not run and one
# `NOTE goal-disruptive …` line says so (a NOTE, not a SKIP: the run still ends in "S2 OK").
# scripts/staging-rehearsal.sh sets it, on its throwaway runner; on the production host it stays
# off, and the maintainer sets it in the window only once victor has agreed on the spot
# (docs/runbooks/host-accept-s2.md).
#
# Each scenario's polls are bounded and each failure carries the goal's own evidence (status,
# pause reason, every step with its attempts and actions, every acceptance check with its attempts
# and last error, every action with the reason its failure was audited with) in the FAIL line.
# Every goal proposed here is recorded in GOALS_STARTED, and cleanup_step ends whichever is still
# live (proposed: rejected; running, paused or verifying: cancelled — alice is the owner, so bob's
# too) before the gates go, the same way it ends step 9's, and revokes any gate S9 granted bob and
# did not get to revoke itself. Before any of that — with --keep too — it starts again a service S2
# left down, ends every row lock still held and releases every held turn (goal_cleanup_live_work).
#
# Order (`goal_scenarios_step`): S6's goal and the reverse half of S4 start first and wait in the
# background on checks that fail on purpose — the platform retries an unmet acceptance check
# (GOAL_ACCEPTANCE_CHECK_MAX_ATTEMPTS / _MAX_DURATION_MS) and an unmet reconcile check
# (GOAL_RECONCILE_CHECK_MAX_ATTEMPTS / _MAX_DURATION_MS) with backoff, by default 5 attempts within
# about 7.5 minutes, before it pauses the run — while S1, S11, S13, S14, S5, S4, S7, S9, S10, S12 and S8 run
# one after the other (S12 only with ACCEPT_DISRUPTIVE=1); S6 and the reverse S4 are finished
# next, and S2 (also only with ACCEPT_DISRUPTIVE=1) runs last, alone: the
# kernel's restarts would drop a background goal's checks and every connection to the kernel. No
# two scenarios have a step's Worker running at the same time, and no two have a write at the http
# gate at the same time (S7 reads the gate's queue); only S6's goal planner, once its check gives
# up, may run beside another scenario's step — it observes nothing and has no gate.
#
# With --real none of these scenarios runs, and the ledger is discarded before the http gate's
# manifest is published (goal_ledger_discard_real / goal_ledger_withheld_check_real, called from
# connections_step), so a real model's tool list holds stock.get alone, as before this file.
#
# Not covered here, and why (docs/runbooks/host-accept-s2.md, goal scenarios):
#   - S5 with `await_decision: false`, and S11's expired approval: neither can be set up on a live
#     stack without changing the kernel's own configuration; advancer.integration.test.ts covers
#     both against real Postgres.
#   - S7's Task still running at the cancel and its second variant (an `executing` action holding
#     the run in `cancelling` past the deadline, `cleanup_pending`): see goal_s7_cancel_drain;
#     advancer.integration.test.ts covers both.
#   - S8's nested child Tasks and a request already executing when the revision comes: the fake
#     Worker raises no child Task and the gate runs a write at once; advancer.integration.test.ts
#     covers both.
#   - S12 "until dead letter": a wake that fails is dropped, never retried or dead-lettered (see
#     goal_s12_lost_wake); what S12 shows is the reconcile scan bringing the run back.

GOALS_STARTED=""

# 1 runs S12 and S2 (header); anything else leaves them out with a NOTE line.
ACCEPT_DISRUPTIVE="${ACCEPT_DISRUPTIVE:-0}"

GOAL_BUDGET='{"maxTokens":200000,"maxSteps":6,"maxRevisions":1,"maxWallClockSeconds":1800}'

# What a failed scenario prints about its goal: one JSON line, read with get_goal.
GOAL_EVIDENCE_EXPR="JSON.stringify({status: d.result.status, pauseReason: d.result.pauseReason, outcome: d.result.outcome, outcomeBasis: d.result.outcomeBasis, steps: d.result.steps.map((s) => ({key: s.stepKey, status: s.status, waiting: s.waitingReason, failure: s.failureCategory, attempts: s.attempts.map((a) => a.status + ':' + (a.failureReason || '')), actions: s.actions.map((x) => x.status + (x.failureKind ? ':' + x.failureKind : ''))})), checks: d.result.acceptance.rounds.flatMap((r) => r.checks.map((c) => [r.round, c.checkKey, c.status, c.attempts, c.lastError])), stepChecks: d.result.acceptance.steps.flatMap((s) => s.rounds.flatMap((r) => r.checks.map((c) => [s.stepKey, r.round, c.checkKey, c.status, c.attempts, c.lastError])))})"

# goal_get <goalRunId> <expr>: get_goal as alice, <expr> evaluated against the parsed body (`d`).
goal_get() {
  parse_kv "$(cap "$ALICE_KEY" get_goal "{\"goalRunId\":\"$1\"}" "$2")" EXTRACTED
}

# goal_fail <name> <goalRunId> <detail>: fail with the goal's evidence attached — get_goal's summary,
# then each of its actions with the reason the platform audited when it failed (get_goal names a
# failed action's kind, not its reason).
goal_fail() {
  fail "$1" "$3 — evidence: $(goal_get "$2" "$GOAL_EVIDENCE_EXPR") actions: $(goal_action_reasons "$2")"
}

# goal_action_reasons <goalRunId>: `status[:failure kind] (reason)` for each ActionRequest of the
# goal's steps, oldest first — the reason from the last audit row that recorded one
# (governance/approval/execution.ts reasonAuditFields, already scrubbed of secret literals).
goal_action_reasons() {
  psql_ws "select coalesce(string_agg(ar.status || coalesce(':' || ar.failure_kind, '') || coalesce(' (' || left(a.payload->>'reason', 240) || ')', ''), '; ' order by ar.requested_at, ar.id), 'none') from action_requests ar join step_runs sr on sr.workspace_id = ar.workspace_id and sr.id = ar.step_run_id left join lateral (select r.payload from audit_records r where r.workspace_id = ar.workspace_id and r.resource_type = 'action_request' and r.resource_id = ar.id and r.payload ? 'reason' order by r.created_at desc limit 1) a on true where ar.workspace_id = '$WORKSPACE_ID' and sr.goal_run_id = '$1'"
}

# goal_wait <goalRunId> <seconds> <expr> <pattern>...: polls get_goal until the value of <expr>
# matches one of the case patterns, for at most <seconds>. The last value read is left in
# GOAL_WAIT_VALUE; returns 1 when the time ran out.
goal_wait() {
  gw_id=$1
  gw_deadline=$(($(date +%s) + $2))
  gw_expr=$3
  shift 3
  while :; do
    GOAL_WAIT_VALUE=$(goal_get "$gw_id" "$gw_expr")
    for gw_pattern in "$@"; do
      # shellcheck disable=SC2254 # the pattern is meant to glob
      case "$GOAL_WAIT_VALUE" in $gw_pattern) return 0 ;; esac
    done
    [ "$(date +%s)" -lt "$gw_deadline" ] || return 1
    sleep 3
  done
}

# How a goal stands: status, outcome, basis — what goal_wait waits on for a run to settle.
GOAL_END_EXPR="[d.result.status, d.result.outcome || '', d.result.outcomeBasis || '', d.result.pauseReason || ''].join(',')"

# goal_propose_confirm <name> <paramsJson> [apiKey] [confirm members]: proposes as alice — or as
# the holder of <apiKey> (empty: alice) — (a person's propose_goal, as the console makes it),
# records the run for cleanup, confirms revision 1 as the same person, with [confirm members]
# added to confirm_goal's params (S13: `"planner":"<mode>"`). Sets GOAL_RUN_ID.
goal_propose_confirm() {
  gpc_key=${3:-$ALICE_KEY}
  out=$(cap "$gpc_key" propose_goal "$2" "[d.result.goalRunId, d.result.status, d.result.changed].join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "$1-proposed" "propose_goal HTTP $status: $(parse_kv "$out" BODY)"
  proposed=$(parse_kv "$out" EXTRACTED)
  GOAL_RUN_ID=${proposed%%,*}
  [ "${proposed#*,}" = "proposed,true" ] || fail "$1-proposed" "propose_goal answered '$proposed', expected a new proposed run: $(parse_kv "$out" BODY)"
  GOALS_STARTED="$GOALS_STARTED $GOAL_RUN_ID"
  out=$(cap "$gpc_key" confirm_goal "{\"goalRunId\":\"$GOAL_RUN_ID\",\"revision\":1${4:+,$4}}" "[d.result.status, d.result.changed].join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "$1-confirmed" "confirm_goal HTTP $status: $(parse_kv "$out" BODY)"
  [ "$(parse_kv "$out" EXTRACTED)" = "running,true" ] || fail "$1-confirmed" "confirm_goal answered '$(parse_kv "$out" EXTRACTED)', expected running,true"
}

# goal_step_json <key> <input> [extra JSON members]: one plan step on the ops-runner Worker.
goal_step_json() {
  printf '{"key":"%s","worker":{"definitionId":"%s","version":%s},"input":"%s"%s}' \
    "$1" "$OPS_RUNNER_ID" "$OPS_RUNNER_VERSION" "$2" "${3:+,$3}"
}

# goal_observe_check_json <key> <operation> <paramsJson> <path> <value JSON>: an observe_predicate
# acceptance check on the http gate, `<path> eq <value>`.
goal_observe_check_json() {
  printf '{"kind":"observe_predicate","key":"%s","check":{"gatekeeperId":"%s","operation":"%s","params":%s,"expect":{"path":"%s","op":"eq","value":%s}}}' \
    "$1" "$GATEKEEPER_ID_HTTP" "$2" "$3" "$4" "$5"
}

# ledger_count <key>: how many writes the fixture's ledger holds under <key> — alice observing
# `ledger.get` through the http gate; the count is kept by the fixture itself.
ledger_count() {
  out=$(cap "$ALICE_KEY" observe_operation "{\"gatekeeperId\":\"$GATEKEEPER_ID_HTTP\",\"operation\":\"ledger.get\",\"params\":{\"key\":\"$1\"}}" "String((d.result.data || {}).count)")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || { echo "observe_operation(ledger.get) HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"; return 0; }
  parse_kv "$out" EXTRACTED
}

# goal_tasks <goalRunId>: the run's Task rows.
goal_tasks() {
  psql_ws "select count(*) from tasks where workspace_id='$WORKSPACE_ID' and goal_run_id='$1'"
}

# --- S6: every step reports success, the acceptance observation says otherwise ----------------
#
# Confirmed with the goal planner's leave `propose` (legacy 560): once the run pauses on its failed
# check, the platform asks its planner about the goal's own acceptance (S11 GO10b) — one proposal
# round anchored on the verification round that did not pass. fake-llm's planner has no scripted
# revision for it and says so (`no_revision`, naming the round it was told about), so the run stays
# paused for alice, who ends it as before. On alice's fake model, set before S6 starts
# (goal_planner_model in goal_scenarios_step), like S13's rounds.

# The newest planning round of the run: kind:status:point:step:acceptanceRound.
S6_ROUND_EXPR="(() => { const r = d.result.planningRounds; const x = r[r.length - 1]; return [d.result.status, d.result.pauseReason || '', r.length, x ? [x.kind, x.status, x.point, x.stepKey || '', x.acceptanceRound].join(':') : ''].join(','); })()"

# Proposes and confirms a goal whose one step reports done while its acceptance check expects a
# symbol the stock API never shows; waits for the step to finish and the run to verify. The run
# then retries its check in the background (goal_s6_finish picks it up).
goal_s6_start() {
  n=$(real_token)
  goal_propose_confirm s6 "{\"statement\":\"accept_s2 S6 $n: one ops-runner step reports done; the platform reads the test stock API and expects a symbol it never shows.\",\"plan\":{\"steps\":[$(goal_step_json report "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=report")],\"acceptance\":[$(goal_observe_check_json stock-unseen stock.get '{}' symbol '"S6-NEVER"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s6-$n\"}" "" '"planner":"propose"'
  S6_GOAL_ID=$GOAL_RUN_ID
  leave=$(goal_get "$S6_GOAL_ID" "String(d.result.planner)")
  [ "$leave" = "propose" ] || goal_fail "s6-confirmed" "$S6_GOAL_ID" "goal $S6_GOAL_ID reads planner '$leave', expected 'propose'"
  goal_wait "$S6_GOAL_ID" 180 "$GOAL_END_EXPR" 'verifying,*' 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s6-verifying" "$S6_GOAL_ID" "goal $S6_GOAL_ID did not reach verifying within 180s (last '$GOAL_WAIT_VALUE')"
  case "$GOAL_WAIT_VALUE" in
    verifying,*) : ;;
    *) goal_fail "s6-verifying" "$S6_GOAL_ID" "goal $S6_GOAL_ID reads '$GOAL_WAIT_VALUE', expected verifying once its step was done" ;;
  esac
  step=$(goal_get "$S6_GOAL_ID" "d.result.steps.map((s) => s.stepKey + ':' + s.status).join(',')")
  [ "$step" = "report:succeeded" ] || goal_fail "s6-verifying" "$S6_GOAL_ID" "goal $S6_GOAL_ID verifies with steps '$step', expected report:succeeded"
  pass "s6-verifying" "goal $S6_GOAL_ID: its step reported success, the platform is checking the stock API for a symbol it never shows"
}

# Waits for the run to pause on its failed check (S6: not declared achieved, the evidence on the
# check), then ends it as not achieved, the requester's own call.
goal_s6_finish() {
  # 960s: the default retry caps' 15-minute ceiling plus a margin; the run started minutes ago.
  goal_wait "$S6_GOAL_ID" 960 "$GOAL_END_EXPR" 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s6-not-achieved" "$S6_GOAL_ID" "goal $S6_GOAL_ID did not settle within 960s of retrying its check (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "paused,,,needs_decision" ] || goal_fail "s6-not-achieved" "$S6_GOAL_ID" "goal $S6_GOAL_ID reads '$GOAL_WAIT_VALUE', expected paused needs_decision with no outcome"
  check=$(goal_get "$S6_GOAL_ID" "(() => { const r = d.result.acceptance.rounds; const c = r.length ? r[r.length - 1].checks.find((x) => x.checkKey === 'stock-unseen') : undefined; return c ? [c.status, c.observationId ? 'observed' : 'unobserved', c.attempts].join(',') : 'none'; })()")
  case "$check" in
    failed,observed,*) : ;;
    *) goal_fail "s6-not-achieved" "$S6_GOAL_ID" "the check reads '$check', expected failed on an Observation" ;;
  esac
  [ "${check##*,}" -ge 2 ] 2>/dev/null || goal_fail "s6-not-achieved" "$S6_GOAL_ID" "the check settled after ${check##*,} attempt(s), expected it retried before failing"
  pass "s6-not-achieved" "goal $S6_GOAL_ID paused needs_decision, not completed: its check failed on an Observation after ${check##*,} attempts"

  # The pause opened one proposal round for the verification round that did not pass; it settles
  # once the planner's Task reports (alice's concurrency quota may have delayed its start).
  last=$(goal_get "$S6_GOAL_ID" "(() => { const r = d.result.acceptance.rounds; return String(r.length ? r[r.length - 1].round : 0); })()")
  goal_wait "$S6_GOAL_ID" 300 "$S6_ROUND_EXPR" '*:no_revision:*' '*:proposed:*' '*:failed:*' '*:abandoned:*' '*:applied:*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s6-planner-no-revision" "$S6_GOAL_ID" "no planning round settled within 300s of the pause (last '$GOAL_WAIT_VALUE'); rounds: $(goal_get "$S6_GOAL_ID" "$S13_ROUNDS_WHY_EXPR")"
  [ "$GOAL_WAIT_VALUE" = "paused,needs_decision,1,proposal:no_revision:goal_acceptance::$last" ] \
    || goal_fail "s6-planner-no-revision" "$S6_GOAL_ID" "goal $S6_GOAL_ID reads '$GOAL_WAIT_VALUE', expected paused needs_decision with one proposal round for acceptance round $last that proposed no revision (proposal:no_revision:goal_acceptance::$last); rounds: $(goal_get "$S6_GOAL_ID" "$S13_ROUNDS_WHY_EXPR")"
  # fake-llm's reason names the round from the planner's input: the planner was told what failed.
  detail=$(goal_get "$S6_GOAL_ID" "d.result.planningRounds[0].detail || ''")
  case "$detail" in
    *"acceptance round $last "*) : ;;
    *) goal_fail "s6-planner-no-revision" "$S6_GOAL_ID" "the round's detail reads '$detail', expected fake-llm's no_revision reason naming acceptance round $last (the planner's input carries failedAcceptance)" ;;
  esac
  tasks=$(goal_planner_tasks "$S6_GOAL_ID")
  [ "$tasks" = "planning:completed:0" ] || goal_fail "s6-planner-no-revision" "$S6_GOAL_ID" "the run's planning Tasks read '$tasks', expected one, completed, observing nothing (planning:completed:0)"
  revision=$(goal_get "$S6_GOAL_ID" "$S13_REVISION_EXPR")
  ended=$(goal_get "$S6_GOAL_ID" "$GOAL_END_EXPR")
  [ "$revision|$ended" = "none|paused,,,needs_decision" ] \
    || goal_fail "s6-planner-no-revision" "$S6_GOAL_ID" "after the round revision 2 reads '$revision' and the goal '$ended', expected no revision 2 and the run still paused needs_decision"
  pass "s6-planner-no-revision" "goal $S6_GOAL_ID: the pause opened one proposal round for acceptance round $last; the planner's Task (purpose planning, observing nothing) proposed no revision, and the run is still paused needs_decision for alice"

  out=$(cap "$ALICE_KEY" end_goal "{\"goalRunId\":\"$S6_GOAL_ID\",\"outcome\":\"not_achieved\",\"note\":\"accept_s2 S6: the check never held\"}" "[d.result.status, d.result.changed].join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || goal_fail "s6-ended-not-achieved" "$S6_GOAL_ID" "end_goal HTTP $status: $(parse_kv "$out" BODY)"
  ended=$(goal_get "$S6_GOAL_ID" "$GOAL_END_EXPR")
  case "$ended" in
    completed,not_achieved,*) : ;;
    *) goal_fail "s6-ended-not-achieved" "$S6_GOAL_ID" "after end_goal(not_achieved) the goal reads '$ended', expected completed,not_achieved" ;;
  esac
  pass "s6-ended-not-achieved" "alice ended goal $S6_GOAL_ID as not achieved: $ended"
}

# --- S1: a goal of three steps (a, b side by side, c after both); nobody writes again --------

goal_s1_dag() {
  n=$(real_token)
  # A new chat, as step 3 explains (fake-llm picks the scenario from the history).
  chat_out=$(run_driver send-and-wait "$ALICE_KEY" "" "发起三步验收目标 GOAL_NONCE=$n" 90000)
  s1_chat_id=$(parse_kv "$chat_out" CHAT_ID)
  [ -n "$s1_chat_id" ] || fail "s1-goal-proposed" "no CHAT_ID from send-and-wait: $chat_out"
  turn_status=$(parse_kv "$chat_out" TURN_STATUS)
  [ "$turn_status" = "completed" ] || fail "s1-goal-proposed" "the Turn $(parse_kv "$chat_out" TURN_ID) ended '${turn_status:-not settled within 90s}', not completed"
  reply=$(parse_kv "$(run_driver get-history "$ALICE_KEY" "$s1_chat_id" "(d.filter(m=>m.role==='assistant').pop()||{}).text||''")" EXTRACTED)
  S1_GOAL_ID=$(printf '%s' "$reply" | sed -n 's/.*GOAL_ID=\([0-9a-f-]*\).*/\1/p')
  [ -n "$S1_GOAL_ID" ] || fail "s1-goal-proposed" "no GOAL_ID in the entry agent's reply — a find_* step came back empty? (reply: '$reply')"
  GOALS_STARTED="$GOALS_STARTED $S1_GOAL_ID"
  case "$reply" in
    *"GOAL_STATUS=proposed"*) : ;;
    *) fail "s1-goal-proposed" "propose_goal did not answer a proposed run: '$reply'" ;;
  esac
  shape=$(goal_get "$S1_GOAL_ID" "d.result.planRevision.plan.steps.map((s) => s.key + '<' + (s.dependsOn || []).join('+')).join(',')")
  [ "$shape" = "a<,b<,c<a+b" ] || goal_fail "s1-goal-proposed" "$S1_GOAL_ID" "the proposed plan reads '$shape', expected a and b with no dependency, c after both"
  pass "s1-goal-proposed" "the entry agent proposed goal $S1_GOAL_ID in chat $s1_chat_id: a and b side by side, c after both"

  turns=$(psql_ws "select count(*) from activities where workspace_id='$WORKSPACE_ID' and chat_id='$s1_chat_id' and kind='agent_turn'")
  since=$(psql_ws "select now()")
  out=$(cap "$ALICE_KEY" confirm_goal "{\"goalRunId\":\"$S1_GOAL_ID\",\"revision\":1}" "[d.result.changed, d.result.createdStepRunIds.length].join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "s1-goal-confirmed" "confirm_goal HTTP $status: $(parse_kv "$out" BODY)"
  [ "$(parse_kv "$out" EXTRACTED)" = "true,3" ] || fail "s1-goal-confirmed" "confirm_goal answered '$(parse_kv "$out" EXTRACTED)', expected changed=true with three StepRuns"
  pass "s1-goal-confirmed" "alice confirmed goal $S1_GOAL_ID outside the chat; nobody writes in any chat from here on"

  goal_wait "$S1_GOAL_ID" 360 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s1-goal-achieved" "$S1_GOAL_ID" "goal $S1_GOAL_ID did not settle within 360s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "completed,achieved,verified_by_check," ] || goal_fail "s1-goal-achieved" "$S1_GOAL_ID" "goal $S1_GOAL_ID ended '$GOAL_WAIT_VALUE', expected completed,achieved,verified_by_check"
  steps=$(goal_get "$S1_GOAL_ID" "d.result.steps.map((s) => s.stepKey + ':' + s.status + ':' + s.attempts.length).sort().join(',')")
  [ "$steps" = "a:succeeded:1,b:succeeded:1,c:succeeded:1" ] || goal_fail "s1-goal-achieved" "$S1_GOAL_ID" "the steps read '$steps', expected all three succeeded on their first attempt"
  tasks=$(goal_tasks "$S1_GOAL_ID")
  [ "$tasks" = "3" ] || goal_fail "s1-goal-achieved" "$S1_GOAL_ID" "goal $S1_GOAL_ID has $tasks Task rows, expected one per step (3)"
  pass "s1-goal-achieved" "goal $S1_GOAL_ID completed(achieved, verified_by_check) on its own: three steps, one attempt and one Task each"

  order=$(goal_get "$S1_GOAL_ID" "(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); const start = (k) => Date.parse(s[k].attempts[0].createdAt); const end = (k) => Date.parse(s[k].endedAt); return [start('c') >= end('a') && start('c') >= end('b') ? 'c-after-both' : 'c-early', start('a') < end('b') && start('b') < end('a') ? 'a-b-overlapped' : 'a-b-in-turn'].join(','); })()")
  case "$order" in
    c-after-both,*) : ;;
    *) goal_fail "s1-goal-order" "$S1_GOAL_ID" "step c started before a and b had both ended ('$order')" ;;
  esac
  # Whether a and b overlapped depends on the requester's concurrency quota; reported, not judged.
  pass "s1-goal-order" "c started only after a and b had both ended ($order)"

  new_turns=$(psql_ws "select count(*) from activities where workspace_id='$WORKSPACE_ID' and kind='agent_turn' and created_at > '$since'")
  [ "$new_turns" = "0" ] || goal_fail "s1-no-new-turn" "$S1_GOAL_ID" "$new_turns Turn(s) started in the workspace between the confirmation and the goal's end, expected none"
  pass "s1-no-new-turn" "no Turn started anywhere in the workspace while goal $S1_GOAL_ID ran ($turns in its chat, the proposal's)"

  # Both kinds of line come through the outbox, which retries a row that failed later while the
  # rows after it go on (review #493 on #806): no order is promised, so both are compared as sorted
  # lists — each milestone and each step exactly once — and polled until complete or 60s are up.
  lines=""
  step_lines=""
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    lines=$(psql_ws "select coalesce(string_agg(content->>'change', ',' order by content->>'change'), '') from chat_messages where workspace_id='$WORKSPACE_ID' and chat_id='$s1_chat_id' and role='system' and content->>'kind'='system.goal_update' and content->>'goalRunId'='$S1_GOAL_ID'")
    step_lines=$(psql_ws "select coalesce(string_agg(content->>'stepKey', ',' order by content->>'stepKey'), '') from chat_messages where workspace_id='$WORKSPACE_ID' and chat_id='$s1_chat_id' and content->>'kind'='system.task_update' and content->>'goalRunId'='$S1_GOAL_ID' and content->>'status'='completed'")
    [ "$lines|$step_lines" = "complete,confirm,propose,verify|a,b,c" ] && break
    attempt=$((attempt + 1))
    sleep 1
  done
  [ "$lines" = "complete,confirm,propose,verify" ] || goal_fail "s1-goal-milestones" "$S1_GOAL_ID" "goal $S1_GOAL_ID's milestones in chat $s1_chat_id read '$lines' (sorted) after 60s, expected complete,confirm,propose,verify, each once"
  [ "$step_lines" = "a,b,c" ] || goal_fail "s1-goal-milestones" "$S1_GOAL_ID" "chat $s1_chat_id has completed-Task lines for steps '$step_lines' (sorted) after 60s, expected a,b,c, each once"
  pass "s1-goal-milestones" "chat $s1_chat_id shows the goal's milestones (proposed, confirmed, checking, completed) and a completed Task under each of a, b, c"
}

# --- S11: a step's write is rejected; the step and the goal need a person, nothing is retried --

goal_s11_reject() {
  n=$(real_token)
  key="s11-$n"
  # maxAttempts 2: the step has an attempt left, and still must not use it on its own.
  goal_propose_confirm s11 "{\"statement\":\"accept_s2 S11 $n: one ops-runner step asks to add an entry to the test ledger; the approver refuses it.\",\"plan\":{\"steps\":[$(goal_step_json write "ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=$key" '"maxAttempts":2')],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s11-$n\"}"
  S11_GOAL_ID=$GOAL_RUN_ID
  pass "s11-confirmed" "alice proposed and confirmed goal $S11_GOAL_ID (one step writing to the test ledger under $key)"

  write_expr="(() => { const s = d.result.steps.find((x) => x.stepKey === 'write'); return [d.result.status, s ? s.actions.map((a) => a.status).join('+') : ''].join(','); })()"
  goal_wait "$S11_GOAL_ID" 180 "$write_expr" '*pending_approval*' 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s11-pending" "$S11_GOAL_ID" "the step's write did not reach pending_approval within 180s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "running,pending_approval" ] || goal_fail "s11-pending" "$S11_GOAL_ID" "goal $S11_GOAL_ID reads '$GOAL_WAIT_VALUE', expected running with one write pending approval"
  ar_id=$(goal_get "$S11_GOAL_ID" "d.result.steps.find((x) => x.stepKey === 'write').actions[0].actionRequestId")
  out=$(cap "$ALICE_KEY" reject "{\"actionRequestId\":\"$ar_id\",\"reason\":\"accept_s2 S11: refused on purpose\"}" "d.result.status")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || goal_fail "s11-rejected" "$S11_GOAL_ID" "reject HTTP $status: $(parse_kv "$out" BODY)"
  [ "$(parse_kv "$out" EXTRACTED)" = "rejected" ] || goal_fail "s11-rejected" "$S11_GOAL_ID" "reject answered '$(parse_kv "$out" EXTRACTED)', expected rejected"
  pass "s11-rejected" "alice rejected the step's write $ar_id"

  goal_wait "$S11_GOAL_ID" 180 "$GOAL_END_EXPR" 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s11-needs-decision" "$S11_GOAL_ID" "goal $S11_GOAL_ID did not settle within 180s of the rejection (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "paused,,,needs_decision" ] || goal_fail "s11-needs-decision" "$S11_GOAL_ID" "goal $S11_GOAL_ID reads '$GOAL_WAIT_VALUE', expected paused needs_decision"
  step_expr="(() => { const s = d.result.steps.find((x) => x.stepKey === 'write'); return [s.status, s.failureCategory || '', s.attempts.length, s.actions.map((a) => a.status).join('+')].join(','); })()"
  step=$(goal_get "$S11_GOAL_ID" "$step_expr")
  [ "$step" = "failed,action_refused,1,rejected" ] || goal_fail "s11-needs-decision" "$S11_GOAL_ID" "the step reads '$step', expected failed,action_refused after one attempt with its one write rejected"
  pass "s11-needs-decision" "goal $S11_GOAL_ID paused needs_decision; the step failed action_refused"

  # Held for longer than a retry would take to start (the advancer would start one at once, the
  # write's own de-duplication answering it): nothing moves until a person decides.
  sleep 15
  again=$(goal_get "$S11_GOAL_ID" "$GOAL_END_EXPR")
  step=$(goal_get "$S11_GOAL_ID" "$step_expr")
  tasks=$(goal_tasks "$S11_GOAL_ID")
  count=$(ledger_count "$key")
  [ "$again|$step|$tasks|$count" = "paused,,,needs_decision|failed,action_refused,1,rejected|1|0" ] \
    || goal_fail "s11-no-retry" "$S11_GOAL_ID" "15s later: goal '$again', step '$step', $tasks Task(s), ledger count under $key '$count' — expected unchanged, one Task, nothing written"
  pass "s11-no-retry" "15s later still paused: one attempt, one Task, the write still rejected; the ledger holds nothing under $key (the gate never ran it)"

  out=$(cap "$ALICE_KEY" cancel_goal "{\"goalRunId\":\"$S11_GOAL_ID\"}" "d.result.status")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || goal_fail "s11-cancelled" "$S11_GOAL_ID" "cancel_goal HTTP $status: $(parse_kv "$out" BODY)"
  goal_wait "$S11_GOAL_ID" 60 "d.result.status" 'cancelled' \
    || goal_fail "s11-cancelled" "$S11_GOAL_ID" "goal $S11_GOAL_ID reads '$GOAL_WAIT_VALUE' 60s after cancel_goal, expected cancelled"
  pass "s11-cancelled" "alice cancelled goal $S11_GOAL_ID, the decision S11 leaves to a person"
}

# --- S13: a step's write is refused; the goal planner finds another way (S11 GO9a, GO9b) --------
#
# Legacy 549. A goal confirmed with the goal planner's leave has one step whose write to the test
# ledger alice refuses, as in S11. The platform then starts its goal planner — a Worker of its own
# that observes nothing and can only propose (ontology/goal-planner.yaml) — on the requester's
# fake model: fake-llm's `goalPlannerScenario` (deploy/fake-llm/server.mjs) moves the step onto
# `report-runner`, a Worker with no gate that can execute nothing, the goal's check as it was.
# By the platform's own rules that is a minor revision. Twice:
#   - S13a, leave `propose`: the run pauses needs_decision, a proposal round asks the planner, and
#     its revision 2 waits for alice; she accepts it and resumes in one call (decide_plan_revision
#     with resume), and the goal reaches done on the platform's own check.
#   - S13b, leave `apply_minor`: the run never pauses; an autonomous round asks the planner, the
#     platform adopts its revision for alice (acceptedBy platform), and the goal reaches done with
#     nobody acting after the refusal.
# Both check the planner's Task (purpose planning, observing nothing, on the goal, completed),
# the step's two Tasks (ops-runner's refused write, then report-runner's report) and that the
# ledger holds nothing under the step's key: the gate never ran the refused write.

REPORT_RUNNER_ID=""
REPORT_RUNNER_VERSION=""

# goal_s13_report_runner: proposes and publishes `report-runner` as alice, once — no `gates` (none)
# and no `capabilities` (the Worker ceiling without any execute-class capability), the same fake
# model as ops-runner. Its name is what fake-llm's planner looks for in the planner's `workers`;
# its description says nothing of restarting (step 2's `find_workers({need:"restart"})`).
goal_s13_report_runner() {
  [ -z "$REPORT_RUNNER_ID" ] || return 0
  rr_def="{\"name\":\"report-runner\",\"description\":\"Report-only Worker: reads its Task's input and reports what it found; it has no gate and acts on no system.\",\"skills\":[],\"egressDeny\":[],\"model\":\"${ACCEPT_S2_MODEL:-fake/fake-echo}\",\"systemPrompt\":\"You are a report-only Worker. Read your Task's input and report what it asks for with report_result. You have no gate and cannot act on any system.\"}"
  out=$(cap "$ALICE_KEY" propose_worker_definition "{\"kind\":\"worker\",\"definition\":$rr_def}" "[d.result.id, d.result.version].join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "s13-report-runner" "propose_worker_definition HTTP $status: $(parse_kv "$out" BODY)"
  pair=$(parse_kv "$out" EXTRACTED)
  REPORT_RUNNER_ID=${pair%%,*}
  REPORT_RUNNER_VERSION=${pair#*,}
  out=$(cap "$ALICE_KEY" publish_worker_definition "{\"definitionId\":\"$REPORT_RUNNER_ID\",\"version\":$REPORT_RUNNER_VERSION}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "s13-report-runner" "publish_worker_definition HTTP $status: $(parse_kv "$out" BODY)"
  pass "s13-report-runner" "report-runner@$REPORT_RUNNER_VERSION published ($REPORT_RUNNER_ID): no gate, nothing it can execute"
}

# goal_planner_model <model JSON>: sets alice's AgentProfile model (`null`: back to inheriting
# the workspace's). The planner names no model of its own (ontology/goal-planner.yaml, §7.7) and
# runs on its requester's; accept_s2 pins the entry definition's and each Worker's model, not
# alice's, so without this the planner would run on the stack's default provider — the real one on
# the host. Set once, before S6 starts, and reset once S6 and the reverse S4 are done
# (goal_scenarios_step): S6's round comes when its check gives up, minutes later, and S13's rounds
# run in between. The entry agent and every Worker here pin the same model, so nothing else
# changes while it is set.
# Sets GOAL_PLANNER_MODEL while alice's profile names a model, so a run left early still puts it
# back (goal_cleanup_planner_model, review #488 on #867).
GOAL_PLANNER_MODEL=""
goal_planner_model() {
  [ "$1" = "null" ] || GOAL_PLANNER_MODEL=$1
  out=$(cap "$ALICE_KEY" set_agent_profile "{\"model\":$1}" "String(d.result.model)")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "goals-planner-model" "set_agent_profile HTTP $status: $(parse_kv "$out" BODY)"
  [ "$1" != "null" ] || GOAL_PLANNER_MODEL=""
}

# goal_cleanup_planner_model: for cleanup_step, --keep or not — alice's AgentProfile back to the
# workspace's model when a run left it on the fake one (the provider restore takes that model
# away); prints one line, never fails.
goal_cleanup_planner_model() {
  [ -n "$GOAL_PLANNER_MODEL" ] || return 0
  gcp_out=$(cap "$ALICE_KEY" set_agent_profile '{"model":null}' "String(d.result.model)")
  echo "cleanup: alice's AgentProfile still named $GOAL_PLANNER_MODEL — set_agent_profile {\"model\":null} answered HTTP $(parse_kv "$gcp_out" HTTP_STATUS)"
  GOAL_PLANNER_MODEL=""
}

# goal_planner_tasks <goalRunId>: the run's planning Tasks, oldest first, as
# purpose:status:observe-scope size — `planning:completed:0` for one planner that ran and observed
# nothing.
goal_planner_tasks() {
  psql_ws "select coalesce(string_agg(purpose || ':' || status || ':' || coalesce(cardinality(observe_scope)::text, 'unscoped'), ',' order by created_at), 'none') from tasks where workspace_id='$WORKSPACE_ID' and goal_run_id='$1' and purpose = 'planning'"
}

# goal_s13_refused <name> <leave>: alice proposes the goal and confirms it with the planner's
# <leave>, then refuses the step's write once it waits for her. Sets S13_GOAL_ID, S13_KEY.
goal_s13_refused() {
  n=$(real_token)
  S13_KEY="$1-$n"
  goal_propose_confirm "$1" "{\"statement\":\"accept_s2 S13 $n ($2): one ops-runner step asks to add an entry to the test ledger; the approver refuses it and the goal planner finds another way.\",\"plan\":{\"steps\":[$(goal_step_json write "ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=$S13_KEY" '"maxAttempts":1')],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-$1-$n\"}" "" "\"planner\":\"$2\""
  S13_GOAL_ID=$GOAL_RUN_ID
  leave=$(goal_get "$S13_GOAL_ID" "String(d.result.planner)")
  [ "$leave" = "$2" ] || goal_fail "$1-confirmed" "$S13_GOAL_ID" "goal $S13_GOAL_ID reads planner '$leave', expected '$2'"
  pass "$1-confirmed" "alice confirmed goal $S13_GOAL_ID with the planner's leave '$2' (one step writing to the test ledger under $S13_KEY)"

  write_expr="(() => { const s = d.result.steps.find((x) => x.stepKey === 'write'); return [d.result.status, s ? s.actions.map((a) => a.status).join('+') : ''].join(','); })()"
  goal_wait "$S13_GOAL_ID" 180 "$write_expr" '*pending_approval*' 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "$1-pending" "$S13_GOAL_ID" "the step's write did not reach pending_approval within 180s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "running,pending_approval" ] || goal_fail "$1-pending" "$S13_GOAL_ID" "goal $S13_GOAL_ID reads '$GOAL_WAIT_VALUE', expected running with one write pending approval"
  ar_id=$(goal_get "$S13_GOAL_ID" "d.result.steps.find((x) => x.stepKey === 'write').actions[0].actionRequestId")
  out=$(cap "$ALICE_KEY" reject "{\"actionRequestId\":\"$ar_id\",\"reason\":\"accept_s2 S13: refused on purpose\"}" "d.result.status")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || goal_fail "$1-rejected" "$S13_GOAL_ID" "reject HTTP $status: $(parse_kv "$out" BODY)"
  [ "$(parse_kv "$out" EXTRACTED)" = "rejected" ] || goal_fail "$1-rejected" "$S13_GOAL_ID" "reject answered '$(parse_kv "$out" EXTRACTED)', expected rejected"
  pass "$1-rejected" "alice rejected the step's write $ar_id"
}

# The newest planning round of the run: kind:status:step:failure:revision:class.
S13_ROUND_EXPR="(() => { const r = d.result.planningRounds; const x = r[r.length - 1]; return [d.result.status, d.result.pauseReason || '', r.length, x ? [x.kind, x.status, x.stepKey, x.failureCategory, x.revision, x.revisionClass].join(':') : ''].join(','); })()"
# Every planning round of the run, with why it ended: kind:status:outcomeReason:detail — what a
# failure names, so a round that did not propose says why.
S13_ROUNDS_WHY_EXPR="d.result.planningRounds.map((x) => [x.kind, x.status, x.outcomeReason || '', (x.detail || '').slice(0, 300)].join(':')).join(' | ')"
# Revision 2 of the run: status:proposer:acceptedBy.
S13_REVISION_EXPR="(() => { const r = d.result.revisions.find((x) => x.revision === 2); return r ? [r.status, r.proposer, r.acceptedBy || ''].join(':') : 'none'; })()"

# goal_s13_settled <name>: what the run's Tasks, its pauses and the ledger show once it is done —
# the planner's Task, the step's two Tasks, no pause unless <name> is the propose half, nothing
# written under the step's key.
goal_s13_settled() {
  planner_tasks=$(goal_planner_tasks "$S13_GOAL_ID")
  [ "$planner_tasks" = "planning:completed:0" ] || goal_fail "$1-planner-task" "$S13_GOAL_ID" "the run's planning Tasks read '$planner_tasks', expected one, completed, observing nothing (planning:completed:0)"
  pass "$1-planner-task" "one planner Task on goal $S13_GOAL_ID: purpose planning, completed, observing nothing"

  step_tasks=$(psql_ws "select coalesce(string_agg(case worker_definition_id when '$OPS_RUNNER_ID' then 'ops-runner' when '$REPORT_RUNNER_ID' then 'report-runner' else 'other' end || ':' || status, ',' order by created_at), 'none') from tasks where workspace_id='$WORKSPACE_ID' and goal_run_id='$S13_GOAL_ID' and purpose is null")
  count=$(ledger_count "$S13_KEY")
  [ "$step_tasks|$count" = "ops-runner:completed,report-runner:completed|0" ] \
    || goal_fail "$1-other-way" "$S13_GOAL_ID" "the step's Tasks read '$step_tasks' and the ledger holds '$count' under $S13_KEY — expected ops-runner's refused write, then report-runner's report, and nothing written"
  pass "$1-other-way" "the step ran on ops-runner (its write refused), then on report-runner; the ledger holds nothing under $S13_KEY"
}

goal_s13_propose() {
  goal_s13_refused s13a propose
  goal_wait "$S13_GOAL_ID" 240 "$S13_ROUND_EXPR" '*:proposed:*' '*:no_revision:*' '*:failed:*' '*:abandoned:*' '*:applied:*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s13a-proposed" "$S13_GOAL_ID" "no planning round proposed within 240s of the refusal (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "paused,needs_decision,1,proposal:proposed:write:action_refused:2:minor" ] \
    || goal_fail "s13a-proposed" "$S13_GOAL_ID" "goal $S13_GOAL_ID reads '$GOAL_WAIT_VALUE', expected paused needs_decision with one proposal round that proposed a minor revision 2 for step write (proposal:proposed:write:action_refused:2:minor); rounds: $(goal_get "$S13_GOAL_ID" "$S13_ROUNDS_WHY_EXPR")"
  revision=$(goal_get "$S13_GOAL_ID" "$S13_REVISION_EXPR")
  [ "$revision" = "proposed:planner:" ] || goal_fail "s13a-proposed" "$S13_GOAL_ID" "revision 2 reads '$revision', expected proposed by the planner and not accepted (proposed:planner:)"
  pass "s13a-proposed" "goal $S13_GOAL_ID paused needs_decision; the planner proposed revision 2 (minor), which waits for alice"

  out=$(cap "$ALICE_KEY" decide_plan_revision "{\"goalRunId\":\"$S13_GOAL_ID\",\"revision\":2,\"decision\":\"accept\",\"resume\":true}" "[d.result.decision, d.result.resumed, d.result.revision].join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || goal_fail "s13a-accepted" "$S13_GOAL_ID" "decide_plan_revision HTTP $status: $(parse_kv "$out" BODY)"
  [ "$(parse_kv "$out" EXTRACTED)" = "accept,true,2" ] || goal_fail "s13a-accepted" "$S13_GOAL_ID" "decide_plan_revision answered '$(parse_kv "$out" EXTRACTED)', expected accept,true,2"
  revision=$(goal_get "$S13_GOAL_ID" "$S13_REVISION_EXPR")
  [ "$revision" = "accepted:planner:person" ] || goal_fail "s13a-accepted" "$S13_GOAL_ID" "revision 2 reads '$revision', expected accepted by a person (accepted:planner:person)"
  pass "s13a-accepted" "alice accepted the planner's revision 2 and resumed the run in one call"

  goal_wait "$S13_GOAL_ID" 240 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s13a-achieved" "$S13_GOAL_ID" "goal $S13_GOAL_ID did not settle within 240s of the accept (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "completed,achieved,verified_by_check," ] || goal_fail "s13a-achieved" "$S13_GOAL_ID" "goal $S13_GOAL_ID ended '$GOAL_WAIT_VALUE', expected completed,achieved,verified_by_check"
  pass "s13a-achieved" "goal $S13_GOAL_ID completed achieved, verified by the platform's own check, the planner's way"
  goal_s13_settled s13a
}

goal_s13_apply_minor() {
  goal_s13_refused s13b apply_minor
  goal_wait "$S13_GOAL_ID" 300 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s13b-achieved" "$S13_GOAL_ID" "goal $S13_GOAL_ID did not settle within 300s of the refusal (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "completed,achieved,verified_by_check," ] || goal_fail "s13b-achieved" "$S13_GOAL_ID" "goal $S13_GOAL_ID ended '$GOAL_WAIT_VALUE', expected completed,achieved,verified_by_check with nobody acting after the refusal; rounds: $(goal_get "$S13_GOAL_ID" "$S13_ROUNDS_WHY_EXPR")"
  round=$(goal_get "$S13_GOAL_ID" "$S13_ROUND_EXPR")
  revision=$(goal_get "$S13_GOAL_ID" "$S13_REVISION_EXPR")
  pauses=$(psql_ws "select count(*) from audit_records where workspace_id='$WORKSPACE_ID' and resource_type='goal_run' and resource_id='$S13_GOAL_ID' and payload->>'resultingStatus' = 'paused'")
  [ "$round|$revision|$pauses" = "completed,,1,autonomous:applied:write:action_refused:2:minor|accepted:planner:platform|0" ] \
    || goal_fail "s13b-applied" "$S13_GOAL_ID" "round '$round', revision 2 '$revision', $pauses pause(s) — expected one autonomous round that applied a minor revision 2, accepted by the platform for alice, and no pause; rounds: $(goal_get "$S13_GOAL_ID" "$S13_ROUNDS_WHY_EXPR")"
  pass "s13b-applied" "goal $S13_GOAL_ID never paused: an autonomous round's minor revision 2 was adopted by the platform for alice, and the goal completed achieved"
  goal_s13_settled s13b
}

goal_s13_planner() {
  goal_s13_report_runner
  goal_s13_propose
  goal_s13_apply_minor
}

# --- S5: a step's write waits for approval after its Worker is gone; then the next step starts --

goal_s5_approval() {
  n=$(real_token)
  key="s5-$n"
  write=$(goal_step_json write "ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=$key" "\"acceptance\":[$(goal_observe_check_json ledger-one ledger.get "{\"key\":\"$key\"}" count 1)]")
  after=$(goal_step_json after "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=after" '"dependsOn":["write"]')
  goal_propose_confirm s5 "{\"statement\":\"accept_s2 S5 $n: one ops-runner step adds an entry to the test ledger once approved; another step runs after it.\",\"plan\":{\"steps\":[$write,$after],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s5-$n\"}"
  S5_GOAL_ID=$GOAL_RUN_ID
  pass "s5-confirmed" "alice proposed and confirmed goal $S5_GOAL_ID (write to the test ledger under $key, then a step after it)"

  # The Worker waits for a decision up to the kernel's await budget, gets pending_approval back,
  # reports and exits; only then does the step wait — approving earlier would test something else.
  wait_expr="(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [d.result.status, s.write.status, s.write.waitingReason || '', s.write.actions.map((a) => a.status).join('+'), s.after.status, s.after.attempts.length].join(','); })()"
  goal_wait "$S5_GOAL_ID" 180 "$wait_expr" 'running,waiting,*' 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s5-waiting-approval" "$S5_GOAL_ID" "the write step did not reach waiting within 180s (last '$GOAL_WAIT_VALUE')"
  count=$(ledger_count "$key")
  [ "$GOAL_WAIT_VALUE|$count" = "running,waiting,approval,pending_approval,pending,0|0" ] \
    || goal_fail "s5-waiting-approval" "$S5_GOAL_ID" "read '$GOAL_WAIT_VALUE' with ledger count '$count', expected the run running, the write step waiting(approval) on its pending write, the next step not started, nothing written"
  tasks=$(goal_tasks "$S5_GOAL_ID")
  pass "s5-waiting-approval" "the Worker exited with its write still pending: step waiting(approval), goal still running, the next step not started, the ledger empty ($tasks Task)"

  ar_id=$(goal_get "$S5_GOAL_ID" "d.result.steps.find((x) => x.stepKey === 'write').actions[0].actionRequestId")
  out=$(cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$ar_id\"}" "d.result.status")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || goal_fail "s5-approved" "$S5_GOAL_ID" "approve HTTP $status: $(parse_kv "$out" BODY)"
  pass "s5-approved" "alice approved the write $ar_id after its Worker had gone ('$(parse_kv "$out" EXTRACTED)')"

  goal_wait "$S5_GOAL_ID" 300 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s5-achieved" "$S5_GOAL_ID" "goal $S5_GOAL_ID did not settle within 300s of the approval (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "completed,achieved,verified_by_check," ] || goal_fail "s5-achieved" "$S5_GOAL_ID" "goal $S5_GOAL_ID ended '$GOAL_WAIT_VALUE', expected completed,achieved,verified_by_check"
  done_expr="(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); const sa = d.result.acceptance.steps.find((x) => x.stepKey === 'write'); const r = sa && sa.rounds.length ? sa.rounds[sa.rounds.length - 1] : undefined; const c = r ? r.checks.find((x) => x.checkKey === 'ledger-one') : undefined; return [s.write.status, s.write.attempts.length, s.write.actions.map((a) => a.status).join('+'), c ? c.status + (c.observationId ? ':observed' : ':unobserved') : 'no-check', s.after.status, s.after.attempts.length, Date.parse(s.after.attempts[0].createdAt) >= Date.parse(s.write.endedAt) ? 'after-started-later' : 'after-started-early'].join(','); })()"
  steps=$(goal_get "$S5_GOAL_ID" "$done_expr")
  count=$(ledger_count "$key")
  [ "$steps|$count" = "succeeded,1,executed,passed:observed,succeeded,1,after-started-later|1" ] \
    || goal_fail "s5-achieved" "$S5_GOAL_ID" "read '$steps' with ledger count '$count', expected the write step succeeded on one attempt with its write executed and its check passed on an Observation, the next step started after it and succeeded, one entry written"
  pass "s5-achieved" "goal $S5_GOAL_ID completed(achieved): the write ran once (ledger count 1 at the gate), the step's check passed on an Observation, then the next step started on its own and succeeded"
}

# --- S4: a write ran but its response was lost; the platform reconciles before anything else --
#
# The fixture's ledger adds an entry under a `lose-` key and then drops the connection unanswered
# (deploy/accept-s2/openapi-fixture/server.mjs). The gate cannot tell whether the write ran, so it
# records the call as outcome unknown and answers any repeat of it the same way (R-51): the
# ActionRequest ends failed(outcome_unknown) and is never run again. The step declares how to
# reconcile it — the platform observes `ledger.get` for the same key — and waits(reconcile) on that
# check without pausing the run (reconcile-check.ts).

# goal_s4_reconcile_json <key> <count>: the step's one reconcile declaration — its ledger.add under
# <key>, checked by observing ledger.get's `count` eq <count>.
goal_s4_reconcile_json() {
  printf '"reconcile":[{"action":{"gatekeeperId":"%s","operation":"ledger.add","params":{"key":"%s"}},"check":{"gatekeeperId":"%s","operation":"ledger.get","params":{"key":"%s"},"expect":{"path":"count","op":"eq","value":%s}}}]' \
    "$GATEKEEPER_ID_HTTP" "$1" "$GATEKEEPER_ID_HTTP" "$1" "$2"
}

# goal_s4_write <name> <key> <count>: proposes and confirms a one-step goal whose write under <key>
# is reconciled against `count` eq <count>, waits for the write to be pending and approves it while
# its Worker still waits, then waits for the write to end. Sets GOAL_RUN_ID and S4_WRITE_AR.
goal_s4_write() {
  goal_propose_confirm "$1" "{\"statement\":\"accept_s2 S4 $(real_token): one ops-runner step adds an entry to the test ledger; the answer to the write is lost on the way back.\",\"plan\":{\"steps\":[$(goal_step_json write "ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=$2" "$(goal_s4_reconcile_json "$2" "$3")")],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-$1-$2\"}"
  s4_id=$GOAL_RUN_ID
  s4_expr="(() => { const s = d.result.steps.find((x) => x.stepKey === 'write'); return [d.result.status, s ? s.actions.map((a) => a.status).join('+') : ''].join(','); })()"
  goal_wait "$s4_id" 180 "$s4_expr" '*pending_approval*' 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "$1-approved" "$s4_id" "the step's write did not reach pending_approval within 180s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "running,pending_approval" ] || goal_fail "$1-approved" "$s4_id" "goal $s4_id reads '$GOAL_WAIT_VALUE', expected running with one write pending approval"
  s4_ar=$(goal_get "$s4_id" "d.result.steps.find((x) => x.stepKey === 'write').actions[0].actionRequestId")
  out=$(cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$s4_ar\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "$1-approved" "$s4_id" "approve HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  # The write runs at once; its answer never comes back, the gate says outcome unknown.
  goal_wait "$s4_id" 180 "d.result.steps.find((x) => x.stepKey === 'write').actions.map((a) => a.status + ':' + (a.failureKind || '')).join('+')" 'failed:*' 'executed:*' 'rejected:*' 'expired:*' \
    || goal_fail "$1-approved" "$s4_id" "the approved write did not end within 180s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "failed:outcome_unknown" ] || goal_fail "$1-approved" "$s4_id" "the approved write ended '$GOAL_WAIT_VALUE', expected failed:outcome_unknown (the fixture dropped its answer)"
  pass "$1-approved" "alice approved the write $s4_ar under $2; it ran and its answer was lost: failed(outcome_unknown), never run again by the gate"
  GOAL_RUN_ID=$s4_id
  S4_WRITE_AR=$s4_ar
}

# goal_s4_seen: the reconcile observation shows the effect, so the step succeeds without the write
# running a second time.
goal_s4_seen() {
  key="lose-s4-$(real_token)"
  goal_s4_write s4 "$key" 1
  S4_GOAL_ID=$GOAL_RUN_ID
  s4_ar=$S4_WRITE_AR
  goal_wait "$S4_GOAL_ID" 300 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s4-reconciled" "$S4_GOAL_ID" "goal $S4_GOAL_ID did not settle within 300s of the lost answer (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "completed,achieved,verified_by_check," ] || goal_fail "s4-reconciled" "$S4_GOAL_ID" "goal $S4_GOAL_ID ended '$GOAL_WAIT_VALUE', expected completed,achieved,verified_by_check once the platform saw the write's effect"
  step=$(goal_get "$S4_GOAL_ID" "(() => { const s = d.result.steps.find((x) => x.stepKey === 'write'); return [s.status, s.attempts.length, s.actions.map((a) => [a.status, a.failureKind || '', a.reconciliation || ''].join(':')).join('+')].join(','); })()")
  checks=$(psql_ws "select coalesce(string_agg(status || ':' || (observation_id is not null), ','), '') from action_request_reconcile_checks where workspace_id='$WORKSPACE_ID' and action_request_id='$s4_ar'")
  tasks=$(goal_tasks "$S4_GOAL_ID")
  count=$(ledger_count "$key")
  [ "$step|$checks|$tasks|$count" = "succeeded,1,failed:outcome_unknown:effect_seen|seen:true|1|1" ] \
    || goal_fail "s4-reconciled" "$S4_GOAL_ID" "read step '$step', reconcile check '$checks', $tasks Task(s), ledger count under $key '$count' — expected the step succeeded on one attempt, its write failed(outcome_unknown) and reconciled effect_seen by the platform's check on an Observation, one Task, one entry"
  pass "s4-reconciled" "goal $S4_GOAL_ID completed(achieved): the platform's reconcile observation saw the lost write's effect (effect_seen), the step went on; one attempt, one Task, the write ran once (ledger count 1 at the gate)"
}

# goal_s4_unseen_start: the reverse — the reconcile observation looks for a count the write never
# makes, so it does not see the effect. Like S6 its check retries with backoff in the background
# (GOAL_RECONCILE_CHECK_MAX_ATTEMPTS / _MAX_DURATION_MS, by default 5 attempts within about 7.5
# minutes); goal_s4_unseen_finish picks it up.
goal_s4_unseen_start() {
  S4U_KEY="lose-s4u-$(real_token)"
  goal_s4_write s4u "$S4U_KEY" 2
  S4U_GOAL_ID=$GOAL_RUN_ID
  S4U_AR=$S4_WRITE_AR
  # The Worker reports once its write ends; the step then waits on the platform's check, which does
  # not see the effect and so tries again for minutes — the wait is observable, unlike in
  # goal_s4_seen, whose check sees the effect on its first attempt.
  goal_wait "$S4U_GOAL_ID" 120 "(() => { const s = d.result.steps.find((x) => x.stepKey === 'write'); return [d.result.status, s.status, s.waitingReason || ''].join(','); })()" 'running,waiting,reconcile' 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s4u-waiting-reconcile" "$S4U_GOAL_ID" "the step did not wait on its reconcile check within 120s of the lost answer (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "running,waiting,reconcile" ] || goal_fail "s4u-waiting-reconcile" "$S4U_GOAL_ID" "goal $S4U_GOAL_ID reads '$GOAL_WAIT_VALUE', expected the run running with the step waiting(reconcile)"
  pass "s4u-waiting-reconcile" "goal $S4U_GOAL_ID still running, its step waiting(reconcile): the platform checks the ledger before anything else happens to the step"
}

goal_s4_unseen_finish() {
  goal_wait "$S4U_GOAL_ID" 960 "$GOAL_END_EXPR" 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s4u-awaiting-reconcile" "$S4U_GOAL_ID" "goal $S4U_GOAL_ID did not settle within 960s of retrying its reconcile check (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "paused,,,awaiting_reconcile" ] || goal_fail "s4u-awaiting-reconcile" "$S4U_GOAL_ID" "goal $S4U_GOAL_ID reads '$GOAL_WAIT_VALUE', expected paused awaiting_reconcile"
  step=$(goal_get "$S4U_GOAL_ID" "(() => { const s = d.result.steps.find((x) => x.stepKey === 'write'); return [s.attempts.length, s.actions.map((a) => [a.status, a.failureKind || '', a.reconciliation || ''].join(':')).join('+')].join(','); })()")
  checks=$(psql_ws "select coalesce(string_agg(status || ':' || (observation_id is not null) || ':' || (attempts >= 2), ','), '') from action_request_reconcile_checks where workspace_id='$WORKSPACE_ID' and action_request_id='$S4U_AR'")
  tasks=$(goal_tasks "$S4U_GOAL_ID")
  count=$(ledger_count "$S4U_KEY")
  [ "$step|$checks|$tasks|$count" = "1,failed:outcome_unknown:|not_seen:true:true|1|1" ] \
    || goal_fail "s4u-awaiting-reconcile" "$S4U_GOAL_ID" "read step '$step', reconcile check '$checks', $tasks Task(s), ledger count under $S4U_KEY '$count' — expected one attempt with its write failed(outcome_unknown) and nothing recorded about it, the check not_seen on an Observation after retrying, one Task, the write run once and never again"
  pass "s4u-awaiting-reconcile" "goal $S4U_GOAL_ID paused awaiting_reconcile: the platform's check did not see the effect after retrying, recorded nothing, ran nothing again (ledger count still 1 at the gate)"

  out=$(cap "$ALICE_KEY" cancel_goal "{\"goalRunId\":\"$S4U_GOAL_ID\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s4u-cancelled" "$S4U_GOAL_ID" "cancel_goal HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  goal_wait "$S4U_GOAL_ID" 60 "d.result.status" 'cancelled' \
    || goal_fail "s4u-cancelled" "$S4U_GOAL_ID" "goal $S4U_GOAL_ID reads '$GOAL_WAIT_VALUE' 60s after cancel_goal, expected cancelled"
  pass "s4u-cancelled" "alice cancelled goal $S4U_GOAL_ID, the decision a not-seen effect leaves to a person"
}

# --- S7: cancelled with a write pending at the head of the gate's queue and an approved one behind
# it; another goal's approved write behind both runs at once -----------------------------------
#
# The http gate runs its writes one at a time in the order they were asked for, and a write still
# pending approval at the head holds everything behind it (R-50, listExecutableQueue). Goal A asks
# for two writes; the earlier stays pending, the later is approved and waits behind it. Goal B's
# write, asked for after both, is approved and waits too. Cancelling A withdraws both of A's writes
# in the cancel's own transaction, and the withdrawal's own event drains the gate (the drain
# consumer re-drains on `withdrawn`): B's write runs within seconds, not at the next periodic drain
# (every 60s), and neither of A's ever runs. A's third step, after both writes, never starts.
#
# Not set up here: a Worker still running at the cancel (a goal_ledger Worker lives only for the
# kernel's await budget), and the second variant — an `executing` action whose outcome is unknown
# holding the run in `cancelling` until the deadline, then `cleanup_pending`: the deadline is 30
# minutes and the stale-executing reaper settles such an action first, so on a live stack only
# cancelling → cancelled shows. advancer.integration.test.ts covers both (S7).

# goal_s7_queue: the http gate's queue as the drainer reads it (listExecutableQueue: approved,
# auto-approved, pending approval or executing, oldest first), as id:status,...
goal_s7_queue() {
  psql_ws "select coalesce(string_agg(id || ':' || status, ',' order by requested_at, id), '') from action_requests where workspace_id='$WORKSPACE_ID' and gatekeeper_id='$GATEKEEPER_ID_HTTP' and status in ('auto_approved', 'approved', 'pending_approval', 'executing')"
}

# goal_s7_approve <name> <goalRunId> <actionRequestId>: approves as alice; the gate does not run it
# while the queue's head is pending.
goal_s7_approve() {
  out=$(cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$3\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "$1" "$2" "approve($3) HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  [ "$(parse_kv "$out" EXTRACTED)" = "approved" ] || goal_fail "$1" "$2" "approve($3) answered '$(parse_kv "$out" EXTRACTED)', expected approved (still queued behind the pending head)"
}

goal_s7_cancel_drain() {
  n=$(real_token)
  a1=$(goal_step_json a1 "ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=s7a1-$n")
  a2=$(goal_step_json a2 "ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=s7a2-$n")
  later=$(goal_step_json later "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=later" '"dependsOn":["a1","a2"]')
  goal_propose_confirm s7 "{\"statement\":\"accept_s2 S7 $n: two ops-runner steps each ask to add an entry to the test ledger, a third runs after both; the requester cancels with both writes still queued at the gate.\",\"plan\":{\"steps\":[$a1,$a2,$later],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s7-$n\"}"
  S7_GOAL_ID=$GOAL_RUN_ID
  # Both Workers wait for a decision up to the kernel's await budget, then exit; their steps then
  # wait(approval) on their pending writes.
  held_expr="(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [d.result.status, ...['a1', 'a2'].map((k) => [s[k].status, s[k].waitingReason || '', s[k].actions.map((a) => a.status).join('+')].join(':')), s.later.status + ':' + s.later.attempts.length].join(','); })()"
  goal_wait "$S7_GOAL_ID" 240 "$held_expr" 'running,waiting:approval:pending_approval,waiting:approval:pending_approval,*' 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s7-queued" "$S7_GOAL_ID" "goal $S7_GOAL_ID's two writes were not both pending with their Workers gone within 240s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "running,waiting:approval:pending_approval,waiting:approval:pending_approval,pending:0" ] \
    || goal_fail "s7-queued" "$S7_GOAL_ID" "goal $S7_GOAL_ID reads '$GOAL_WAIT_VALUE', expected both write steps waiting(approval) on a pending write and the step after them not started"
  s7_ids=$(goal_get "$S7_GOAL_ID" "['a1', 'a2'].map((k) => d.result.steps.find((x) => x.stepKey === k).actions[0].actionRequestId).join(' ')")
  # Which of the two is the queue's head: the gate's own order (requested_at, then id).
  s7_order=$(psql_ws "select string_agg(id::text, ' ' order by requested_at, id) from action_requests where workspace_id='$WORKSPACE_ID' and id in ('${s7_ids% *}', '${s7_ids#* }')")
  s7_head=${s7_order%% *}
  s7_queued=${s7_order#* }
  goal_s7_approve "s7-queued" "$S7_GOAL_ID" "$s7_queued"

  goal_propose_confirm s7b "{\"statement\":\"accept_s2 S7 $n (another goal): one ops-runner step asks to add an entry to the test ledger behind the first goal's writes.\",\"plan\":{\"steps\":[$(goal_step_json write "ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=s7b-$n")],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s7b-$n\"}"
  S7B_GOAL_ID=$GOAL_RUN_ID
  b_expr="(() => { const s = d.result.steps.find((x) => x.stepKey === 'write'); return [d.result.status, s.status, s.waitingReason || '', s.actions.map((a) => a.status).join('+')].join(','); })()"
  goal_wait "$S7B_GOAL_ID" 180 "$b_expr" 'running,waiting,approval,pending_approval' 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s7-queued" "$S7B_GOAL_ID" "goal $S7B_GOAL_ID's write was not pending with its Worker gone within 180s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "running,waiting,approval,pending_approval" ] \
    || goal_fail "s7-queued" "$S7B_GOAL_ID" "goal $S7B_GOAL_ID reads '$GOAL_WAIT_VALUE', expected its write step waiting(approval) on a pending write"
  s7b_ar=$(goal_get "$S7B_GOAL_ID" "d.result.steps.find((x) => x.stepKey === 'write').actions[0].actionRequestId")
  goal_s7_approve "s7-queued" "$S7B_GOAL_ID" "$s7b_ar"
  # Long enough for an approval's own drain to have run anything it could.
  sleep 5
  queue=$(goal_s7_queue)
  counts="$(ledger_count "s7a1-$n"),$(ledger_count "s7a2-$n"),$(ledger_count "s7b-$n")"
  [ "$queue|$counts" = "$s7_head:pending_approval,$s7_queued:approved,$s7b_ar:approved|0,0,0" ] \
    || goal_fail "s7-queued" "$S7_GOAL_ID" "the http gate's queue reads '$queue' with ledger counts (A1,A2,B) '$counts' — expected A's pending write $s7_head at its head, A's approved $s7_queued behind it, B's approved $s7b_ar behind both, nothing run"
  pass "s7-queued" "the http gate's queue: goal $S7_GOAL_ID's write $s7_head pending at its head, its approved write $s7_queued behind it, goal $S7B_GOAL_ID's approved write $s7b_ar behind both; nothing has run"

  s7_t0=$(date +%s)
  out=$(cap "$ALICE_KEY" cancel_goal "{\"goalRunId\":\"$S7_GOAL_ID\"}" "(() => { const w = d.result.withdrawnActionRequestIds; return [d.result.status, d.result.cancelledStepRunIds.length, w.length === 2 && w.includes('$s7_head') && w.includes('$s7_queued') ? 'both-withdrawn' : 'withdrew:' + w.join('+')].join(','); })()")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s7-cancelled" "$S7_GOAL_ID" "cancel_goal HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  [ "$(parse_kv "$out" EXTRACTED)" = "cancelling,3,both-withdrawn" ] \
    || goal_fail "s7-cancelled" "$S7_GOAL_ID" "cancel_goal answered '$(parse_kv "$out" EXTRACTED)', expected cancelling with its three steps cancelled and both writes withdrawn in the same call"
  # The withdrawal's own event drains the gate within seconds; the periodic drain comes every 60s
  # at a phase of its own, so 10s leaves it about one chance in six of passing for a broken event
  # path (review #488 on #811). On a miss the poll goes on past one periodic drain, so the FAIL
  # line tells a missed event (ran late) from a stuck queue (never ran).
  s7_bound=10
  while :; do
    s7b_status=$(psql_ws "select status from action_requests where workspace_id='$WORKSPACE_ID' and id='$s7b_ar'")
    case "$s7b_status" in executed | failed | rejected | withdrawn | expired) break ;; esac
    [ "$(date +%s)" -lt $((s7_t0 + s7_bound)) ] || break
    sleep 1
  done
  s7_elapsed=$(($(date +%s) - s7_t0))
  if [ "$s7b_status" != "executed" ]; then
    while :; do
      case "$s7b_status" in executed | failed | rejected | withdrawn | expired) break ;; esac
      [ "$(date +%s)" -lt $((s7_t0 + 75)) ] || break
      sleep 3
      s7b_status=$(psql_ws "select status from action_requests where workspace_id='$WORKSPACE_ID' and id='$s7b_ar'")
    done
    goal_fail "s7-drained" "$S7B_GOAL_ID" "goal $S7B_GOAL_ID's write $s7b_ar was not executed within ${s7_bound}s of the cancel; $(($(date +%s) - s7_t0))s after it, it reads '$s7b_status' — executed then means the periodic drain caught what the withdrawal's own event should have drained at once; still approved means the queue is stuck"
  fi
  pass "s7-drained" "goal $S7B_GOAL_ID's write $s7b_ar ran ${s7_elapsed}s after the cancel: the withdrawal drained the gate at once, not at the next periodic drain"

  goal_wait "$S7_GOAL_ID" 60 "[d.result.status, d.result.cleanupPending].join(',')" 'cancelled,*' \
    || goal_fail "s7-cancelled" "$S7_GOAL_ID" "goal $S7_GOAL_ID reads '$GOAL_WAIT_VALUE' 60s after cancel_goal, expected cancelled"
  steps=$(goal_get "$S7_GOAL_ID" "d.result.steps.map((s) => [s.stepKey, s.status, s.attempts.length, s.actions.map((a) => a.status).join('+')].join(':')).sort().join(',')")
  tasks=$(goal_tasks "$S7_GOAL_ID")
  counts="$(ledger_count "s7a1-$n"),$(ledger_count "s7a2-$n")"
  [ "$GOAL_WAIT_VALUE|$steps|$tasks|$counts|$(goal_s7_queue)" = "cancelled,false|a1:cancelled:1:withdrawn,a2:cancelled:1:withdrawn,later:cancelled:0:|2|0,0|" ] \
    || goal_fail "s7-cancelled" "$S7_GOAL_ID" "read goal '$GOAL_WAIT_VALUE', steps '$steps', $tasks Task(s), ledger counts (A1,A2) '$counts', the gate's queue '$(goal_s7_queue)' — expected cancelled without cleanup left, both writes withdrawn, the third step never started, two Tasks, nothing written, the queue empty"
  pass "s7-cancelled" "goal $S7_GOAL_ID cancelled (cancelling → cancelled, nothing left to clean up): both writes withdrawn and never run (ledger counts 0 at the gate), the step after them never started, no new Task"

  goal_wait "$S7B_GOAL_ID" 180 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s7-other-goal" "$S7B_GOAL_ID" "goal $S7B_GOAL_ID did not settle within 180s of its write running (last '$GOAL_WAIT_VALUE')"
  count=$(ledger_count "s7b-$n")
  [ "$GOAL_WAIT_VALUE|$count" = "completed,achieved,verified_by_check,|1" ] \
    || goal_fail "s7-other-goal" "$S7B_GOAL_ID" "goal $S7B_GOAL_ID ended '$GOAL_WAIT_VALUE' with ledger count '$count', expected completed,achieved,verified_by_check with its one write run once"
  pass "s7-other-goal" "goal $S7B_GOAL_ID completed(achieved): its write ran once (ledger count 1 at the gate)"
}

# --- S9: the requester loses a gate the Worker needs; the next step does not start -----------
#
# bob (member) is granted the three gates the ops-runner Worker declares and proposes a goal of two
# steps, b after a; a restarts the accept-s2 test container through the docker gate, so the run
# holds while that write waits for approval. alice (owner) revokes bob's ssh gate, then approves
# a's write: a succeeds, and b, whose Worker would need a gate bob no longer holds, never starts —
# the run pauses authority_lost (step-attempt.ts, resolveStepAuthority). The plan's own wording,
# demoting the requester to a role without the gate, meets the same check;
# advancer.integration.test.ts covers the demoted and the disabled requester. bob's grants are
# revoked again at the end (cleanup_step too, via goal_cleanup_grants).
#
# a's write is a docker one, not a ledger one: an action runs on behalf of its goal's requester,
# and the http gate is connected `connected_account` with alice's token alone — a write there for
# bob is refused by the gate (credential_unavailable), as it should be. The docker gate takes no
# per-person credential. The goal's acceptance check (stock.get, the same http gate) never runs:
# the run pauses before it, and bob cancels it.

S9_GRANTS=""

goal_s9_authority_lost() {
  n=$(real_token)
  s9_ssh_grant=""
  for s9_gate in "$GATEKEEPER_ID_SSH" "$GATEKEEPER_ID_HTTP" "$GATEKEEPER_ID_DOCKER"; do
    out=$(cap "$ALICE_KEY" connect_gatekeeper "{\"gatekeeperId\":\"$s9_gate\",\"principalId\":\"$BOB_PRINCIPAL_ID\"}" "d.result.id")
    [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || fail "s9-confirmed" "connect_gatekeeper($s9_gate) for bob HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
    s9_grant=$(parse_kv "$out" EXTRACTED)
    S9_GRANTS="$S9_GRANTS $s9_grant"
    # The first one granted: the ssh gate's, which step a does not use.
    [ -n "$s9_ssh_grant" ] || s9_ssh_grant=$s9_grant
  done
  write=$(goal_step_json a "ACCEPT_S2_SCENARIO=docker_restart CONTAINER_ID=$RESTART_TARGET_ID")
  after=$(goal_step_json b "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=b" '"dependsOn":["a"]')
  goal_propose_confirm s9 "{\"statement\":\"accept_s2 S9 $n: one ops-runner step restarts the accept-s2 test container once approved; another runs after it, unless the requester has lost a gate it needs.\",\"plan\":{\"steps\":[$write,$after],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s9-$n\"}" "$BOB_KEY"
  S9_GOAL_ID=$GOAL_RUN_ID
  pass "s9-confirmed" "alice granted bob the ssh, http and docker gates the ops-runner Worker declares; bob proposed and confirmed goal $S9_GOAL_ID (a restarts the test container through the docker gate, b after a)"

  wait_expr="(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [d.result.status, s.a.status, s.a.waitingReason || '', s.a.actions.map((a) => a.status).join('+'), s.b.status, s.b.attempts.length].join(','); })()"
  goal_wait "$S9_GOAL_ID" 180 "$wait_expr" 'running,waiting,*' 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s9-revoked" "$S9_GOAL_ID" "step a did not reach waiting within 180s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "running,waiting,approval,pending_approval,pending,0" ] \
    || goal_fail "s9-revoked" "$S9_GOAL_ID" "goal $S9_GOAL_ID reads '$GOAL_WAIT_VALUE', expected the run running, step a waiting(approval) on its pending write, b not started"
  out=$(cap "$ALICE_KEY" revoke_capability "{\"grantId\":\"$s9_ssh_grant\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s9-revoked" "$S9_GOAL_ID" "revoke_capability($s9_ssh_grant) HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  [ "$(parse_kv "$out" EXTRACTED)" = "revoked" ] || goal_fail "s9-revoked" "$S9_GOAL_ID" "revoke_capability($s9_ssh_grant) answered '$(parse_kv "$out" EXTRACTED)', expected revoked"
  ar_id=$(goal_get "$S9_GOAL_ID" "d.result.steps.find((x) => x.stepKey === 'a').actions[0].actionRequestId")
  out=$(cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$ar_id\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s9-revoked" "$S9_GOAL_ID" "approve HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  pass "s9-revoked" "alice revoked bob's ssh gate ($s9_ssh_grant) while step a's write waited, then approved the write $ar_id"

  goal_wait "$S9_GOAL_ID" 180 "$GOAL_END_EXPR" 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s9-authority-lost" "$S9_GOAL_ID" "goal $S9_GOAL_ID did not settle within 180s of the approval (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "paused,,,authority_lost" ] || goal_fail "s9-authority-lost" "$S9_GOAL_ID" "goal $S9_GOAL_ID reads '$GOAL_WAIT_VALUE', expected paused authority_lost"
  steps=$(goal_get "$S9_GOAL_ID" "(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [s.a.status, s.a.actions.map((a) => a.status).join('+'), s.b.status, s.b.attempts.length].join(','); })()")
  tasks=$(goal_tasks "$S9_GOAL_ID")
  [ "$steps|$tasks" = "succeeded,executed,ready,0|1" ] \
    || goal_fail "s9-authority-lost" "$S9_GOAL_ID" "read steps '$steps', $tasks Task(s) — expected a succeeded with its write executed, b ready and never started, one Task"
  pass "s9-authority-lost" "goal $S9_GOAL_ID paused authority_lost: a succeeded (the docker gate ran its write), b is ready but never started — bob no longer holds the ssh gate its Worker declares; one Task"

  out=$(cap "$BOB_KEY" cancel_goal "{\"goalRunId\":\"$S9_GOAL_ID\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s9-cancelled" "$S9_GOAL_ID" "cancel_goal (bob) HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  goal_wait "$S9_GOAL_ID" 60 "d.result.status" 'cancelled' \
    || goal_fail "s9-cancelled" "$S9_GOAL_ID" "goal $S9_GOAL_ID reads '$GOAL_WAIT_VALUE' 60s after cancel_goal, expected cancelled"
  for s9_grant in $S9_GRANTS; do
    [ "$s9_grant" = "$s9_ssh_grant" ] && continue
    out=$(cap "$ALICE_KEY" revoke_capability "{\"grantId\":\"$s9_grant\"}" "d.result.status")
    [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s9-cancelled" "$S9_GOAL_ID" "revoke_capability($s9_grant) HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  done
  S9_GRANTS=""
  pass "s9-cancelled" "bob cancelled goal $S9_GOAL_ID; alice revoked bob's other two grants: bob holds no gate again, as after bootstrap"
}

# --- S10: the goal's tokens run out; the run pauses, it does not fail -------------------------
#
# maxTokens 1: the first step's attempt is capped at what is left of the goal's budget, one token
# (advance.ts startSteps, step-attempt.ts). The fake model's first answer spends more; once
# llm-proxy reports the usage (every ~2s) the kernel fails the Task budget_exhausted and terminates
# its Worker (recordWorkerRunUsage), and the next advance finds the goal's tokens spent and pauses
# the run budget_exhausted. A goal_ledger step, so the attempt is still live when the usage lands:
# its write (await_decision) has usually reached the gate by then, moved the Task to
# waiting_approval and holds the step waiting(approval) — a waiting Task is stopped all the same
# (the third rehearsal of GO7a-2 caught the kernel letting it run on: it judged only running
# Tasks), the run pauses, the write is left to the person, and the cancel at the end withdraws it.
# Should the Worker be stopped before its write reaches the gate, the step fails transient instead,
# under the same pause. Either way: not failed, not completed, the next step never started.

goal_s10_budget() {
  n=$(real_token)
  key="s10-$n"
  write=$(goal_step_json a "ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=$key")
  after=$(goal_step_json b "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=b" '"dependsOn":["a"]')
  goal_propose_confirm s10 "{\"statement\":\"accept_s2 S10 $n: a goal allowed one token; its first step's Worker spends more than that.\",\"plan\":{\"steps\":[$write,$after],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":{\"maxTokens\":1,\"maxSteps\":6,\"maxRevisions\":1,\"maxWallClockSeconds\":1800},\"idempotencyKey\":\"accept-s2-goal-s10-$n\"}"
  S10_GOAL_ID=$GOAL_RUN_ID
  pass "s10-confirmed" "alice proposed and confirmed goal $S10_GOAL_ID with maxTokens 1 (a writes to the test ledger under $key, b after a)"

  goal_wait "$S10_GOAL_ID" 180 "$GOAL_END_EXPR" 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s10-budget-exhausted" "$S10_GOAL_ID" "goal $S10_GOAL_ID did not settle within 180s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "paused,,,budget_exhausted" ] || goal_fail "s10-budget-exhausted" "$S10_GOAL_ID" "goal $S10_GOAL_ID reads '$GOAL_WAIT_VALUE', expected paused budget_exhausted (not failed, not completed)"
  steps=$(goal_get "$S10_GOAL_ID" "(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [s.a.attempts.map((t) => t.status + ':' + (t.failureReason || '')).join('+'), s.a.status + ':' + (s.a.waitingReason || s.a.failureCategory || '') + ':' + s.a.actions.map((a) => a.status).join('+'), s.b.attempts.length].join(','); })()")
  case "$steps" in
    "failed:budget_exhausted,waiting:approval:pending_approval,0") s10_way="its write had reached the gate first and is left pending for a person" ;;
    "failed:budget_exhausted,failed:transient:,0") s10_way="its Worker was stopped before its write reached the gate, the step failed transient" ;;
    *) goal_fail "s10-budget-exhausted" "$S10_GOAL_ID" "read steps '$steps', expected a's one attempt failed budget_exhausted (a waiting(approval) on its pending write, or failed transient without one) and b never started" ;;
  esac
  spent=$(goal_get "$S10_GOAL_ID" "d.result.usage.tokens")
  tasks=$(goal_tasks "$S10_GOAL_ID")
  cap_budget=$(psql_ws "select coalesce(string_agg(token_budget::text, ','), '') from tasks where workspace_id='$WORKSPACE_ID' and goal_run_id='$S10_GOAL_ID'")
  [ "$tasks|$cap_budget" = "1|1" ] || goal_fail "s10-budget-exhausted" "$S10_GOAL_ID" "goal $S10_GOAL_ID has $tasks Task(s) with token budget(s) '$cap_budget', expected one, capped at the one token the goal had left"
  [ "$spent" -ge 1 ] 2>/dev/null || goal_fail "s10-budget-exhausted" "$S10_GOAL_ID" "the goal reads '$spent' token(s) spent, expected at least its budget (1)"
  pass "s10-budget-exhausted" "goal $S10_GOAL_ID paused budget_exhausted, not failed: a's one attempt, capped at 1 token, spent $spent and failed budget_exhausted; b never started — $s10_way"

  out=$(cap "$ALICE_KEY" cancel_goal "{\"goalRunId\":\"$S10_GOAL_ID\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s10-cancelled" "$S10_GOAL_ID" "cancel_goal HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  goal_wait "$S10_GOAL_ID" 60 "d.result.status" 'cancelled' \
    || goal_fail "s10-cancelled" "$S10_GOAL_ID" "goal $S10_GOAL_ID reads '$GOAL_WAIT_VALUE' 60s after cancel_goal, expected cancelled"
  actions=$(goal_get "$S10_GOAL_ID" "d.result.steps.find((x) => x.stepKey === 'a').actions.map((a) => a.status).join('+')")
  count=$(ledger_count "$key")
  case "$actions|$count" in
    "withdrawn|0") s10_write="a's pending write withdrawn" ;;
    "|0") s10_write="a raised no write" ;;
    *) goal_fail "s10-cancelled" "$S10_GOAL_ID" "after the cancel a's write reads '$actions' with ledger count under $key '$count', expected it withdrawn (or never raised) and nothing written" ;;
  esac
  pass "s10-cancelled" "alice cancelled goal $S10_GOAL_ID, the decision a spent budget leaves to a person: $s10_write, nothing written (ledger count 0 at the gate)"
}

# --- Held turns, row locks and service restarts (S11 GO7a-3: S12, S8, S2) -----------------------
#
# Held turns: a goal step whose input carries `HOLD=<name>` has its Worker's scripted model turn
# kept back by fake-llm until the script releases that name (deploy/fake-llm/server.mjs "Held
# turns"): once it is listed the Worker is mid model call, its Task running, and the script
# decides what happens before the Worker reports or writes again. fake-llm sends the turn's
# response headers before holding it (llm-proxy cuts an upstream that sends none within 10 s) and
# answers it by itself after 120 s, so nothing here can leave a Worker waiting longer than that.
# A terminated Worker's held request stays listed until it is released: llm-proxy does not pass
# its client's going away on to fake-llm. So a listed hold does not say its Worker still waits on
# it; goal_release_running and goal_task_reported (below) check the Worker's side.

GOAL_HOLDS=""

# fake_llm_holds: the names fake-llm is holding right now, comma-separated; empty when none (or
# when fake-llm did not answer).
fake_llm_holds() {
  compose_accept --profile test exec -T fake-llm node -e "fetch('http://127.0.0.1:8090/accept-s2/holds').then((r) => r.json()).then((d) => console.log(d.holds.join(',')))" </dev/null 2>/dev/null
}

# fake_llm_hold_counts <name>: `held=<n> dropped=<n>` — how many requests fake-llm held under <name>
# and how many of those had their connection close while held (a model call cut and asked again
# holds the name twice, one dropped); `unknown` when fake-llm did not answer.
fake_llm_hold_counts() {
  compose_accept --profile test exec -T fake-llm node -e "fetch('http://127.0.0.1:8090/accept-s2/holds').then((r) => r.json()).then((d) => { const c = d.counts[process.argv[1]] || {held: 0, dropped: 0}; console.log('held=' + c.held + ' dropped=' + c.dropped); })" "$1" </dev/null 2>/dev/null || echo unknown
}

# fake_llm_release <name>: lets the turns held under <name> answer; prints how many there were.
fake_llm_release() {
  compose_accept --profile test exec -T fake-llm node -e "fetch('http://127.0.0.1:8090/accept-s2/holds/' + process.argv[1] + '/release', {method: 'POST'}).then((r) => r.json()).then((d) => console.log(d.released))" "$1" </dev/null 2>/dev/null
}

# fake_llm_wait_hold <name> <seconds>: waits until fake-llm holds <name>; 1 when the time ran out.
fake_llm_wait_hold() {
  fwh_deadline=$(($(date +%s) + $2))
  while :; do
    case ",$(fake_llm_holds)," in *",$1,"*) return 0 ;; esac
    [ "$(date +%s)" -lt "$fwh_deadline" ] || return 1
    sleep 2
  done
}

# Row locks (S12's lost wake, S2's killed advance): one row of a goal this script proposed —
# goal_runs or step_runs, nothing else — locked the way an advance holds it (`select … for no key
# update`), in a transaction of its own on a connection of its own: psql in the postgres container,
# in the background, named by application_name `accept_s2_lock_<name>` so it can be found and
# ended. It is a row lock and nothing more: the only table-level lock it takes is the ROW SHARE
# every `select … for update` takes, which conflicts with DDL alone (EXCLUSIVE, ACCESS EXCLUSIVE),
# never with a read or a write; foreign-key checks (`for key share`) pass it too. Bounded four ways:
#   - taking it waits at most 5 s (`lock_timeout`), so it never queues behind an advance for long;
#   - it holds for at most its bound — GOAL_LOCK_MAX_SECONDS (60 s) unless the scenario names one:
#     S12 90 s, S2 180 s, each well past what the scenario waits with it held (`pg_sleep`, with a
#     `statement_timeout` above it) — and then commits, even when this script was killed outright
#     and no trap ran;
#   - the scenario ends it as soon as it has seen what it needs (goal_row_lock_release:
#     pg_terminate_backend on that application_name, which rolls the transaction back), and
#     cleanup_step ends any still held before anything else, with --keep too;
#   - a psql process that dies mid-hold has it aborted within a second
#     (`client_connection_check_interval`). Killing only this side's `docker compose exec` does
#     not end psql inside the postgres container; then the bound above is what ends it (review
#     #493 on #817).

GOAL_LOCK_MAX_SECONDS=60
GOAL_LOCKS=""

# goal_row_lock_take <name> <goal_runs|step_runs> <rowId> [<max seconds>]: takes the lock in the
# background and returns once it is held (its holder in pg_sleep); 1 when it was not held within
# 10 s. It ends on its own after <max seconds> (default GOAL_LOCK_MAX_SECONDS, at most 300).
goal_row_lock_take() {
  case "$2" in
    goal_runs | step_runs) : ;;
    *) echo "goal_row_lock_take: table '$2' is not one this script may lock" >&2; return 1 ;;
  esac
  grl_max=${4:-$GOAL_LOCK_MAX_SECONDS}
  case "$grl_max" in
    '' | *[!0-9]*) echo "goal_row_lock_take: bound '$grl_max' is not a number of seconds" >&2; return 1 ;;
  esac
  [ "$grl_max" -ge 1 ] && [ "$grl_max" -le 300 ] || { echo "goal_row_lock_take: bound ${grl_max}s is outside 1–300s" >&2; return 1; }
  grl_app="accept_s2_lock_$1"
  GOAL_LOCKS="$GOAL_LOCKS $1"
  docker compose exec -T postgres psql -U nexttime -d nexttime -v ON_ERROR_STOP=1 -tAc \
    "set application_name = '$grl_app'; set client_connection_check_interval = '1s'; begin; set local lock_timeout = '5s'; set local statement_timeout = '$((grl_max + 15))s'; select 1 from $2 where workspace_id = '$WORKSPACE_ID' and id = '$3' for no key update; select pg_sleep($grl_max); commit;" \
    </dev/null >/dev/null 2>&1 &
  grl_deadline=$(($(date +%s) + 10))
  while :; do
    [ "$(goal_row_lock_held "$1")" = "1" ] && return 0
    [ "$(date +%s)" -lt "$grl_deadline" ] || return 1
    sleep 1
  done
}

# goal_row_lock_held <name>: 1 while the lock is held (its holder sleeping in its transaction), else 0.
goal_row_lock_held() {
  psql_ws "select count(*) from pg_stat_activity where application_name = 'accept_s2_lock_$1' and wait_event = 'PgSleep'"
}

# goal_row_lock_waiters <name> <query text>: how many sessions are waiting on the lock right now —
# blocked by its holder — with a current query containing <query text>.
goal_row_lock_waiters() {
  psql_ws "select count(*) from pg_stat_activity w where strpos(w.query, '$2') > 0 and exists (select 1 from pg_stat_activity h where h.application_name = 'accept_s2_lock_$1' and h.pid = any(pg_blocking_pids(w.pid)))"
}

# goal_row_lock_release <name>: ends the lock now — pg_terminate_backend, waiting up to 5 s for the
# holder to be gone, rolls its transaction back; prints how many holders it ended (0 once the lock
# had already ended on its own). The holder's pid is picked first, in a materialized CTE: in a
# plain WHERE the planner may call pg_terminate_backend on rows before the application_name test
# filters them — tried on Postgres 16, it ended every session it reached, its own included.
goal_row_lock_release() {
  psql_ws "with holder as materialized (select pid from pg_stat_activity where application_name = 'accept_s2_lock_$1' and datname = current_database() and pid <> pg_backend_pid()) select count(*) from holder where pg_terminate_backend(pid, 5000)"
}

# goal_step_task <goalRunId> <stepKey> <attempt>: the Task of that attempt of that step.
goal_step_task() {
  psql_ws "select t.id from tasks t join step_runs s on s.workspace_id = t.workspace_id and s.id = t.step_run_id where t.workspace_id = '$WORKSPACE_ID' and t.goal_run_id = '$1' and s.step_key = '$2' and t.step_attempt = $3"
}

# goal_task_status <taskId>: the Task's status.
goal_task_status() {
  psql_ws "select status from tasks where workspace_id = '$WORKSPACE_ID' and id = '$1'"
}

# A held turn's answer reaching its Worker (S12, S2). fake-llm's counts see only llm-proxy's side of
# a held call: a Worker whose own call to llm-proxy is cut ends its Task by itself (its fallback
# summary) while fake-llm still holds the request llm-proxy made, which answers nobody once
# released. So a held goal step's turn is released only while its Task still reads running
# (goal_release_running), and once the Task has ended its stored summary must be the one fake-llm
# scripts for that report (goal_task_reported) — review #493 on #817.

# goal_release_running <check> <goalRunId> <hold> <taskId> [<lock>]: releases the turn held under
# <hold> once its Task <taskId> still reads running; fails <check> — ending <lock> first — when it
# does not, or when other than one request answered.
goal_release_running() {
  grr_status=$(goal_task_status "$4")
  if [ "$grr_status" != "running" ]; then
    [ -z "${5:-}" ] || goal_row_lock_release "$5" >/dev/null
    goal_fail "$1" "$2" "Task $4 reads '$grr_status' just before its held turn ($3) is released, expected running: its Worker ended without that turn's answer"
  fi
  grr_released=$(fake_llm_release "$3")
  if [ "$grr_released" != "1" ]; then
    [ -z "${5:-}" ] || goal_row_lock_release "$5" >/dev/null
    goal_fail "$1" "$2" "releasing the turn held under $3 released '$grr_released' request(s), expected 1"
  fi
}

# goal_task_reported <taskId> <nonce>: `ok` when the Task's stored summary is the one fake-llm
# scripts for a goal step's report (goalStepScenario: `accept_s2: goal step <nonce> done; …`),
# else the summary it stored.
goal_task_reported() {
  gtr_summary=$(psql_ws "select coalesce(result->>'summary', '(none)') from tasks where workspace_id = '$WORKSPACE_ID' and id = '$1'")
  [ "$gtr_summary" = "accept_s2: goal step $2 done; the platform checks the stock API itself." ] && echo ok || echo "$gtr_summary"
}

# goal_one_task_per_attempt <goalRunId>: `ok` when every attempt of every step of the run has
# exactly one Task (I-G1) — the Tasks number the attempts and no attempt has two — else what differs.
goal_one_task_per_attempt() {
  psql_ws "select case when d.doubled = 0 and d.tasks = d.attempts then 'ok' else d.tasks || ' Task(s) for ' || d.attempts || ' attempt(s), ' || d.doubled || ' attempt(s) with more than one' end from (select (select count(*) from tasks where workspace_id = '$WORKSPACE_ID' and goal_run_id = '$1') as tasks, (select coalesce(sum(attempt_count), 0) from step_runs where workspace_id = '$WORKSPACE_ID' and goal_run_id = '$1') as attempts, (select count(*) from (select 1 from tasks where workspace_id = '$WORKSPACE_ID' and goal_run_id = '$1' group by step_run_id, step_attempt having count(*) > 1) x) as doubled) d"
}

# Service restarts (S2): the kernel killed (SIGKILL — a crash, not a shutdown) and started again,
# worker-supervisor restarted. GOAL_SERVICE_DOWN names a service killed and not yet back, for
# cleanup_step to start it again before it calls the kernel.

GOAL_SERVICE_DOWN=""

# goal_started_at <service>: when the service's container last started.
goal_started_at() {
  docker inspect --format '{{.State.StartedAt}}' "$(compose_accept ps -q "$1" 2>/dev/null)" 2>/dev/null
}

# goal_kernel_kill_restart <name>: SIGKILLs the kernel, starts it again and waits — at most 120 s —
# until the new container passes its healthcheck. GOAL_RESTART_SECONDS: how long it was gone.
# Never called in $(…): its fail must end the script, and GOAL_SERVICE_DOWN must reach cleanup.
goal_kernel_kill_restart() {
  gkr_before=$(goal_started_at kernel)
  gkr_t0=$(date +%s)
  GOAL_SERVICE_DOWN=kernel
  gkr_out=$(compose_accept kill -s SIGKILL kernel 2>&1) || fail "$1" "docker compose kill -s SIGKILL kernel failed: $gkr_out"
  gkr_out=$(compose_accept start kernel 2>&1) || fail "$1" "docker compose start kernel failed: $gkr_out"
  gkr_deadline=$((gkr_t0 + 120))
  while :; do
    gkr_id=$(compose_accept ps -q kernel 2>/dev/null)
    if [ -n "$gkr_id" ] && [ "$(goal_started_at kernel)" != "$gkr_before" ] \
      && [ "$(docker inspect --format '{{.State.Health.Status}}' "$gkr_id" 2>/dev/null)" = "healthy" ]; then
      break
    fi
    [ "$(date +%s)" -lt "$gkr_deadline" ] || fail "$1" "the kernel was not healthy again within 120s of the kill: $(compose_accept ps kernel 2>&1 | tail -1)"
    sleep 2
  done
  GOAL_SERVICE_DOWN=""
  GOAL_RESTART_SECONDS=$(($(date +%s) - gkr_t0))
}

# goal_supervisor_restart <name>: restarts worker-supervisor (its own SIGTERM shutdown, which leaves
# Task containers running) and waits — at most 90 s — until the new process answers /healthz, which
# it serves only after its startup reconcile has re-adopted the running Task containers.
# GOAL_RESTART_SECONDS: how long it took. Not in $(…) either.
goal_supervisor_restart() {
  gsr_before=$(goal_started_at worker-supervisor)
  gsr_t0=$(date +%s)
  GOAL_SERVICE_DOWN=worker-supervisor
  gsr_out=$(compose_accept restart worker-supervisor 2>&1) || fail "$1" "docker compose restart worker-supervisor failed: $gsr_out"
  gsr_deadline=$((gsr_t0 + 90))
  while :; do
    if [ "$(goal_started_at worker-supervisor)" != "$gsr_before" ] \
      && compose_accept exec -T worker-supervisor node -e "fetch('http://127.0.0.1:8081/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" </dev/null >/dev/null 2>&1; then
      break
    fi
    [ "$(date +%s)" -lt "$gsr_deadline" ] || fail "$1" "worker-supervisor did not answer /healthz within 90s of its restart: $(compose_accept ps worker-supervisor 2>&1 | tail -1)"
    sleep 2
  done
  GOAL_SERVICE_DOWN=""
  GOAL_RESTART_SECONDS=$(($(date +%s) - gsr_t0))
}

# goal_cleanup_live_work: for cleanup_step, first — a service S2 killed is started again, every row
# lock still held is ended, every held turn released; prints one line each, never fails.
goal_cleanup_live_work() {
  if [ -n "$GOAL_SERVICE_DOWN" ]; then
    gcl_out=$(compose_accept start "$GOAL_SERVICE_DOWN" 2>&1)
    echo "cleanup: $GOAL_SERVICE_DOWN was down after S2 — docker compose start answered: $gcl_out"
    gcl_deadline=$(($(date +%s) + 120))
    while [ "$GOAL_SERVICE_DOWN" = "kernel" ] && [ "$(date +%s)" -lt "$gcl_deadline" ]; do
      [ "$(docker inspect --format '{{.State.Health.Status}}' "$(compose_accept ps -q kernel 2>/dev/null)" 2>/dev/null)" = "healthy" ] && break
      sleep 2
    done
    GOAL_SERVICE_DOWN=""
  fi
  for gcl_lock in $GOAL_LOCKS; do
    gcl_ended=$(goal_row_lock_release "$gcl_lock")
    [ "$gcl_ended" = "0" ] || echo "cleanup: row lock $gcl_lock was still held — ended ($gcl_ended)"
  done
  for gcl_hold in $GOAL_HOLDS; do
    gcl_released=$(fake_llm_release "$gcl_hold")
    case "$gcl_released" in 0 | "") : ;; *) echo "cleanup: fake-llm still held turn $gcl_hold — released ($gcl_released)" ;; esac
  done
}

# --- S12: a lost wake; the periodic reconcile scan finds the run and moves it on ----------------
#
# The wake consumer (application/goal/advancer.ts registerGoalWakeConsumer) never throws — a throw
# would redeliver the event to every consumer of it — so a wake that fails is dropped: no retry, no
# dead letter. What brings the run back is the reconcile scan (markReconcileDue, every 60 s). To
# lose one: a's Worker is held at fake-llm, its Task running; the GoalRun's row is locked the way an
# advance holds it; the hold is released, a's Task completes and its TaskUpdated is dispatched while
# the row is held; the wake's update (`update goal_runs set next_tick_at = now() …`) waits on the
# row for its own lock_timeout (5 s), gives up — seen waiting, blocked by this lock, then gone — and
# only then is the lock released. That TaskUpdated is the only event a's Task ends with, and the
# run's next tick is its wall-clock deadline: a moving on is the scan's doing, within one scan
# period (plus the advancer's 1 s tick and this script's 3 s poll).

goal_s12_lost_wake() {
  n=$(real_token)
  hold="s12-$n-a"
  lock="s12-$n"
  a=$(goal_step_json a "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=a HOLD=$hold")
  b=$(goal_step_json b "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=b" '"dependsOn":["a"]')
  GOAL_HOLDS="$GOAL_HOLDS $hold"
  goal_propose_confirm s12 "{\"statement\":\"accept_s2 S12 $n: two ops-runner steps report one after the other; the wake for the first one's end is lost on purpose.\",\"plan\":{\"steps\":[$a,$b],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s12-$n\"}"
  S12_GOAL_ID=$GOAL_RUN_ID
  pass "s12-confirmed" "alice proposed and confirmed goal $S12_GOAL_ID (a, held at fake-llm until released, then b after a)"

  fake_llm_wait_hold "$hold" 180 || goal_fail "s12-locked" "$S12_GOAL_ID" "a's Worker did not reach its held turn within 180s (fake-llm holds '$(fake_llm_holds)')"
  task=$(goal_step_task "$S12_GOAL_ID" a 1)
  [ "$(goal_task_status "$task")" = "running" ] || goal_fail "s12-locked" "$S12_GOAL_ID" "a's Task '$task' reads '$(goal_task_status "$task")' while its Worker is held, expected running"
  # 90 s: at most 10 s to take it and 45 s of the loop below pass with it held.
  goal_row_lock_take "$lock" goal_runs "$S12_GOAL_ID" 90 || goal_fail "s12-locked" "$S12_GOAL_ID" "could not lock goal $S12_GOAL_ID's row within 10s (an advance holding it?)"
  pass "s12-locked" "goal $S12_GOAL_ID's row is locked (for no key update, its own transaction) while a's Worker is held mid model call, its Task $task running"

  goal_release_running s12-wake-lost "$S12_GOAL_ID" "$hold" "$task" "$lock"
  ended=""
  saw=""
  gone=""
  sent=""
  deadline=$(($(date +%s) + 45))
  while :; do
    [ -n "$ended" ] || { [ "$(goal_task_status "$task")" = "completed" ] && ended=$(date +%s); }
    waiting=$(goal_row_lock_waiters "$lock" 'update goal_runs set next_tick_at = now()')
    if [ "$waiting" != "0" ]; then
      [ -n "$saw" ] || saw=$(date +%s)
    elif [ -n "$saw" ] && [ -z "$gone" ]; then
      gone=$(date +%s)
    fi
    [ -n "$sent" ] || { [ "$(psql_ws "select count(*) from outbox where workspace_id='$WORKSPACE_ID' and event_type='TaskUpdated' and payload->>'taskId'='$task' and payload->>'status'='completed' and dispatched_at is not null")" = "1" ] && sent=$(date +%s); }
    [ -n "$gone" ] && [ -n "$sent" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 1
  done
  held=$(goal_row_lock_held "$lock")
  if [ -z "$ended" ] || [ -z "$gone" ] || [ -z "$sent" ] || [ "$held" != "1" ]; then
    goal_row_lock_release "$lock" >/dev/null
    goal_fail "s12-wake-lost" "$S12_GOAL_ID" "45s after a's turn was released: Task completed '${ended:-no}', the wake's update seen waiting on the row '${saw:-no}', given up '${gone:-no}', TaskUpdated dispatched '${sent:-no}', lock still held '$held' — expected all, with the lock held throughout"
  fi
  reported=$(goal_task_reported "$task" "$n")
  [ "$reported" = "ok" ] || { goal_row_lock_release "$lock" >/dev/null; goal_fail "s12-wake-lost" "$S12_GOAL_ID" "a's Task $task completed with summary '$reported', expected fake-llm's scripted report: the held turn's answer did not reach its Worker"; }
  took=$(psql_ws "select round(extract(epoch from dispatched_at - created_at)::numeric, 1) from outbox where workspace_id='$WORKSPACE_ID' and event_type='TaskUpdated' and payload->>'taskId'='$task' and payload->>'status'='completed'")
  tick=$(psql_ws "select coalesce(round(extract(epoch from next_tick_at - now()))::text, 'none') from goal_runs where workspace_id='$WORKSPACE_ID' and id='$S12_GOAL_ID'")
  ended_locks=$(goal_row_lock_release "$lock")
  unlocked=$(date +%s)
  # Nothing but the scan may bring the run back in the window judged below.
  case "$tick" in
    none) : ;;
    *) [ "$tick" -ge 120 ] 2>/dev/null || goal_fail "s12-wake-lost" "$S12_GOAL_ID" "the run's next tick is ${tick}s away, expected none or its wall-clock deadline (an advance due this soon would move a on without the scan)" ;;
  esac
  pass "s12-wake-lost" "a's Task $task completed with the held turn's report while the row was held; its TaskUpdated took ${took}s to dispatch — the wake's update waited on the row and gave up (seen waiting, then gone, the lock still held) — and the run's next tick was ${tick}s away (its wall-clock deadline); lock ended ($ended_locks)"

  a_expr="(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [s.a.status, s.a.attempts.length].join(','); })()"
  goal_wait "$S12_GOAL_ID" 90 "$a_expr" 'succeeded,*' 'failed,*' \
    || goal_fail "s12-reconciled" "$S12_GOAL_ID" "a did not move on within 90s of the lock's end (last '$GOAL_WAIT_VALUE'); one reconcile scan period is 60s"
  moved=$(($(date +%s) - unlocked))
  finished=$(psql_ws "select count(*) from outbox where workspace_id='$WORKSPACE_ID' and event_type='TaskUpdated' and payload->>'taskId'='$task' and payload->>'status' in ('completed','failed','cancelled')")
  [ "$GOAL_WAIT_VALUE|$finished" = "succeeded,1|1" ] \
    || goal_fail "s12-reconciled" "$S12_GOAL_ID" "a reads '$GOAL_WAIT_VALUE' with $finished TaskUpdated event(s) ending its Task, expected succeeded on its one attempt with only the lost one"
  [ "$moved" -le 75 ] || goal_fail "s12-reconciled" "$S12_GOAL_ID" "a moved on ${moved}s after the lock's end, expected within one reconcile scan (60s) and the polls"
  pass "s12-reconciled" "the reconcile scan found the run: a succeeded ${moved}s after the lock ended (one scan period is 60s), its Task having ended with that one, lost, TaskUpdated"

  goal_wait "$S12_GOAL_ID" 240 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s12-achieved" "$S12_GOAL_ID" "goal $S12_GOAL_ID did not settle within 240s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "completed,achieved,verified_by_check," ] || goal_fail "s12-achieved" "$S12_GOAL_ID" "goal $S12_GOAL_ID ended '$GOAL_WAIT_VALUE', expected completed,achieved,verified_by_check"
  steps=$(goal_get "$S12_GOAL_ID" "d.result.steps.map((s) => s.stepKey + ':' + s.status + ':' + s.attempts.length).sort().join(',')")
  per=$(goal_one_task_per_attempt "$S12_GOAL_ID")
  [ "$steps|$per" = "a:succeeded:1,b:succeeded:1|ok" ] || goal_fail "s12-achieved" "$S12_GOAL_ID" "steps '$steps', Tasks per attempt '$per' — expected both succeeded on one attempt, one Task each"
  pass "s12-achieved" "goal $S12_GOAL_ID completed(achieved) on its own: b ran after a, one attempt and one Task each"
}

# --- S8: a revision removes a running step ----------------------------------------------------
#
# Plan: a asks for three test-ledger writes — <k>-1, <k>-2, then <k>-3 (goal_three_writes in
# fake-llm) — and b runs after a. The first two each wait out the kernel's await budget and stay
# pending; the turn that would ask for the third is held at fake-llm, so a's Worker is alive and its
# Task running when alice pauses the goal (a revision needs it paused) and revises the plan to one
# new step c, dropping a and b:
#   - s8t, a terminated (the default): its Task is terminated and both pending writes withdrawn in
#     the revision; the third is never asked; nothing is written. Resumed, c runs and the goal
#     completes.
#   - s8l, a let finish, <k>-1 released: <k>-2 is withdrawn, <k>-1 kept for alice to decide. The
#     hold is released: a's Worker asks for <k>-3 and the kernel refuses it (I-G9: a superseded step
#     takes no new work), then reports; a's Task completes with its result recorded, and a stays
#     superseded — its result moves nothing. Resumed, c runs, but the run does not verify while the
#     released <k>-1 still awaits a decision; alice approves it, it runs once, the goal completes.
# Not covered here (advancer.integration.test.ts covers both): nested child Tasks of a — the fake
# Worker raises none — and a request already executing when the revision comes.

# goal_s8_start <variant>: proposes and confirms the plan, waits until a's Worker has its two writes
# pending and is held before the third, then pauses the goal. Sets S8_GOAL_ID, S8_KEY, S8_HOLD,
# S8_NONCE, S8_TASK, S8_AR1, S8_AR2.
goal_s8_start() {
  S8_NONCE=$(real_token)
  S8_KEY="$1-$S8_NONCE"
  S8_HOLD="$1-$S8_NONCE-a"
  a=$(goal_step_json a "ACCEPT_S2_SCENARIO=goal_three_writes LEDGER_KEY=$S8_KEY HOLD=$S8_HOLD")
  b=$(goal_step_json b "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$S8_NONCE STEP=b" '"dependsOn":["a"]')
  GOAL_HOLDS="$GOAL_HOLDS $S8_HOLD"
  goal_propose_confirm "$1" "{\"statement\":\"accept_s2 S8 $S8_NONCE ($1): one ops-runner step asks for three test-ledger entries, another runs after it; the plan is revised while the first one runs.\",\"plan\":{\"steps\":[$a,$b],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-$1-$S8_NONCE\"}"
  S8_GOAL_ID=$GOAL_RUN_ID
  pass "$1-confirmed" "alice proposed and confirmed goal $S8_GOAL_ID (a asks for $S8_KEY-1, -2, -3; b after a)"

  # Each of the first two writes waits out the kernel's await budget (about 25s) before the next turn.
  fake_llm_wait_hold "$S8_HOLD" 240 || goal_fail "$1-running" "$S8_GOAL_ID" "a's Worker did not reach its held third turn within 240s (fake-llm holds '$(fake_llm_holds)')"
  S8_TASK=$(goal_step_task "$S8_GOAL_ID" a 1)
  run=$(goal_get "$S8_GOAL_ID" "(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [d.result.status, s.a.status, s.a.actions.map((x) => x.status).join('+'), s.b.attempts.length].join(','); })()")
  task_status=$(goal_task_status "$S8_TASK")
  case "$task_status" in running | waiting_approval) : ;; *) task_status="$task_status (not live)" ;; esac
  [ "$run|$task_status" = "running,running,pending_approval+pending_approval,0|running" ] || [ "$run|$task_status" = "running,running,pending_approval+pending_approval,0|waiting_approval" ] \
    || goal_fail "$1-running" "$S8_GOAL_ID" "read '$run' with a's Task '$task_status', expected the run and a running, a's two writes pending approval, b not started, a's Task live"
  S8_AR1=$(goal_get "$S8_GOAL_ID" "d.result.steps.find((x) => x.stepKey === 'a').actions[0].actionRequestId")
  S8_AR2=$(goal_get "$S8_GOAL_ID" "d.result.steps.find((x) => x.stepKey === 'a').actions[1].actionRequestId")
  pass "$1-running" "a's Worker asked for $S8_KEY-1 ($S8_AR1) and $S8_KEY-2 ($S8_AR2), both pending approval, and is held before the third; its Task $S8_TASK is $task_status"

  out=$(cap "$ALICE_KEY" pause_goal "{\"goalRunId\":\"$S8_GOAL_ID\"}" "[d.result.status, d.result.changed].join(',')")
  [ "$(parse_kv "$out" HTTP_STATUS)|$(parse_kv "$out" EXTRACTED)" = "200|paused,true" ] \
    || goal_fail "$1-revised" "$S8_GOAL_ID" "pause_goal answered HTTP $(parse_kv "$out" HTTP_STATUS) '$(parse_kv "$out" EXTRACTED)', expected 200 paused,true: $(parse_kv "$out" BODY)"
}

# goal_s8_revise <variant> [removals JSON]: revises the paused goal to the single new step c, a
# and b dropped. Leaves revise_goal's answer — revision, how many StepRuns it superseded and
# created, the requests it withdrew and released (sorted) — in S8_REVISED.
goal_s8_revise() {
  c=$(goal_step_json c "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$S8_NONCE STEP=c")
  out=$(cap "$ALICE_KEY" revise_goal "{\"goalRunId\":\"$S8_GOAL_ID\",\"basedOnRevision\":1,\"plan\":{\"steps\":[$c],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"reason\":\"accept_s2 S8: a and b dropped while a runs\"${2:+,\"removals\":$2}}" \
    "[d.result.revision, d.result.supersededStepRunIds.length, d.result.createdStepRunIds.length, d.result.withdrawnActionRequestIds.slice().sort().join('+'), d.result.releasedActionRequestIds.slice().sort().join('+')].join(',')")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "$1-revised" "$S8_GOAL_ID" "revise_goal HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  S8_REVISED=$(parse_kv "$out" EXTRACTED)
}

# goal_s8_resume <variant>: alice resumes the goal.
goal_s8_resume() {
  out=$(cap "$ALICE_KEY" resume_goal "{\"goalRunId\":\"$S8_GOAL_ID\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "$1-achieved" "$S8_GOAL_ID" "resume_goal HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
}

goal_s8_terminate() {
  goal_s8_start s8t
  goal_s8_revise s8t
  case "$S8_REVISED" in
    "2,2,1,$S8_AR1+$S8_AR2," | "2,2,1,$S8_AR2+$S8_AR1,") : ;;
    *) goal_fail "s8t-revised" "$S8_GOAL_ID" "revise_goal answered '$S8_REVISED' (revision, superseded, created, withdrawn, released), expected revision 2, a and b superseded, c created, both $S8_AR1 and $S8_AR2 withdrawn, none released" ;;
  esac
  pass "s8t-revised" "alice paused goal $S8_GOAL_ID and revised it to c alone: a and b superseded, a's writes $S8_AR1 and $S8_AR2 withdrawn in the same revision"

  # The revision sets the paused run due at once; that advance terminates a's Task after its commit
  # — the Task first, then (once worker-supervisor has stopped it) its WorkerRun.
  deadline=$(($(date +%s) + 60))
  while :; do
    task_status=$(goal_task_status "$S8_TASK")
    runs=$(psql_ws "select coalesce(string_agg(status, ','), 'none') from worker_runs where workspace_id='$WORKSPACE_ID' and task_id='$S8_TASK'")
    [ "$task_status|$runs" = "cancelled|terminated" ] && break
    case "$task_status" in completed | failed) break ;; esac
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 2
  done
  [ "$task_status|$runs" = "cancelled|terminated" ] || goal_fail "s8t-terminated" "$S8_GOAL_ID" "60s after the revision a's Task $S8_TASK reads '$task_status' with WorkerRun(s) '$runs', expected cancelled with its WorkerRun terminated"
  fake_llm_release "$S8_HOLD" >/dev/null
  sleep 5
  counts="$(ledger_count "$S8_KEY-1"),$(ledger_count "$S8_KEY-2"),$(ledger_count "$S8_KEY-3")"
  writes=$(psql_ws "select count(*) from action_requests where workspace_id='$WORKSPACE_ID' and step_run_id=(select id from step_runs where workspace_id='$WORKSPACE_ID' and goal_run_id='$S8_GOAL_ID' and step_key='a')")
  a=$(goal_get "$S8_GOAL_ID" "(() => { const s = d.result.steps.find((x) => x.stepKey === 'a'); return [s.status, s.attempts.map((t) => t.status).join('+'), s.actions.map((x) => x.status).join('+')].join(','); })()")
  [ "$a|$writes|$counts" = "superseded,cancelled,withdrawn+withdrawn|2|0,0,0" ] \
    || goal_fail "s8t-terminated" "$S8_GOAL_ID" "a reads '$a' with $writes request(s), ledger counts (-1,-2,-3) '$counts' — expected superseded, its one attempt cancelled, its two writes withdrawn, no third request, nothing written"
  pass "s8t-terminated" "a's Task $S8_TASK was terminated (cancelled, WorkerRun terminated) while its Worker was held; its two writes stay withdrawn, it never asked for the third, the ledger holds nothing under $S8_KEY"

  goal_s8_resume s8t
  goal_wait "$S8_GOAL_ID" 240 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s8t-achieved" "$S8_GOAL_ID" "goal $S8_GOAL_ID did not settle within 240s of resume_goal (last '$GOAL_WAIT_VALUE')"
  steps=$(goal_get "$S8_GOAL_ID" "d.result.steps.map((s) => s.stepKey + ':' + s.status + ':' + s.attempts.length).sort().join(',')")
  per=$(goal_one_task_per_attempt "$S8_GOAL_ID")
  [ "$GOAL_WAIT_VALUE|$steps|$per" = "completed,achieved,verified_by_check,|a:superseded:1,b:superseded:0,c:succeeded:1|ok" ] \
    || goal_fail "s8t-achieved" "$S8_GOAL_ID" "goal '$GOAL_WAIT_VALUE', steps '$steps', Tasks per attempt '$per' — expected completed(achieved) on c alone, a and b superseded, b never started"
  pass "s8t-achieved" "alice resumed goal $S8_GOAL_ID; it completed(achieved) on c alone — a superseded after its one attempt, b never started"
}

goal_s8_let_finish() {
  goal_s8_start s8l
  goal_s8_revise s8l "{\"a\":{\"mode\":\"let_finish\",\"release\":[\"$S8_AR1\"]}}"
  [ "$S8_REVISED" = "2,2,1,$S8_AR2,$S8_AR1" ] || goal_fail "s8l-revised" "$S8_GOAL_ID" "revise_goal answered '$S8_REVISED', expected '2,2,1,$S8_AR2,$S8_AR1' (revision 2, a and b superseded, c created, $S8_KEY-2 withdrawn, $S8_KEY-1 released)"
  released_audit=$(psql_ws "select count(*) from audit_records where workspace_id='$WORKSPACE_ID' and resource_type='action_request' and resource_id='$S8_AR1' and action='action_request.release'")
  [ "$released_audit" = "1" ] || goal_fail "s8l-revised" "$S8_GOAL_ID" "the release of $S8_AR1 has $released_audit audit row(s), expected 1"
  pass "s8l-revised" "alice paused goal $S8_GOAL_ID and revised it to c alone, letting a finish: $S8_KEY-2 ($S8_AR2) withdrawn, $S8_KEY-1 ($S8_AR1) released and audited"

  [ "$(fake_llm_release "$S8_HOLD")" = "1" ] || goal_fail "s8l-finished" "$S8_GOAL_ID" "releasing a's held turn did not release exactly one request (its Worker gone?)"
  deadline=$(($(date +%s) + 90))
  while :; do
    task_status=$(goal_task_status "$S8_TASK")
    case "$task_status" in completed | failed | cancelled) break ;; esac
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 2
  done
  step_a=$(psql_ws "select id from step_runs where workspace_id='$WORKSPACE_ID' and goal_run_id='$S8_GOAL_ID' and step_key='a'")
  # The kernel's own record of the refusal (gateway/dispatch.ts auditGoalStepClosed): the call
  # rolled back, so this audit row is all that is left of it.
  refused=$(psql_ws "select count(*) from audit_records where workspace_id='$WORKSPACE_ID' and resource_type='step_run' and resource_id='$step_a' and action='request_action' and payload->>'outcome'='refused' and payload->'refusal'->>'code'='goal_step_closed' and payload->'refusal'->>'stepStatus'='superseded'")
  recorded=$(psql_ws "select count(*) from audit_records where workspace_id='$WORKSPACE_ID' and resource_type='task' and resource_id='$S8_TASK' and action='task.complete'")
  writes=$(psql_ws "select count(*) from action_requests where workspace_id='$WORKSPACE_ID' and step_run_id='$step_a'")
  a=$(goal_get "$S8_GOAL_ID" "(() => { const s = d.result.steps.find((x) => x.stepKey === 'a'); return [s.status, s.attempts.map((t) => t.status).join('+'), s.actions.map((x) => x.status).join('+')].join(','); })()")
  [ "$task_status|$recorded|$refused|$a|$writes" = "completed|1|1|superseded,completed,pending_approval+withdrawn|2" ] \
    || goal_fail "s8l-finished" "$S8_GOAL_ID" "after the release a's Task reads '$task_status' (completion audited $recorded time(s)), $refused refused request_action audited on a, a '$a' with $writes request(s) — expected the Task completed and audited, one request_action refused because a is superseded (I-G9), a still superseded, $S8_KEY-1 pending, $S8_KEY-2 withdrawn, no third request"
  # What the Worker was told, as it reported it (evidence only; the audit row above is the check).
  third=$(psql_ws "select coalesce((select left(f, 160) from jsonb_array_elements_text(result->'findings') f where f like '$S8_KEY-3: %' limit 1), 'not in its report') from tasks where workspace_id='$WORKSPACE_ID' and id='$S8_TASK'")
  pass "s8l-finished" "a's Worker asked for $S8_KEY-3 after the revision and the kernel refused it (I-G9, audited on a; the Worker reported '${third#"$S8_KEY-3: "}'); its Task completed with its result recorded, a stays superseded with no third request"

  goal_s8_resume s8l
  c_expr="(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [d.result.status, s.c.status].join(','); })()"
  goal_wait "$S8_GOAL_ID" 180 "$c_expr" '*,succeeded' '*,failed' 'paused,*' 'cancelled,*' 'failed,*' 'completed,*' \
    || goal_fail "s8l-released-holds" "$S8_GOAL_ID" "c did not settle within 180s of resume_goal (last '$GOAL_WAIT_VALUE')"
  sleep 10
  run=$(goal_get "$S8_GOAL_ID" "(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [d.result.status, s.c.status, s.a.actions.map((x) => x.status).join('+')].join(','); })()")
  [ "$run|$(ledger_count "$S8_KEY-1")" = "running,succeeded,pending_approval+withdrawn|0" ] \
    || goal_fail "s8l-released-holds" "$S8_GOAL_ID" "10s after c succeeded the goal reads '$run' with ledger count under $S8_KEY-1 '$(ledger_count "$S8_KEY-1")', expected still running (not verifying) on the released write, pending, nothing written"
  pass "s8l-released-holds" "c succeeded, and the goal stays running: it does not verify while the released $S8_KEY-1 still awaits a decision"

  out=$(cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$S8_AR1\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s8l-achieved" "$S8_GOAL_ID" "approve($S8_AR1) HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  goal_wait "$S8_GOAL_ID" 240 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s8l-achieved" "$S8_GOAL_ID" "goal $S8_GOAL_ID did not settle within 240s of the approval (last '$GOAL_WAIT_VALUE')"
  counts="$(ledger_count "$S8_KEY-1"),$(ledger_count "$S8_KEY-2"),$(ledger_count "$S8_KEY-3")"
  steps=$(goal_get "$S8_GOAL_ID" "d.result.steps.map((s) => s.stepKey + ':' + s.status + ':' + s.attempts.length + ':' + s.actions.map((x) => x.status).join('+')).sort().join(',')")
  per=$(goal_one_task_per_attempt "$S8_GOAL_ID")
  [ "$GOAL_WAIT_VALUE|$steps|$counts|$per" = "completed,achieved,verified_by_check,|a:superseded:1:executed+withdrawn,b:superseded:0:,c:succeeded:1:|1,0,0|ok" ] \
    || goal_fail "s8l-achieved" "$S8_GOAL_ID" "goal '$GOAL_WAIT_VALUE', steps '$steps', ledger counts (-1,-2,-3) '$counts', Tasks per attempt '$per' — expected completed(achieved), the released write run once, the withdrawn one and the refused one never"
  pass "s8l-achieved" "alice approved the released $S8_KEY-1; it ran once (ledger 1 at the gate) and goal $S8_GOAL_ID completed(achieved); $S8_KEY-2 and $S8_KEY-3 never ran (ledger 0 and 0)"
}

# --- S2: the kernel crashes, twice, and worker-supervisor restarts while a goal runs -------------
#
# Plan: a, then b, then c, each after the one before, each step's Worker reporting done; a's and
# b's model turns are held at fake-llm until the script releases them.
#   (a) The kernel is killed (SIGKILL: a crash, not a shutdown) and started again while a's Worker
#       is held mid model call: when the kernel is back, a's Task and WorkerRun are the same ones,
#       still running. Released, a's Worker reports to the new kernel.
#   (b) The kernel is killed in the middle of an advance: before a's turn is released, b's StepRun
#       row is locked (goal_row_lock_take), so the advance a's end sets off — it locks the run's
#       row, then every step's row in order — stops on b's, its transaction open, the run's row
#       held. The kernel is killed in that state and started again; then the lock is ended, the dead
#       advance's transaction rolls back (its backend finds its client gone once it is granted the
#       row and tries to answer), and the new kernel's advancer takes the run when the dead claim's
#       lease runs out (60 s): b starts once — one attempt, one Task.
#   (c) worker-supervisor is restarted while b's Worker is held: once it answers /healthz again (it
#       re-adopts running Task containers before it listens) and the kernel's Task reaper has looked
#       at least once (every 30 s), b's Task and WorkerRun are the same ones, still running.
#       Released, b reports; c runs; the goal completes(achieved).
# Throughout: every attempt has exactly one Task (I-G1), no step is skipped, each starts after the
# one before it ended. S2 runs last: the kernel's restarts drop every connection to it (the entry
# agents' included), and nothing after it but cleanup_step needs them.

goal_s2_restarts() {
  n=$(real_token)
  hold_a="s2-$n-a"
  hold_b="s2-$n-b"
  lock="s2-$n-b"
  a=$(goal_step_json a "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=a HOLD=$hold_a")
  b=$(goal_step_json b "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=b HOLD=$hold_b" '"dependsOn":["a"]')
  c=$(goal_step_json c "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=c" '"dependsOn":["b"]')
  GOAL_HOLDS="$GOAL_HOLDS $hold_a $hold_b"
  goal_propose_confirm s2 "{\"statement\":\"accept_s2 S2 $n: three ops-runner steps report one after the other while the kernel is killed twice and worker-supervisor restarted.\",\"plan\":{\"steps\":[$a,$b,$c],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s2-$n\"}"
  S2_GOAL_ID=$GOAL_RUN_ID
  pass "s2-confirmed" "alice proposed and confirmed goal $S2_GOAL_ID (a, b, c in turn; a and b held at fake-llm until released)"

  # (a) a's Worker held mid model call; the kernel crashes and comes back.
  fake_llm_wait_hold "$hold_a" 180 || goal_fail "s2-kernel-killed-task" "$S2_GOAL_ID" "a's Worker did not reach its held turn within 180s (fake-llm holds '$(fake_llm_holds)')"
  task_a=$(goal_step_task "$S2_GOAL_ID" a 1)
  run_a=$(psql_ws "select id from worker_runs where workspace_id='$WORKSPACE_ID' and task_id='$task_a'")
  goal_kernel_kill_restart s2-kernel-killed-task
  # A Worker's model call goes to llm-proxy, not through the kernel: the kill must not cut it.
  # fake-llm's counts for a's turn say whether it did — one request held, none dropped. (Staging
  # runs one and two saw it dropped 10 s after it began: llm-proxy's wait for an upstream's
  # response headers, which fake-llm now sends before holding.) The wait covers fake-llm being slow
  # to answer `docker compose exec` right after the restart.
  fake_llm_wait_hold "$hold_a" 30 || goal_fail "s2-kernel-killed-task" "$S2_GOAL_ID" "fake-llm does not hold a's turn ${GOAL_RESTART_SECONDS}s after the kill (its counts for it: $(fake_llm_hold_counts "$hold_a"); a's Task reads '$(goal_task_status "$task_a")')"
  counts_a=$(fake_llm_hold_counts "$hold_a")
  [ "$counts_a" = "held=1 dropped=0" ] || goal_fail "s2-kernel-killed-task" "$S2_GOAL_ID" "fake-llm's counts for a's turn read '$counts_a' after the kill, expected held=1 dropped=0: a's model call goes to llm-proxy, not through the kernel, and the kill must not cut it (a's Task reads '$(goal_task_status "$task_a")')"
  after="$(goal_task_status "$task_a"),$(psql_ws "select status from worker_runs where workspace_id='$WORKSPACE_ID' and id='$run_a'"),$(goal_tasks "$S2_GOAL_ID")"
  [ "$after" = "running,running,1" ] || goal_fail "s2-kernel-killed-task" "$S2_GOAL_ID" "with the kernel back, a's Task $task_a, its WorkerRun $run_a and the run's Task count read '$after', expected the same Task and WorkerRun still running and one Task"
  pass "s2-kernel-killed-task" "the kernel was killed (SIGKILL) while a's Worker was held mid model call and was healthy again in ${GOAL_RESTART_SECONDS}s: a's Task $task_a and its WorkerRun $run_a are the same, still running, the run has one Task; its model call stayed held throughout ($counts_a)"

  # (b) The advance a's end sets off stops on b's locked row; the kernel crashes inside it.
  b_row=$(psql_ws "select id from step_runs where workspace_id='$WORKSPACE_ID' and goal_run_id='$S2_GOAL_ID' and step_key='b'")
  # 180 s: up to 45 s below, the kernel's restart (up to 120 s) and the checks after it pass with it
  # held — it must not end on its own while the kernel is down (review #488 on #817).
  goal_row_lock_take "$lock" step_runs "$b_row" 180 || goal_fail "s2-kernel-killed-advance" "$S2_GOAL_ID" "could not lock b's StepRun row $b_row within 10s"
  goal_release_running s2-kernel-killed-advance "$S2_GOAL_ID" "$hold_a" "$task_a" "$lock"
  # Both: a's Task completed and an advance waiting on b's row — the one its end set off (the run
  # has nothing else to advance for: its next tick is its wall-clock deadline).
  deadline=$(($(date +%s) + 45))
  while :; do
    waiting=$(goal_row_lock_waiters "$lock" 'from step_runs')
    task_a_status=$(goal_task_status "$task_a")
    [ "$waiting|$task_a_status" = "1|completed" ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      goal_row_lock_release "$lock" >/dev/null
      goal_fail "s2-kernel-killed-advance" "$S2_GOAL_ID" "45s after a's turn was released: $waiting session(s) waiting on b's locked row, a's Task '$task_a_status' — expected one advance waiting there and a's Task completed"
    fi
    sleep 1
  done
  reported=$(goal_task_reported "$task_a" "$n")
  [ "$reported" = "ok" ] || { goal_row_lock_release "$lock" >/dev/null; goal_fail "s2-kernel-killed-advance" "$S2_GOAL_ID" "a's Task $task_a completed with summary '$reported', expected fake-llm's scripted report: the held turn's answer did not reach its Worker"; }
  goal_kernel_kill_restart s2-kernel-killed-advance
  # A session blocked on a row lock does not notice that its client is gone, so the dead kernel's
  # advance still waits there (with the run's own row, which it locked first) until it gets the row.
  zombie=$(goal_row_lock_waiters "$lock" 'from step_runs')
  held=$(goal_row_lock_held "$lock")
  b_before=$(psql_ws "select count(*) from tasks where workspace_id='$WORKSPACE_ID' and step_run_id='$b_row'")
  unlocked=$(date +%s)
  ended=$(goal_row_lock_release "$lock")
  [ "$held|$zombie" = "1|1" ] || goal_fail "s2-kernel-killed-advance" "$S2_GOAL_ID" "with the kernel back, the lock on b's row read held '$held' with $zombie session(s) waiting on it — expected it still held and the dead advance's session still waiting there"
  [ "$b_before" = "0" ] || goal_fail "s2-kernel-killed-advance" "$S2_GOAL_ID" "b has $b_before Task(s) before the lock on its row ended, expected none (the advance that would start it was stopped on that row)"
  pass "s2-kernel-killed-advance" "a's Task completed with its held turn's report; the advance its end set off stopped on b's locked row with its transaction open; the kernel was killed in it and healthy again in ${GOAL_RESTART_SECONDS}s; the dead advance still waited on the row ($zombie waiting) until the lock was ended ($ended); b had no Task"

  fake_llm_wait_hold "$hold_b" 150 || goal_fail "s2-advance-redone" "$S2_GOAL_ID" "b's Worker did not reach its held turn within 150s of the lock's end (the dead claim's lease is 60s; fake-llm holds '$(fake_llm_holds)')"
  took=$(($(date +%s) - unlocked))
  task_b=$(goal_step_task "$S2_GOAL_ID" b 1)
  steps=$(goal_get "$S2_GOAL_ID" "['a', 'b', 'c'].map((k) => { const s = d.result.steps.find((x) => x.stepKey === k); return k + ':' + s.status + ':' + s.attempts.length; }).join(',')")
  per=$(goal_one_task_per_attempt "$S2_GOAL_ID")
  [ "$steps|$per" = "a:succeeded:1,b:running:1,c:pending:0|ok" ] \
    || goal_fail "s2-advance-redone" "$S2_GOAL_ID" "steps '$steps', Tasks per attempt '$per' — expected a succeeded on its one attempt, b running its first, c not started, one Task per attempt"
  pass "s2-advance-redone" "the new kernel advanced the run ${took}s after the lock ended: a succeeded on its one attempt, b started once (Task $task_b), one Task per attempt"

  # (c) b's Worker held; worker-supervisor restarts.
  run_b=$(psql_ws "select id from worker_runs where workspace_id='$WORKSPACE_ID' and task_id='$task_b'")
  goal_supervisor_restart s2-supervisor-restarted
  sleep 35
  after="$(goal_task_status "$task_b"),$(psql_ws "select status from worker_runs where workspace_id='$WORKSPACE_ID' and id='$run_b'"),$(goal_tasks "$S2_GOAL_ID")"
  case ",$(fake_llm_holds)," in
    *",$hold_b,"*) : ;;
    *) goal_fail "s2-supervisor-restarted" "$S2_GOAL_ID" "fake-llm no longer holds b's turn after the restart (it answers a held turn itself after 120s; b's Task reads '$(goal_task_status "$task_b")')" ;;
  esac
  [ "$after" = "running,running,2" ] || goal_fail "s2-supervisor-restarted" "$S2_GOAL_ID" "35s after worker-supervisor was back, b's Task $task_b, its WorkerRun $run_b and the run's Task count read '$after', expected the same Task and WorkerRun still running and two Tasks"
  pass "s2-supervisor-restarted" "worker-supervisor restarted while b's Worker was held and answered /healthz in ${GOAL_RESTART_SECONDS}s; 35s later (past one Task-reaper look) b's Task $task_b and its WorkerRun $run_b are the same, still running"

  goal_release_running s2-achieved "$S2_GOAL_ID" "$hold_b" "$task_b"
  goal_wait "$S2_GOAL_ID" 300 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s2-achieved" "$S2_GOAL_ID" "goal $S2_GOAL_ID did not settle within 300s of b's release (last '$GOAL_WAIT_VALUE')"
  steps=$(goal_get "$S2_GOAL_ID" "d.result.steps.map((s) => s.stepKey + ':' + s.status + ':' + s.attempts.length).sort().join(',')")
  order=$(goal_get "$S2_GOAL_ID" "(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); const start = (k) => Date.parse(s[k].attempts[0].createdAt); const end = (k) => Date.parse(s[k].endedAt); return start('b') >= end('a') && start('c') >= end('b') ? 'in-turn' : 'out-of-turn'; })()")
  per=$(goal_one_task_per_attempt "$S2_GOAL_ID")
  reported=$(goal_task_reported "$task_b" "$n")
  [ "$GOAL_WAIT_VALUE|$steps|$order|$per|$reported" = "completed,achieved,verified_by_check,|a:succeeded:1,b:succeeded:1,c:succeeded:1|in-turn|ok|ok" ] \
    || goal_fail "s2-achieved" "$S2_GOAL_ID" "goal '$GOAL_WAIT_VALUE', steps '$steps', order '$order', Tasks per attempt '$per', b's summary '$reported' — expected completed(achieved), every step succeeded on one attempt in turn, one Task each, b's Task $task_b with fake-llm's scripted report"
  pass "s2-achieved" "goal $S2_GOAL_ID completed(achieved) through two kernel crashes and a worker-supervisor restart: a, b, c each succeeded on one attempt, each after the one before, one Task each; b's Task $task_b completed with its held turn's report"
}

# --- S14: a step reads the files an earlier step of the same goal left (S11 GO14) -------------

# goal_supervisor_keep <taskId> <goalRunId>: what worker-supervisor says the Task's directories are
# to a reader in this workspace and <goalRunId> — `POST /task-dirs/keep` with the kernel's own
# internal token, from inside the kernel container (the call the advancer and the retention lease
# make). Prints the state, or `HTTP <status> <body>` when the call did not answer one.
goal_supervisor_keep() {
  compose_accept exec -T kernel node -e "
const token = require('fs').readFileSync('/run/secrets/internal_token_worker_supervisor', 'utf8').trim();
fetch('http://worker-supervisor:8081/task-dirs/keep', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify({ tasks: [{ taskId: '$1', workspaceId: '$WORKSPACE_ID', goalRunId: '$2' }] }),
}).then(async (r) => {
  const text = await r.text();
  let state;
  try { state = JSON.parse(text).tasks[0].state; } catch {}
  console.log(r.status === 200 && state ? state : 'HTTP ' + r.status + ' ' + text.slice(0, 300));
}, (err) => console.log('unreachable ' + err));
" </dev/null 2>&1
}

# Two ops-runner steps on fake-llm's goal_handoff script: `a` writes a token of this run into
# /workspace/out/handoff.txt; `b` depends on `a`, names it in `filesFrom` and — its input carries no
# token, no binding takes a's output — reads /upstream/a/handoff.txt, then tries to write beside it.
#   - handoff: the goal completes on its own; b's stored summary carries exactly the token a wrote,
#     and the write beside it failed (the mount is read-only);
#   - handoff-audit: b's Task was queued naming a's accepted attempt's Task (`task.queue`
#     `upstreamFiles`), and b's attempt started with `filesFrom` [a] (`step_run.start`);
#   - handoff-owner: worker-supervisor answers `kept` for a's directories asked about for this
#     goal run, and `not_owned` for the same Task asked about for another goal run of the workspace
#     (S1's) — the owner marker it wrote at a's spawn, a second line behind the kernel's choice.
goal_s14_handoff() {
  n=$(real_token)
  token="s14-$n"
  # The mark is named HANDOFF_MARK, not …_TOKEN: a plan input reading `X_TOKEN=<value>` is refused
  # as a suspected credential (credentials_in_text), as it should be.
  a=$(goal_step_json a "ACCEPT_S2_SCENARIO=goal_handoff HANDOFF_ROLE=write HANDOFF_MARK=$token")
  b=$(goal_step_json b "ACCEPT_S2_SCENARIO=goal_handoff HANDOFF_ROLE=read" '"dependsOn":["a"],"filesFrom":["a"]')
  goal_propose_confirm s14 "{\"statement\":\"accept_s2 S14 $n: one ops-runner step leaves a file for the next, which reads it from the earlier step's handoff directory.\",\"plan\":{\"steps\":[$a,$b],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s14-$n\"}"
  S14_GOAL_ID=$GOAL_RUN_ID
  goal_wait "$S14_GOAL_ID" 360 "$GOAL_END_EXPR" 'completed,*' 'paused,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s14-handoff" "$S14_GOAL_ID" "goal $S14_GOAL_ID did not settle within 360s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "completed,achieved,verified_by_check," ] || goal_fail "s14-handoff" "$S14_GOAL_ID" "goal $S14_GOAL_ID ended '$GOAL_WAIT_VALUE', expected completed,achieved,verified_by_check"
  task_a=$(goal_step_task "$S14_GOAL_ID" a 1)
  task_b=$(goal_step_task "$S14_GOAL_ID" b 1)
  [ -n "$task_a" ] && [ -n "$task_b" ] || goal_fail "s14-handoff" "$S14_GOAL_ID" "no Task for the first attempt of a ('$task_a') or b ('$task_b')"
  summary=$(psql_ws "select coalesce(result->>'summary', '(none)') from tasks where workspace_id = '$WORKSPACE_ID' and id = '$task_b'")
  case "$summary" in
    *"HANDOFF_READ=[$token]"*) : ;;
    *) goal_fail "s14-handoff" "$S14_GOAL_ID" "b's Task $task_b reported '$summary', expected it to have read '$token' from /upstream/a/handoff.txt" ;;
  esac
  case "$summary" in
    *"HANDOFF_WRITE_EXIT=0"*) goal_fail "s14-handoff" "$S14_GOAL_ID" "b's Worker wrote into /upstream/a, which is mounted read-only: '$summary'" ;;
    *"HANDOFF_WRITE_EXIT="[1-9]*) : ;;
    *) goal_fail "s14-handoff" "$S14_GOAL_ID" "b's Task $task_b reported '$summary', expected the exit code of its write beside the file" ;;
  esac
  pass "s14-handoff" "goal $S14_GOAL_ID completed: b read the token a left in its handoff directory, and could not write there"

  queued=$(psql_ws "select coalesce(payload->'upstreamFiles'->0->>'stepKey', '') || ':' || coalesce(payload->'upstreamFiles'->0->>'taskId', '') || ':' || coalesce(jsonb_array_length(payload->'upstreamFiles'), 0) from audit_records where workspace_id = '$WORKSPACE_ID' and resource_id = '$task_b' and action = 'task.queue'")
  [ "$queued" = "a:$task_a:1" ] || goal_fail "s14-handoff-audit" "$S14_GOAL_ID" "b's task.queue audit names upstream files '$queued', expected a's Task $task_a alone"
  started=$(psql_ws "select coalesce(string_agg(r.payload->>'filesFrom', ';'), '') from audit_records r join step_runs s on s.workspace_id = r.workspace_id and s.id = r.resource_id where r.workspace_id = '$WORKSPACE_ID' and s.goal_run_id = '$S14_GOAL_ID' and s.step_key = 'b' and r.action = 'step_run.start'")
  [ "$started" = '["a"]' ] || goal_fail "s14-handoff-audit" "$S14_GOAL_ID" "b's step_run.start audit reads filesFrom '$started', expected [\"a\"] once"
  pass "s14-handoff-audit" "b's Task was queued naming a's Task $task_a as its upstream files, and b's attempt started with filesFrom [a]"

  own=$(goal_supervisor_keep "$task_a" "$S14_GOAL_ID")
  [ "$own" = "kept" ] || goal_fail "s14-handoff-owner" "$S14_GOAL_ID" "worker-supervisor answered '$own' for a's directories asked about for their own goal run, expected kept"
  other=${S1_GOAL_ID:-}
  [ -n "$other" ] || other=$(psql_ws "select gen_random_uuid()")
  foreign=$(goal_supervisor_keep "$task_a" "$other")
  [ "$foreign" = "not_owned" ] || goal_fail "s14-handoff-owner" "$S14_GOAL_ID" "worker-supervisor answered '$foreign' for a's directories asked about for goal run $other, expected not_owned"
  pass "s14-handoff-owner" "worker-supervisor keeps a's directories for goal $S14_GOAL_ID and answers not_owned for goal $other"
}

# goal_scenarios_step: the scenarios, in the order the header explains; S12 and S2 only with
# ACCEPT_DISRUPTIVE=1.
goal_scenarios_step() {
  goal_planner_model "\"${ACCEPT_S2_MODEL:-fake/fake-echo}\""
  pass "goals-planner-model" "alice's AgentProfile model set to ${ACCEPT_S2_MODEL:-fake/fake-echo}, the model her goal planner runs on (S6, S13)"
  goal_s6_start
  goal_s4_unseen_start
  goal_s1_dag
  goal_s11_reject
  goal_s13_planner
  goal_s14_handoff
  goal_s5_approval
  goal_s4_seen
  goal_s7_cancel_drain
  goal_s9_authority_lost
  goal_s10_budget
  [ "$ACCEPT_DISRUPTIVE" != 1 ] || goal_s12_lost_wake
  goal_s8_terminate
  goal_s8_let_finish
  goal_s6_finish
  goal_s4_unseen_finish
  goal_planner_model null
  pass "goals-planner-model-reset" "alice's AgentProfile model back to the workspace's"
  if [ "$ACCEPT_DISRUPTIVE" = 1 ]; then
    goal_s2_restarts
  else
    echo "NOTE goal-disruptive S12 (row lock on a goal) and S2 (kernel killed twice, worker-supervisor restarted) not run: ACCEPT_DISRUPTIVE=${ACCEPT_DISRUPTIVE:-unset}, not 1 — on the production host only in the window, after victor agrees on the spot (docs/runbooks/host-accept-s2.md)"
  fi
}

# --- --real: the test ledger stays out of a real model's tools (review #488 on #806) ------------
#
# Only the fake path's scenarios above use the ledger. Published, it would sit in the entry agent's
# tool list next to `stock.get` (as accept_s2_api_ledger_get, and ledger.add among the execute
# tools) and give a real model asked what the test API's GET returns a second GET to pick — a paid
# run lost to the fixture, not to the model. So with --real, connections_step discards the
# ledger's import drafts before it publishes the http gate's manifest, then checks that the gate
# publishes stock.get alone.

# goal_ledger_discard_real: discards the http gate's ledger.get / ledger.add drafts as alice (the
# owner); connections_step, --real only, before publish_manifest (which names every draft).
goal_ledger_discard_real() {
  for gld_name in ledger.get ledger.add; do
    gld_out=$(cap "$ALICE_KEY" list_operations "{\"gatekeeperId\":\"$GATEKEEPER_ID_HTTP\"}" \
      "(() => { const o = d.result.items.find((x) => x.name === '$gld_name' && x.status === 'draft' && x.draftDigest); return o ? o.version + ' ' + o.draftDigest : ''; })()")
    [ "$(parse_kv "$gld_out" HTTP_STATUS)" = "200" ] || fail "real-ledger-withheld" "list_operations(http) HTTP $(parse_kv "$gld_out" HTTP_STATUS): $(parse_kv "$gld_out" BODY)"
    gld_draft=$(parse_kv "$gld_out" EXTRACTED)
    [ -n "$gld_draft" ] || fail "real-ledger-withheld" "the http gate has no $gld_name draft to discard (the fixture manifest and the OpenAPI import disagree?): $(parse_kv "$gld_out" BODY)"
    gld_version=${gld_draft%% *}
    gld_digest=${gld_draft#* }
    gld_out=$(cap "$ALICE_KEY" discard_operation_draft \
      "{\"gatekeeperId\":\"$GATEKEEPER_ID_HTTP\",\"name\":\"$gld_name\",\"version\":$gld_version,\"draftDigest\":\"$gld_digest\",\"reason\":\"accept_s2 --real: the test ledger is for the fake path's goal scenarios only\"}" "")
    [ "$(parse_kv "$gld_out" HTTP_STATUS)" = "200" ] || fail "real-ledger-withheld" "discard_operation_draft($gld_name) HTTP $(parse_kv "$gld_out" HTTP_STATUS): $(parse_kv "$gld_out" BODY)"
  done
}

# goal_ledger_withheld_check_real: after publish_manifest, --real only — the http gate's published
# Operations are exactly stock.get, read with the predicate list_allowed_operations (and so every
# agent's tool list) reads them by (listPublishedOperationsForGatekeepers: status 'published'), and
# find_operations offers no ledger either.
goal_ledger_withheld_check_real() {
  glw_published=$(psql_ws "select coalesce(string_agg(identity_key->>'name', ',' order by identity_key->>'name'), '') from objects where workspace_id='$WORKSPACE_ID' and object_type='Operation' and identity_key->>'gatekeeperId'='$GATEKEEPER_ID_HTTP' and properties->>'status'='published'")
  [ "$glw_published" = "stock.get" ] || fail "real-ledger-withheld" "the http gate's published Operations read '$glw_published', expected stock.get alone — with --real the test ledger must not reach the entry agent's tools"
  glw_out=$(cap "$ALICE_KEY" find_operations "{\"need\":\"ledger\"}" "d.result.items.filter((o) => String((o.properties || {}).name).startsWith('ledger.')).length")
  [ "$(parse_kv "$glw_out" HTTP_STATUS)" = "200" ] || fail "real-ledger-withheld" "find_operations('ledger') HTTP $(parse_kv "$glw_out" HTTP_STATUS): $(parse_kv "$glw_out" BODY)"
  [ "$(parse_kv "$glw_out" EXTRACTED)" = "0" ] || fail "real-ledger-withheld" "find_operations('ledger') still offers $(parse_kv "$glw_out" EXTRACTED) ledger Operation(s) after they were discarded"
  pass "real-ledger-withheld" "with --real the http gate publishes stock.get alone: ledger.get and ledger.add were discarded as drafts, so neither an agent's tool list nor find_operations offers them"
}

# goal_cleanup_grants: for cleanup_step — revokes the grants goal_s9_authority_lost gave bob and
# did not get to revoke itself; prints one line each, never fails.
goal_cleanup_grants() {
  for gcg_grant in $S9_GRANTS; do
    gcg_out=$(cap "$ALICE_KEY" revoke_capability "{\"grantId\":\"$gcg_grant\"}" "d.result.status")
    echo "cleanup: bob's grant $gcg_grant — revoke_capability answered HTTP $(parse_kv "$gcg_out" HTTP_STATUS), now '$(parse_kv "$gcg_out" EXTRACTED)'"
  done
}

# goal_end_live <goalRunId>: for cleanup_step — rejects a proposed run, cancels a live one, leaves
# a settled one alone; prints one line, never fails.
goal_end_live() {
  gel_state=$(parse_kv "$(cap "$ALICE_KEY" get_goal "{\"goalRunId\":\"$1\"}" "d.result.status")" EXTRACTED)
  case "$gel_state" in
    proposed) gel_cap=reject_goal; gel_params="{\"goalRunId\":\"$1\",\"revision\":1}" ;;
    running|paused|verifying) gel_cap=cancel_goal; gel_params="{\"goalRunId\":\"$1\"}" ;;
    *) return 0 ;;
  esac
  gel_out=$(cap "$ALICE_KEY" "$gel_cap" "$gel_params" "d.result.status")
  echo "cleanup: goal $1 was $gel_state — $gel_cap answered HTTP $(parse_kv "$gel_out" HTTP_STATUS), now '$(parse_kv "$gel_out" EXTRACTED)'"
}
