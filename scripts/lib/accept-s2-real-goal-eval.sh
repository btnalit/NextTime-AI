# scripts/lib/accept-s2-real-goal-eval.sh — real-model scenarios for proposing a goal from chat
# (S11, zod 4 tool schemas and error text: #829), one evaluation trial of one case (S10 E3-2a,
# #822) and one draft evaluation through the funnel (S10 E3-2b, #833). Run by scripts/accept_s2.sh
# --real from real_scenarios_step, after the ssh scenarios; sourced right after
# accept-s2-goals.sh. POSIX sh, same conventions (pass/fail, cap, parse_kv, psql_ws, no temp file,
# no jq). docs/runbooks/host-accept-real-model.md §4 lists what each one judges.
#
# As every real scenario, each is judged on its outcome only — a real model decides for itself —
# and one RUN line per try carries bounded markers, never reply or report text (the repository
# and run artifacts are public).
#
#   goal        — alice asks her entry agent, in a new chat, to propose (not confirm) a goal whose
#                 step the ops-runner Worker runs and whose acceptance the platform checks on the
#                 test stock API. ok: the Turn completed and one GoalRun originated in it is
#                 `proposed`. The RUN line counts the Turn's propose_goal calls and those that
#                 failed (the kernel's zod 4 error text went back to the model), and `retried=1`
#                 when one failed and a later one proposed the run. Each run is turned down at
#                 once (reject_goal) so the RUNS proposals stay under the per-requester cap.
#   eval_trial  — start_eval_case_trial on the suite's regression case: an evaluation Task of the
#                 ops-runner version the suite pins, its stock.get call answered from the case's
#                 fixture, egress denied. ok: the trial ends `scored` and `passed` (the call was
#                 made and the reported summary names the fixture's symbol). A trial `errored` for
#                 a reason that is not the Worker's own (it could not start, was lost, terminated,
#                 crashed, withheld) is a platform defect: one fails the script (real-eval-trial).
#   eval_draft  — a Skill whose published v1 tells the Worker to end its summary with one style
#                 marker and whose draft v2 with another, evaluated once against the suite (one
#                 regression case, one full dev case, one full holdout case: regression 2 tries ×
#                 2 arms, then confirm 3 tries × 2 arms × 2 cases — 16 trials at most). ok: it
#                 finishes with a verdict a stage's rule gave (not unmeasured, not contaminated, not
#                 inconclusive for errored trials or the budget), every baseline-arm WorkerRun
#                 mounted v1 and no candidate-arm WorkerRun did (worker_run_skills: the draft is
#                 mounted inline, never as a row). A report carrying the other arm's marker is
#                 a platform defect — the arm loaded the wrong Skill — and fails the script
#                 (real-eval-arms); how many reports carry their own arm's marker is reported, not
#                 judged (the model may not read the Skill).
#
# Both Skill versions are proposed through an interactive Handle (issue_handle → /mcp
# propose_skill: propose_skill is an agent's capability, as in the console's own flow a Worker
# proposes) and published by alice. Cost: about RUNS + 3 entry Turns, RUNS + 16 Worker runs on the
# real model; the evaluation budget (evaluation.monthly_cost_budget_usd, $10 by default) is far
# above that.

REAL_EVAL_SUITE_ID=""
REAL_EVAL_SUITE_VERSION=""
REAL_EVAL_REGRESSION_CASE_ID=""
REAL_EVAL_SYMBOL=""
REAL_EVAL_PLATFORM_DEFECT=0

# real_mcp <handle> <method> <params> <extract>: one JSON-RPC call to the kernel's /mcp.
real_mcp() {
  run_driver mcp "$1" "$2" "$3" "${4:-}"
}

# The newest (id,status) of a GoalRun proposed in Turn $1, or empty.
real_goal_of_turn() {
  psql_ws "select id || ',' || status from goal_runs where workspace_id='$WORKSPACE_ID' and originated_in_turn_id='$1' order by created_at desc limit 1"
}

real_goal_run() {
  i=$1
  gn=$(real_token)
  ask="请帮我提议一个目标，只提议，不要替我确认：让 ops-runner 这个 Worker 读一次测试 API 的库存读数（stock.get），并报告读到的 symbol。验收由平台自己读测试 API，库存读数的 symbol 应是 NXT。目标说明里带上 GOAL_NONCE=$gn 。提议后告诉我目标的 id。"
  chat_out=$(run_driver send-and-wait "$ALICE_KEY" "" "$ask" 300000)
  turn_id=$(parse_kv "$chat_out" TURN_ID)
  turn_status=$(parse_kv "$chat_out" TURN_STATUS)
  tc=$(parse_kv "$chat_out" TOOL_CALLS); te=$(parse_kv "$chat_out" TOOL_ERRORS); tn=$(parse_kv "$chat_out" TOOL_NAMES)
  goal="" goal_id="" goal_status="" calls="0,0" first_failure=""
  if [ -n "$turn_id" ]; then
    goal=$(real_goal_of_turn "$turn_id")
    goal_id=${goal%%,*}
    [ -n "$goal" ] && goal_status=${goal#*,}
    # Every propose_goal call of the Turn, and those the runtime flagged as failed; for the first
    # failed one only its error code (a bounded marker, not the error text).
    calls=$(psql_ws "select count(*) || ',' || count(*) filter (where content->>'outcome' = 'failed') from chat_messages where workspace_id='$WORKSPACE_ID' and turn_id='$turn_id' and role='tool' and content->>'kind'='tool_call' and content->>'name' like '%propose_goal%'")
    first_failure=$(psql_ws "select coalesce(substring(content->'result'->>'text' from '\"code\" *: *\"([a-z_]+)\"'), 'uncoded') from chat_messages where workspace_id='$WORKSPACE_ID' and turn_id='$turn_id' and role='tool' and content->>'kind'='tool_call' and content->>'name' like '%propose_goal%' and content->>'outcome'='failed' order by sequence limit 1")
  fi
  pg_calls=${calls%%,*}; pg_failed=${calls#*,}
  ok=0
  [ "$turn_status" = "completed" ] && [ "$goal_status" = "proposed" ] && ok=1
  retried=0
  [ "$ok" -eq 1 ] && [ "${pg_failed:-0}" -gt 0 ] && retried=1
  real_run_line goal "$i" "$([ "$ok" -eq 1 ] && echo ok || echo fail)" "turn=${turn_status:-none} goal=${goal_status:-none} propose_goal_calls=${pg_calls:-0} failed=${pg_failed:-0} retried=$retried first_failure=${first_failure:-none} turn_tools=${tc:-0}/${te:-0}[${tn}]"
  real_stat_add goal "$ok" "${tc:-0}" "${te:-0}" 0 0
  # Turned down at once: RUNS proposals would otherwise reach the per-requester cap of proposed
  # runs, and nobody confirms these. Recorded too, so cleanup_step ends one this missed.
  if [ -n "$goal_id" ]; then
    GOALS_STARTED="$GOALS_STARTED $goal_id"
    goal_end_live "$goal_id"
  fi
  return 0
}

# real_eval_case <partition> <split> <title> <input>: adds one case to the suite, every stock.get
# call answered with the fixture's reading; it passes when stock.get was called at least once and
# the reported summary names the fixture's symbol. Sets REAL_EVAL_SUITE_VERSION and
# REAL_EVAL_CASE_ID (globals, not output: called in the script's own shell, so a fail stops it).
real_eval_case() {
  rec_body="{\"suiteId\":\"$REAL_EVAL_SUITE_ID\",\"suiteVersion\":$REAL_EVAL_SUITE_VERSION,\"partition\":\"$1\",\"split\":\"$2\",\"title\":\"$3\",\"input\":\"$4\",\"fixtures\":[{\"gatekeeperId\":\"$GATEKEEPER_ID_HTTP\",\"operation\":\"stock.get\",\"answer\":{\"kind\":\"data\",\"data\":{\"symbol\":\"$REAL_EVAL_SYMBOL\",\"qty\":42}}}],\"assertions\":[{\"expect\":{\"path\":\"length(calls[?operation=='stock.get'])\",\"op\":\"gte\",\"value\":1},\"note\":\"reads the stock\"},{\"expect\":{\"path\":\"result.summary\",\"op\":\"contains\",\"value\":\"$REAL_EVAL_SYMBOL\"},\"note\":\"reports the symbol\"}]}"
  rec_out=$(cap "$ALICE_KEY" add_eval_case "$rec_body" "(() => { const c = d.result.cases.filter((x) => x.title === '$3'); return [d.result.version, c.length ? c[c.length - 1].id : ''].join(','); })()")
  status=$(parse_kv "$rec_out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "real-eval-setup" "add_eval_case($1/$2) HTTP $status: $(parse_kv "$rec_out" BODY)"
  rec_pair=$(parse_kv "$rec_out" EXTRACTED)
  REAL_EVAL_SUITE_VERSION=${rec_pair%%,*}
  REAL_EVAL_CASE_ID=${rec_pair#*,}
  [ -n "$REAL_EVAL_CASE_ID" ] || fail "real-eval-setup" "add_eval_case($1/$2) answered no case titled '$3': $(parse_kv "$rec_out" BODY)"
}

# The suite every eval scenario runs: the ops-runner version this script published (pinned to
# $REAL_MODEL), the http gate as its one fixture gate, three cases. Setup failures fail the script:
# they are the platform's, not the model's.
real_eval_setup_step() {
  n=$(real_token)
  REAL_EVAL_SYMBOL="EVAL-$n"
  out=$(cap "$ALICE_KEY" create_eval_suite "{\"name\":\"accept_s2 real $n\",\"workerDefinitionId\":\"$OPS_RUNNER_ID\",\"workerDefinitionVersion\":$OPS_RUNNER_VERSION}" "[d.result.id, d.result.version].join(',')")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "real-eval-setup" "create_eval_suite HTTP $status: $(parse_kv "$out" BODY)"
  pair=$(parse_kv "$out" EXTRACTED)
  REAL_EVAL_SUITE_ID=${pair%%,*}
  REAL_EVAL_SUITE_VERSION=${pair#*,}
  out=$(cap "$ALICE_KEY" add_eval_fixture_gate "{\"suiteId\":\"$REAL_EVAL_SUITE_ID\",\"suiteVersion\":$REAL_EVAL_SUITE_VERSION,\"gatekeeperId\":\"$GATEKEEPER_ID_HTTP\"}" "d.result.version")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "real-eval-setup" "add_eval_fixture_gate HTTP $status: $(parse_kv "$out" BODY)"
  REAL_EVAL_SUITE_VERSION=$(parse_kv "$out" EXTRACTED)
  # Inputs under 40 characters: the seal indexes held-out text from 40 characters on, and a
  # Worker that quotes its task back must not turn the holdout case into contamination.
  real_eval_case regression dev "read stock" "读一次库存（stock.get），报告 symbol。"
  REAL_EVAL_REGRESSION_CASE_ID=$REAL_EVAL_CASE_ID
  real_eval_case full dev "stock symbol" "库存读数里的 symbol 是什么？读一次再报告。"
  real_eval_case full holdout "stock check" "查一下库存，报告读到的 symbol。"
  pass "real-eval-setup" "suite $REAL_EVAL_SUITE_ID v$REAL_EVAL_SUITE_VERSION pins ops-runner@$OPS_RUNNER_VERSION (model=$REAL_MODEL): fixture gate http (stock.get), cases regression/dev, full/dev, full/holdout"
}

# real_eval_wait_run <runId> <seconds>: polls get_eval_run until it finished; prints
# "<status>|<trial>;<trial>…" with each trial as arm,status,verdict,error,costUsd.
real_eval_wait_run() {
  rew_deadline=$(( $(date +%s) + $2 ))
  while :; do
    rew_out=$(cap "$ALICE_KEY" get_eval_run "{\"runId\":\"$1\"}" "d.result.status + '|' + d.result.trials.map((t) => [t.arm, t.status, t.verdict, t.error, t.costUsd].join(',')).join(';')")
    rew_line=$(parse_kv "$rew_out" EXTRACTED)
    case "$rew_line" in finished\|*) break ;; esac
    [ "$(date +%s)" -lt "$rew_deadline" ] || break
    sleep 10
  done
  printf '%s' "$rew_line"
}

# Errors that are the Worker's own outcome (shared DRAFT_EVALUATION_FAILING_ERRORS) — any other
# error of an ended trial says the platform did not run it.
real_eval_own_error() {
  case "$1" in timeout|no_result|budget_exhausted) return 0 ;; *) return 1 ;; esac
}

real_eval_trial_run() {
  i=$1
  out=$(cap "$ALICE_KEY" start_eval_case_trial "{\"suiteId\":\"$REAL_EVAL_SUITE_ID\",\"suiteVersion\":$REAL_EVAL_SUITE_VERSION,\"caseId\":\"$REAL_EVAL_REGRESSION_CASE_ID\"}" "d.result.id")
  status=$(parse_kv "$out" HTTP_STATUS)
  if [ "$status" != "200" ]; then
    real_run_line eval_trial "$i" fail "start_eval_case_trial=HTTP$status"
    real_stat_add eval_trial 0 0 0 0 0
    REAL_EVAL_PLATFORM_DEFECT=1
    echo "NOTE real-eval-trial start refused: $(parse_kv "$out" BODY | cut -c1-400)"
    return 0
  fi
  run_id=$(parse_kv "$out" EXTRACTED)
  line=$(real_eval_wait_run "$run_id" 420)
  run_status=${line%%|*}
  trial=${line#*|}
  # arm,status,verdict,error,costUsd
  t_status=$(printf '%s' "$trial" | cut -d, -f2)
  t_verdict=$(printf '%s' "$trial" | cut -d, -f3)
  t_error=$(printf '%s' "$trial" | cut -d, -f4)
  t_cost=$(printf '%s' "$trial" | cut -d, -f5)
  calls=$(psql_ws "select count(*) from eval_trial_calls c join eval_trials t on t.workspace_id=c.workspace_id and t.id=c.trial_id where t.workspace_id='$WORKSPACE_ID' and t.run_id='$run_id'")
  eval_tasks=$(psql_ws "select count(*) from eval_trials t join tasks k on k.workspace_id=t.workspace_id and k.id=t.task_id where t.workspace_id='$WORKSPACE_ID' and t.run_id='$run_id' and k.purpose='evaluation'")
  ok=0
  [ "$run_status" = "finished" ] && [ "$t_status" = "scored" ] && [ "$t_verdict" = "passed" ] && ok=1
  if [ "$t_status" = "errored" ] && ! real_eval_own_error "$t_error"; then REAL_EVAL_PLATFORM_DEFECT=1; fi
  [ "$run_status" = "finished" ] || REAL_EVAL_PLATFORM_DEFECT=1
  real_run_line eval_trial "$i" "$([ "$ok" -eq 1 ] && echo ok || echo fail)" "run=${run_status:-none} trial=${t_status:-none}/${t_verdict:-none}/${t_error:-none} fixture_calls=${calls:-0} evaluation_tasks=${eval_tasks:-0} cost_usd=${t_cost:-none}"
  real_stat_add eval_trial "$ok" 0 0 "${calls:-0}" 0
  return 0
}

real_eval_trials_step() {
  REAL_EVAL_PLATFORM_DEFECT=0
  i=1
  while [ "$i" -le "$RUNS" ]; do real_eval_trial_run "$i"; i=$((i + 1)); done
  [ "$REAL_EVAL_PLATFORM_DEFECT" -eq 0 ] || fail "real-eval-trial" "an evaluation trial was refused, never finished, or errored for a reason that is not its Worker's (see RUN scenario=eval_trial lines)"
  pass "real-eval-trial" "every evaluation trial started, finished and ended scored or errored by its own Worker ($RUNS runs)"
}

# real_skill_propose <handle> <name> <marker> [skillId]: proposes a Skill version through /mcp;
# sets RSP_ID, RSP_VERSION and RSP_DIGEST.
real_skill_propose() {
  rsp_markdown="# Report style\\n\\nWhen you report a task's result, end the summary with this exact line:\\n\\nSTYLE: $3"
  rsp_skill="{\"name\":\"$2\",\"description\":\"How to word a task's report in this workspace. Read it before you report.\",\"markdown\":\"$rsp_markdown\"}"
  rsp_args="{\"skill\":$rsp_skill$([ -n "${4:-}" ] && printf ',"skillId":"%s"' "$4")}"
  rsp_out=$(real_mcp "$1" tools/call "{\"name\":\"propose_skill\",\"arguments\":$rsp_args}" "(() => { if (d.result.isError) return 'ERROR'; const r = JSON.parse(d.result.content[0].text); return [r.id, r.version, r.draftDigest].join(','); })()")
  status=$(parse_kv "$rsp_out" HTTP_STATUS)
  rsp_triple=$(parse_kv "$rsp_out" EXTRACTED)
  case "$status:$rsp_triple" in
    200:ERROR|200:|200:*,,*|200:*,) fail "real-eval-skill" "propose_skill($2, $3) through /mcp did not propose: $(parse_kv "$rsp_out" BODY | cut -c1-600)" ;;
    200:*) : ;;
    *) fail "real-eval-skill" "propose_skill($2, $3) through /mcp HTTP $status: $(parse_kv "$rsp_out" BODY | cut -c1-600)" ;;
  esac
  RSP_ID=${rsp_triple%%,*}
  rsp_rest=${rsp_triple#*,}
  RSP_VERSION=${rsp_rest%%,*}
  RSP_DIGEST=${rsp_rest#*,}
}

real_eval_draft_step() {
  n=$(real_token)
  skill_name="report-style-$n"
  base_marker="plain-$n"
  cand_marker="tagged-$n"
  out=$(cap "$ALICE_KEY" issue_handle '{"sessionKind":"interactive","ttlSeconds":3600}' "d.result.handle")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "real-eval-skill" "issue_handle HTTP $status: $(parse_kv "$out" BODY)"
  handle=$(parse_kv "$out" EXTRACTED)
  [ -n "$handle" ] || fail "real-eval-skill" "issue_handle answered no Handle"

  real_skill_propose "$handle" "$skill_name" "$base_marker"
  skill_id=$RSP_ID v1_version=$RSP_VERSION v1_digest=$RSP_DIGEST
  out=$(cap "$ALICE_KEY" publish_skill "{\"skillId\":\"$skill_id\",\"version\":$v1_version,\"draftDigest\":\"$v1_digest\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "real-eval-skill" "publish_skill(v$v1_version) HTTP $status: $(parse_kv "$out" BODY)"
  real_skill_propose "$handle" "$skill_name" "$cand_marker" "$skill_id"
  v2_version=$RSP_VERSION v2_digest=$RSP_DIGEST
  pass "real-eval-skill" "Skill $skill_id: v$v1_version published, v$v2_version a draft that changes its style marker"

  out=$(cap "$ALICE_KEY" start_draft_evaluation "{\"skillId\":\"$skill_id\",\"version\":$v2_version,\"draftDigest\":\"$v2_digest\",\"suiteId\":\"$REAL_EVAL_SUITE_ID\",\"suiteVersion\":$REAL_EVAL_SUITE_VERSION}" "d.result.id")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "real-eval-draft" "start_draft_evaluation HTTP $status: $(parse_kv "$out" BODY)"
  evaluation_id=$(parse_kv "$out" EXTRACTED)

  # Up to 16 trials, a few at a time (the evaluation Principal's concurrency): 30 minutes.
  deadline=$(( $(date +%s) + 1800 ))
  state=""
  while :; do
    out=$(cap "$ALICE_KEY" get_draft_evaluation "{\"evaluationId\":\"$evaluation_id\"}" "[d.result.status, d.result.verdict, d.result.reason, d.result.decidedBy, d.result.costUsd, d.result.stages.map((s) => [s.stage, s.status, 'c' + s.candidate.passed + '/' + s.candidate.trials + 'e' + s.candidate.errored, 'b' + s.baseline.passed + '/' + s.baseline.trials + 'e' + s.baseline.errored].join(':')).join(' ')].join('|')")
    state=$(parse_kv "$out" EXTRACTED)
    case "$state" in running\|*) : ;; *) break ;; esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      cap "$ALICE_KEY" cancel_draft_evaluation "{\"evaluationId\":\"$evaluation_id\"}" "" >/dev/null
      break
    fi
    sleep 15
  done
  e_status=$(printf '%s' "$state" | cut -d'|' -f1)
  e_verdict=$(printf '%s' "$state" | cut -d'|' -f2)
  e_reason=$(printf '%s' "$state" | cut -d'|' -f3)
  e_decided=$(printf '%s' "$state" | cut -d'|' -f4)
  e_cost=$(printf '%s' "$state" | cut -d'|' -f5)
  e_stages=$(printf '%s' "$state" | cut -d'|' -f6)

  # Which Skill each arm's WorkerRuns mounted, from the platform's own record.
  arms=$(psql_ws "select coalesce(string_agg(arm || '=' || mounted || '/' || runs, ' ' order by arm), '') from (select t.arm, count(distinct w.id) as runs, count(distinct w.id) filter (where s.skill_id is not null and s.skill_version = $v1_version) as mounted from eval_trials t join eval_runs r on r.workspace_id = t.workspace_id and r.id = t.run_id join worker_runs w on w.workspace_id = t.workspace_id and w.task_id = t.task_id left join worker_run_skills s on s.workspace_id = w.workspace_id and s.worker_run_id = w.id and s.skill_id = '$skill_id' where t.workspace_id = '$WORKSPACE_ID' and r.draft_evaluation_id = '$evaluation_id' group by t.arm) a")
  base_runs=$(printf '%s' "$arms" | sed -n 's/.*baseline=[0-9]*\/\([0-9]*\).*/\1/p')
  base_mounted=$(printf '%s' "$arms" | sed -n 's/.*baseline=\([0-9]*\)\/.*/\1/p')
  cand_runs=$(printf '%s' "$arms" | sed -n 's/.*candidate=[0-9]*\/\([0-9]*\).*/\1/p')
  cand_mounted=$(printf '%s' "$arms" | sed -n 's/.*candidate=\([0-9]*\)\/.*/\1/p')
  mounts_ok=0
  [ "${base_runs:-0}" -gt 0 ] && [ "${base_mounted:-0}" = "${base_runs:-0}" ] && [ "${cand_runs:-0}" -gt 0 ] && [ "${cand_mounted:-1}" = "0" ] && mounts_ok=1

  # The style markers each arm's reports carry (counts only).
  markers=$(psql_ws "select coalesce(string_agg(arm || '=' || own || '/' || other || '/' || reported, ' ' order by arm), '') from (select t.arm, count(*) filter (where t.result::text like '%' || (case when t.arm = 'candidate' then '$cand_marker' else '$base_marker' end) || '%') as own, count(*) filter (where t.result::text like '%' || (case when t.arm = 'candidate' then '$base_marker' else '$cand_marker' end) || '%') as other, count(*) filter (where t.result is not null) as reported from eval_trials t join eval_runs r on r.workspace_id = t.workspace_id and r.id = t.run_id where t.workspace_id = '$WORKSPACE_ID' and r.draft_evaluation_id = '$evaluation_id' group by t.arm) m")
  base_other=$(printf '%s' "$markers" | sed -n 's/.*baseline=[0-9]*\/\([0-9]*\)\/.*/\1/p')
  cand_other=$(printf '%s' "$markers" | sed -n 's/.*candidate=[0-9]*\/\([0-9]*\)\/.*/\1/p')
  crossed=0
  [ "${base_other:-0}" -eq 0 ] && [ "${cand_other:-0}" -eq 0 ] || crossed=1

  ok=0
  if [ "$e_status" = "finished" ] && [ "$mounts_ok" -eq 1 ] && [ "$crossed" -eq 0 ]; then
    case "$e_verdict:$e_reason" in
      unmeasured:*|contaminated:*|inconclusive:errored_trials|inconclusive:budget|:*) : ;;
      *) ok=1 ;;
    esac
  fi
  real_run_line eval_draft 1 "$([ "$ok" -eq 1 ] && echo ok || echo fail)" "evaluation=${e_status:-none} verdict=${e_verdict:-none}/${e_reason:-none} decided_by=${e_decided:-none} stages=[${e_stages}] mounted_v1=[${arms}] markers_own_other_reported=[${markers}] cost_usd=${e_cost:-none}"
  real_stat_add eval_draft "$ok" 0 0 0 0
  [ "$crossed" -eq 0 ] || fail "real-eval-arms" "a report carried the other arm's style marker — an arm loaded the other Skill version (markers own/other/reported: $markers)"
  [ "$mounts_ok" -eq 1 ] || fail "real-eval-arms" "the arms did not mount what they compare: every baseline WorkerRun must mount v$v1_version and no candidate WorkerRun the published version (mounted/runs: ${arms:-none})"
  pass "real-eval-arms" "baseline WorkerRuns mounted v$v1_version, candidate ones the draft only; no report carried the other arm's marker"
}
