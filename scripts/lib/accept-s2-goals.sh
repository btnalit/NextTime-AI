# scripts/lib/accept-s2-goals.sh — S11 GO7a: goal scenarios S1, S4, S5, S6, S7, S9, S10 and S11 of
# docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §7.2, run by scripts/accept_s2.sh in
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
# Each scenario's polls are bounded and each failure carries the goal's own evidence (status,
# pause reason, every step with its attempts and actions, every acceptance check with its attempts
# and last error) in the FAIL line. Every goal proposed here is recorded in GOALS_STARTED, and
# cleanup_step ends whichever is still live (proposed: rejected; running, paused or verifying:
# cancelled — alice is the owner, so bob's too) before the gates go, the same way it ends step 9's,
# and revokes any gate S9 granted bob and did not get to revoke itself.
#
# Order (`goal_scenarios_step`): S6's goal and the reverse half of S4 start first and wait in the
# background on checks that fail on purpose — the platform retries an unmet acceptance check
# (GOAL_ACCEPTANCE_CHECK_MAX_ATTEMPTS / _MAX_DURATION_MS) and an unmet reconcile check
# (GOAL_RECONCILE_CHECK_MAX_ATTEMPTS / _MAX_DURATION_MS) with backoff, by default 5 attempts within
# about 7.5 minutes, before it pauses the run — while S1, S11, S5, S4, S7, S9 and S10 run one after
# the other; S6 and the reverse S4 are finished last. No two scenarios have a Worker running at the
# same time, and no two have a write at the http gate at the same time (S7 reads the gate's queue).
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
#   - S2, S8 and S12 (restarts, a revision removing a running step, a lost wake): the next PR of
#     GO7a.

GOALS_STARTED=""

GOAL_BUDGET='{"maxTokens":200000,"maxSteps":6,"maxRevisions":1,"maxWallClockSeconds":1800}'

# What a failed scenario prints about its goal: one JSON line, read with get_goal.
GOAL_EVIDENCE_EXPR="JSON.stringify({status: d.result.status, pauseReason: d.result.pauseReason, outcome: d.result.outcome, outcomeBasis: d.result.outcomeBasis, steps: d.result.steps.map((s) => ({key: s.stepKey, status: s.status, waiting: s.waitingReason, failure: s.failureCategory, attempts: s.attempts.map((a) => a.status + ':' + (a.failureReason || '')), actions: s.actions.map((x) => x.status + (x.failureKind ? ':' + x.failureKind : ''))})), checks: d.result.acceptance.rounds.flatMap((r) => r.checks.map((c) => [r.round, c.checkKey, c.status, c.attempts, c.lastError])), stepChecks: d.result.acceptance.steps.flatMap((s) => s.rounds.flatMap((r) => r.checks.map((c) => [s.stepKey, r.round, c.checkKey, c.status, c.attempts, c.lastError])))})"

# goal_get <goalRunId> <expr>: get_goal as alice, <expr> evaluated against the parsed body (`d`).
goal_get() {
  parse_kv "$(cap "$ALICE_KEY" get_goal "{\"goalRunId\":\"$1\"}" "$2")" EXTRACTED
}

# goal_fail <name> <goalRunId> <detail>: fail with the goal's evidence attached.
goal_fail() {
  fail "$1" "$3 — evidence: $(goal_get "$2" "$GOAL_EVIDENCE_EXPR")"
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

# goal_propose_confirm <name> <paramsJson> [apiKey]: proposes as alice — or as the holder of
# <apiKey> — (a person's propose_goal, as the console makes it), records the run for cleanup,
# confirms revision 1 as the same person. Sets GOAL_RUN_ID.
goal_propose_confirm() {
  gpc_key=${3:-$ALICE_KEY}
  out=$(cap "$gpc_key" propose_goal "$2" "[d.result.goalRunId, d.result.status, d.result.changed].join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "$1-proposed" "propose_goal HTTP $status: $(parse_kv "$out" BODY)"
  proposed=$(parse_kv "$out" EXTRACTED)
  GOAL_RUN_ID=${proposed%%,*}
  [ "${proposed#*,}" = "proposed,true" ] || fail "$1-proposed" "propose_goal answered '$proposed', expected a new proposed run: $(parse_kv "$out" BODY)"
  GOALS_STARTED="$GOALS_STARTED $GOAL_RUN_ID"
  out=$(cap "$gpc_key" confirm_goal "{\"goalRunId\":\"$GOAL_RUN_ID\",\"revision\":1}" "[d.result.status, d.result.changed].join(',')")
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

# Proposes and confirms a goal whose one step reports done while its acceptance check expects a
# symbol the stock API never shows; waits for the step to finish and the run to verify. The run
# then retries its check in the background (goal_s6_finish picks it up).
goal_s6_start() {
  n=$(real_token)
  goal_propose_confirm s6 "{\"statement\":\"accept_s2 S6 $n: one ops-runner step reports done; the platform reads the test stock API and expects a symbol it never shows.\",\"plan\":{\"steps\":[$(goal_step_json report "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=report")],\"acceptance\":[$(goal_observe_check_json stock-unseen stock.get '{}' symbol '"S6-NEVER"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s6-$n\"}"
  S6_GOAL_ID=$GOAL_RUN_ID
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
# steps, b after a; a writes to the test ledger, so the run holds while the write waits. alice
# (owner) revokes bob's docker gate, then approves a's write: a succeeds, and b, whose Worker would
# need a gate bob no longer holds, never starts — the run pauses authority_lost (step-attempt.ts,
# resolveStepAuthority). The plan's own wording, demoting the requester to a role without the gate,
# meets the same check; advancer.integration.test.ts covers the demoted and the disabled requester.
# bob's grants are revoked again at the end (cleanup_step too, via goal_cleanup_grants).

S9_GRANTS=""

goal_s9_authority_lost() {
  n=$(real_token)
  key="s9-$n"
  for s9_gate in "$GATEKEEPER_ID_SSH" "$GATEKEEPER_ID_HTTP" "$GATEKEEPER_ID_DOCKER"; do
    out=$(cap "$ALICE_KEY" connect_gatekeeper "{\"gatekeeperId\":\"$s9_gate\",\"principalId\":\"$BOB_PRINCIPAL_ID\"}" "d.result.id")
    [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || fail "s9-confirmed" "connect_gatekeeper($s9_gate) for bob HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
    s9_grant=$(parse_kv "$out" EXTRACTED)
    S9_GRANTS="$S9_GRANTS $s9_grant"
  done
  # The last one granted: the docker gate's.
  s9_docker_grant=$s9_grant
  write=$(goal_step_json a "ACCEPT_S2_SCENARIO=goal_ledger LEDGER_KEY=$key")
  after=$(goal_step_json b "ACCEPT_S2_SCENARIO=goal_step GOAL_NONCE=$n STEP=b" '"dependsOn":["a"]')
  goal_propose_confirm s9 "{\"statement\":\"accept_s2 S9 $n: one ops-runner step adds an entry to the test ledger once approved; another runs after it, unless the requester has lost a gate it needs.\",\"plan\":{\"steps\":[$write,$after],\"acceptance\":[$(goal_observe_check_json stock-visible stock.get '{}' symbol '"NXT"')]},\"budget\":$GOAL_BUDGET,\"idempotencyKey\":\"accept-s2-goal-s9-$n\"}" "$BOB_KEY"
  S9_GOAL_ID=$GOAL_RUN_ID
  pass "s9-confirmed" "alice granted bob the ssh, http and docker gates the ops-runner Worker declares; bob proposed and confirmed goal $S9_GOAL_ID (a writes to the test ledger under $key, b after a)"

  wait_expr="(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [d.result.status, s.a.status, s.a.waitingReason || '', s.a.actions.map((a) => a.status).join('+'), s.b.status, s.b.attempts.length].join(','); })()"
  goal_wait "$S9_GOAL_ID" 180 "$wait_expr" 'running,waiting,*' 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s9-revoked" "$S9_GOAL_ID" "step a did not reach waiting within 180s (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "running,waiting,approval,pending_approval,pending,0" ] \
    || goal_fail "s9-revoked" "$S9_GOAL_ID" "goal $S9_GOAL_ID reads '$GOAL_WAIT_VALUE', expected the run running, step a waiting(approval) on its pending write, b not started"
  out=$(cap "$ALICE_KEY" revoke_capability "{\"grantId\":\"$s9_docker_grant\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s9-revoked" "$S9_GOAL_ID" "revoke_capability($s9_docker_grant) HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  [ "$(parse_kv "$out" EXTRACTED)" = "revoked" ] || goal_fail "s9-revoked" "$S9_GOAL_ID" "revoke_capability($s9_docker_grant) answered '$(parse_kv "$out" EXTRACTED)', expected revoked"
  ar_id=$(goal_get "$S9_GOAL_ID" "d.result.steps.find((x) => x.stepKey === 'a').actions[0].actionRequestId")
  out=$(cap "$ALICE_KEY" approve "{\"actionRequestId\":\"$ar_id\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s9-revoked" "$S9_GOAL_ID" "approve HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  pass "s9-revoked" "alice revoked bob's docker gate ($s9_docker_grant) while step a's write waited, then approved the write $ar_id"

  goal_wait "$S9_GOAL_ID" 180 "$GOAL_END_EXPR" 'paused,*' 'completed,*' 'cancelled,*' 'failed,*' \
    || goal_fail "s9-authority-lost" "$S9_GOAL_ID" "goal $S9_GOAL_ID did not settle within 180s of the approval (last '$GOAL_WAIT_VALUE')"
  [ "$GOAL_WAIT_VALUE" = "paused,,,authority_lost" ] || goal_fail "s9-authority-lost" "$S9_GOAL_ID" "goal $S9_GOAL_ID reads '$GOAL_WAIT_VALUE', expected paused authority_lost"
  steps=$(goal_get "$S9_GOAL_ID" "(() => { const s = Object.fromEntries(d.result.steps.map((x) => [x.stepKey, x])); return [s.a.status, s.a.actions.map((a) => a.status).join('+'), s.b.status, s.b.attempts.length].join(','); })()")
  tasks=$(goal_tasks "$S9_GOAL_ID")
  count=$(ledger_count "$key")
  [ "$steps|$tasks|$count" = "succeeded,executed,ready,0|1|1" ] \
    || goal_fail "s9-authority-lost" "$S9_GOAL_ID" "read steps '$steps', $tasks Task(s), ledger count under $key '$count' — expected a succeeded with its write executed, b ready and never started, one Task, one entry"
  pass "s9-authority-lost" "goal $S9_GOAL_ID paused authority_lost: a succeeded (its write ran once), b is ready but never started — bob no longer holds the docker gate its Worker declares; one Task"

  out=$(cap "$BOB_KEY" cancel_goal "{\"goalRunId\":\"$S9_GOAL_ID\"}" "d.result.status")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || goal_fail "s9-cancelled" "$S9_GOAL_ID" "cancel_goal (bob) HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  goal_wait "$S9_GOAL_ID" 60 "d.result.status" 'cancelled' \
    || goal_fail "s9-cancelled" "$S9_GOAL_ID" "goal $S9_GOAL_ID reads '$GOAL_WAIT_VALUE' 60s after cancel_goal, expected cancelled"
  for s9_grant in $S9_GRANTS; do
    [ "$s9_grant" = "$s9_docker_grant" ] && continue
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
# the run budget_exhausted. A goal_ledger step, so the attempt is still running when the usage
# lands: its write has usually reached the gate by then and holds the step waiting(approval) — the
# run pauses all the same, the write is left to the person, and the cancel at the end withdraws it.
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

# goal_scenarios_step: the scenarios, in the order the header explains.
goal_scenarios_step() {
  goal_s6_start
  goal_s4_unseen_start
  goal_s1_dag
  goal_s11_reject
  goal_s5_approval
  goal_s4_seen
  goal_s7_cancel_drain
  goal_s9_authority_lost
  goal_s10_budget
  goal_s6_finish
  goal_s4_unseen_finish
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
