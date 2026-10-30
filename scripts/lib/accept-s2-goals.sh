# scripts/lib/accept-s2-goals.sh — S11 GO7a: goal scenarios S1, S5, S6 and S11 of
# docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §7.2, run by scripts/accept_s2.sh in
# its fake-provider path after step 9 (which covers proposing from chat, confirming, the platform's
# acceptance and S3's idempotent propose/confirm). Sourced by accept_s2.sh right after
# accept-common.sh; POSIX sh, same conventions (pass/fail, cap, parse_kv, no temp file, no jq).
#
# Everything here runs on what accept_s2.sh already set up: alice and her API key, the ops-runner
# Worker (fake model), the http gate in front of the accept-s2 OpenAPI fixture. The fixture's test
# ledger (`ledger.get` observe / `ledger.add` execute with `await_decision`, see
# deploy/accept-s2/openapi-fixture/server.mjs) counts at the gate's side how often a write really
# ran, so S5 and S11 read the effect itself rather than the platform's own record of it. No
# credential is involved beyond the fixture token accept_s2.sh already generates.
#
# Each scenario's polls are bounded and each failure carries the goal's own evidence (status,
# pause reason, every step with its attempts and actions, every acceptance check with its attempts
# and last error) in the FAIL line. Every goal proposed here is recorded in GOALS_STARTED, and
# cleanup_step ends whichever is still live (proposed: rejected; running, paused or verifying:
# cancelled) before the gates go, the same way it ends step 9's.
#
# Order (`goal_scenarios_step`): S6's goal starts first and verifies in the background — its
# acceptance check fails on purpose and the platform retries an unmet check with backoff
# (GOAL_ACCEPTANCE_CHECK_MAX_ATTEMPTS / _MAX_DURATION_MS, by default 5 attempts within about 7.5
# minutes) before it pauses the run — while S1, S11 and S5 run one after the other; S6 is finished
# last. No two scenarios have a Worker running at the same time.
#
# With --real none of these scenarios runs, and the ledger is discarded before the http gate's
# manifest is published (goal_ledger_discard_real / goal_ledger_withheld_check_real, called from
# connections_step), so a real model's tool list holds stock.get alone, as before this file.
#
# Not covered here, and why (docs/runbooks/host-accept-s2.md, goal scenarios):
#   - S5 with `await_decision: false`, and S11's expired approval: neither can be set up on a live
#     stack without changing the kernel's own configuration; advancer.integration.test.ts covers
#     both against real Postgres.
#   - S2, S4, S7 and S12 (restarts, a lost gate response, cancelling with actions in flight, a lost
#     wake) and the S8–S10 smoke: the next PR of GO7a.

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

# goal_propose_confirm <name> <paramsJson>: proposes as alice (a person's propose_goal, as the
# console makes it), records the run for cleanup, confirms revision 1. Sets GOAL_RUN_ID.
goal_propose_confirm() {
  out=$(cap "$ALICE_KEY" propose_goal "$2" "[d.result.goalRunId, d.result.status, d.result.changed].join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "$1-proposed" "propose_goal HTTP $status: $(parse_kv "$out" BODY)"
  proposed=$(parse_kv "$out" EXTRACTED)
  GOAL_RUN_ID=${proposed%%,*}
  [ "${proposed#*,}" = "proposed,true" ] || fail "$1-proposed" "propose_goal answered '$proposed', expected a new proposed run: $(parse_kv "$out" BODY)"
  GOALS_STARTED="$GOALS_STARTED $GOAL_RUN_ID"
  out=$(cap "$ALICE_KEY" confirm_goal "{\"goalRunId\":\"$GOAL_RUN_ID\",\"revision\":1}" "[d.result.status, d.result.changed].join(',')")
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

# goal_scenarios_step: the four scenarios, in the order the header explains.
goal_scenarios_step() {
  goal_s6_start
  goal_s1_dag
  goal_s11_reject
  goal_s5_approval
  goal_s6_finish
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
