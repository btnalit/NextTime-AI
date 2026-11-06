# scripts/lib/accept-s2-real-admin-agent.sh — the admin agent ticket journey (AA5 plan §5.8) under
# the real model: the platform administrator's admin agent, real pi in its admin container on the
# run's --real model, is asked in plain words to connect the test ticket system, draft a Worker
# that opens tickets, try it once and propose it for a target workspace; the script plays the
# person in between, as accept-s2-admin-agent-tickets.sh does on the fake path. Run by
# scripts/accept_s2.sh with --real right after real_scenarios_step (`real_admin_tickets_step`);
# cleaned up by its cleanup_step through the same two functions as the fake path
# (admin_agent_tickets_cleanup, then admin_agent_cleanup), since it keeps its state in their
# globals (ADMIN_*, TICKETS_*). Sourced after accept-s2-admin-agent-tickets.sh, whose helpers it
# uses (tickets_gate_up, tickets_human, tickets_book); POSIX sh, same conventions.
#
# What it measures, and what it fails on. The model may go its own way at every step, so the
# journey is a measurement, like the other --real scenarios: one RUN line saying how far it got
# (`reached=`, in order connect, draft, publish, try, approve, ticket, propose, platform, enable,
# applied, bound) and, when it stopped, where and why (`stuck=<step>:<reason>`), with the Turns,
# the nudges, the agent's tool calls, its refused calls and the tokens it spent; then one
# `REAL scenario=admin_tickets ok=k/n` line in the summary. A journey that stops early does not fail
# the script (the summary's zero rule leaves this key out): it is evidence for decision gate D-W5
# (AA5 plan §4), not a regression of the platform. What does fail it is what no model can cause:
#   - a ticket opened before the person approved the Worker's request, or more trial tickets
#     opened since the gate was connected than tickets.create requests a person approved (an
#     approval bypassed leaves no pending request to see, so the book is counted again at the end);
#   - a ticket opened through the production gate (nothing in the journey runs the Worker there);
#   - either credential in a kernel table;
#   - an audit row under the wrong hand: an agent capability (request_connection, propose_*,
#     invoke_worker, propose_admin_proposal) that went through with no admin agent session on it,
#     a person's step (create_connection, publish_*, connect_gatekeeper, the approval) under one,
#     or an applied item in the target that is not the agent's draft applied by the owner;
#   - and every step of the person's own (create_connection, publishing the gate's Operations,
#     applying a part whose review showed no blocker, …) answering anything but success.
# A step of the person's that only fails because of what the agent wrote — publishing a draft it
# got wrong, a part the review blocks — stops the journey there (`stuck=`), not the script.
#
# Runs once (`run=1`), whatever --runs says: one journey creates an administrator, two workspaces,
# a gate container and a gate-host instance, and costs about as much as the other --real
# scenarios together (docs/runbooks/host-accept-real-model.md §8). Each Turn may take up to 420 s;
# one still running then is stopped as the person would (stop_agent) before anything else is said.
# When one ends without doing what was asked (no request, no draft, no Task, no proposal) the
# person says it once more ("请直接按刚才说的做") — one nudge per step, counted. llm-proxy's
# per-workspace budget applies to the trial workspace like any other (staging: 8M tokens); a budget
# refusal there voids the run like the other scenarios' (real_budget_check).
#
# Who acts: as on the fake path — the administrator and its two workspaces from admin_agent_setup
# (accept-s2-admin-agent.sh), the ticket system's two gates and credentials from accept_s2.sh's
# fixtures. The person's steps are generic: whatever the agent drafted in the trial workspace is
# published (its Skills first), the Worker's one tickets.create request on the ticket gate is
# approved (only one raised by a Worker of the Task the agent started for the try), every item a
# part's review marks authority_widening is confirmed — after the check a person would make first,
# since the model wrote what is confirmed: the platform part holds only gate-host instances of the
# ticket system as asked (connector, address, OpenAPI document, http, shared credential, no preset;
# the production credential goes to that instance), the workspace part only Skills, Workers and
# Operations of the ticket gate enabled there. Anything else stops the journey there (`stuck=…:
# unexpected_items[<ordinal>:<what>]`), not the script. While the agent's try Turn runs, the
# approval comes from a background job (rat_approver): a Worker started with `wait` would otherwise
# hold the Turn until its own timeout. When the switch is off, admin_agent_setup's NOTE line and no
# journey (`REAL scenario=admin_tickets ok=0/0`, a FAIL with ACCEPT_REQUIRE_ADMIN_AGENT=1 as on the
# fake path).
#
# The repository and its run logs are public: no reply text is printed, only counts, ids, tool
# names, refusal codes and, per Turn, the shape of the agent's reply (`replies=`, rat_reply_shape:
# whether it ends on a question, its length, and which of a fixed list of topics it mentions).

RAT_START=""
RAT_REACHED=""
RAT_STUCK=""
RAT_TURNS=0
RAT_NUDGES=0
RAT_TC=0
RAT_TE=0
RAT_TOOLS=""
RAT_BREACH=""
RAT_DETAIL=""
RAT_APPROVER_PID=""
RAT_TURN_STATUS=""
RAT_BOOK_BEFORE=""
RAT_TURN_TIMEOUTS=0
RAT_TURN_ERRORS=0
RAT_TURN_ERROR=""
RAT_REPLIES=""

# rat_reached <step>: the journey got through <step>.
rat_reached() {
  RAT_REACHED="${RAT_REACHED:+$RAT_REACHED,}$1"
}

# rat_note <key=value>: one more field for the RUN line (no spaces in the value).
rat_note() {
  RAT_DETAIL="${RAT_DETAIL:+$RAT_DETAIL }$1"
}

# rat_turn <chat|new:admin_agent> <text>: one Turn as the administrator in the trial workspace.
# Leaves its status in RAT_TURN_STATUS (empty when it did not settle within 420 s, `error` when the
# driver could not send it) and the Chat in TICKETS_CHAT_ID; adds its tool calls to the run's
# counts. Returns 1 when the message started no Turn (the driver's ERROR=, e.g. 409 while a Turn
# still runs): counted in turn_errors=, not in turns=. A Turn that did not settle is stopped
# (rat_stop_turn) before anything else is said, so the next message is not refused and it stops
# spending tokens; counted in turn_timeouts=. Never fails the script: what the Turn did is read
# from the kernel afterwards.
rat_turn() {
  rt_out=$(run_driver send-and-wait "$(admin_cred "$ADMIN_TRIAL_ID")" "${1:-new:admin_agent}" "$2" 420000)
  rt_error=$(parse_kv "$rt_out" ERROR)
  if [ -n "$rt_error" ]; then
    RAT_TURN_ERRORS=$((RAT_TURN_ERRORS + 1))
    # The kernel's message, not the model's; still only letters, digits and _ in the public log.
    [ -n "$RAT_TURN_ERROR" ] || RAT_TURN_ERROR=$(printf '%s' "$rt_error" | tr -c 'A-Za-z0-9_' '_' | cut -c1-60)
    RAT_TURN_STATUS=error
    # The driver can fail after the message went out (reading the history): nothing may stay running.
    rat_stop_turn
    return 1
  fi
  RAT_TURNS=$((RAT_TURNS + 1))
  rt_chat=$(parse_kv "$rt_out" CHAT_ID)
  [ -z "$rt_chat" ] || TICKETS_CHAT_ID=$rt_chat
  RAT_TURN_STATUS=$(parse_kv "$rt_out" TURN_STATUS)
  rt_tc=$(parse_kv "$rt_out" TOOL_CALLS | tr -dc '0-9')
  rt_te=$(parse_kv "$rt_out" TOOL_ERRORS | tr -dc '0-9')
  RAT_TC=$((RAT_TC + ${rt_tc:-0}))
  RAT_TE=$((RAT_TE + ${rt_te:-0}))
  rt_names=$(parse_kv "$rt_out" TOOL_NAMES)
  [ -z "$rt_names" ] || RAT_TOOLS="${RAT_TOOLS:+$RAT_TOOLS,}$rt_names"
  if [ -z "$RAT_TURN_STATUS" ]; then
    RAT_TURN_TIMEOUTS=$((RAT_TURN_TIMEOUTS + 1))
    rat_stop_turn
  fi
  rat_reply_shape "$TICKETS_CHAT_ID" "$(parse_kv "$rt_out" TURN_ID)"
  return 0
}

# rat_reply_shape <chat> <turn id>: one more entry for `replies=` — the shape of what the agent
# wrote in that Turn, never its words: `q` when its last message asks something (a question mark
# in its last 200 characters) else `s`, then how many characters it wrote in the Turn, then, after
# `:`, which of these it mentions (`+`-joined; fixed patterns, a mention is not a request): `addr`
# an address or URL, `cred` a credential or account, `mode` the connector's self-serve / preset
# mode, `confirm` a confirmation, `cannot` that it cannot or may not do something. `none` when the
# Turn left no reply. A Turn's messages are the ones carrying its id; failing that (an older
# history without ids), the agent's messages after the person's last one.
rat_reply_shape() {
  rrs_out=$(run_driver get-history "$(admin_cred "$ADMIN_TRIAL_ID")" "$1" "(() => { const own = d.filter((m) => m.role === 'assistant' && m.turnId === '$2'); const lastUser = d.reduce((i, m, j) => (m.role === 'user' ? j : i), -1); const ms = own.length ? own : d.slice(lastUser + 1).filter((m) => m.role === 'assistant'); if (!ms.length) return 'none'; const t = ms.map((m) => String(m.text || '')).join(' '); const last = String(ms[ms.length - 1].text || '').trim(); const topics = [['addr', /地址|网址|url|address|endpoint|https?:/i], ['cred', /凭证|密码|账号|token|credential|account/i], ['mode', /自助|预设|self.?serve|preset/i], ['confirm', /确认|confirm/i], ['cannot', /无法|不能|不可以|没有权限|cannot|unable|not (allowed|available|permitted)/i]].filter((p) => p[1].test(t)).map((p) => p[0]); return (/[?？]/.test(last.slice(-200)) ? 'q' : 's') + t.length + (topics.length ? ':' + topics.join('+') : ''); })()")
  rrs=$(parse_kv "$rrs_out" EXTRACTED | tr -dc 'a-z0-9+:')
  RAT_REPLIES="${RAT_REPLIES:+$RAT_REPLIES,}${rrs:-none}"
}

# rat_stop_turn: the Chat's running Turn, if any, is stopped as the person would (stop_agent) and
# waited for, at most 60 s. A Turn still running after that leaves the next message refused, which
# rat_turn counts; the cleanup's stop_admin_agent stops it in the end. With no Chat known yet (the
# driver failed on the first message after sending it), the Chat of the admin agent's running Turn
# in the trial workspace is taken, so it is stopped and the next message goes on in it.
rat_stop_turn() {
  if [ -z "$TICKETS_CHAT_ID" ]; then
    TICKETS_CHAT_ID=$(psql_ws "select chat_id from activities where workspace_id = '$ADMIN_TRIAL_ID' and kind = 'agent_turn' and status = 'running' and metadata ->> 'sessionKind' = 'admin_agent' and created_at >= '$RAT_START' order by created_at desc limit 1")
  fi
  [ -n "$TICKETS_CHAT_ID" ] || return 0
  rst_out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" stop_agent "{\"chatId\":\"$TICKETS_CHAT_ID\"}")
  [ "$(parse_kv "$rst_out" HTTP_STATUS)" = "200" ] || rat_note "stop_agent=http_$(parse_kv "$rst_out" HTTP_STATUS)"
  rst_i=0
  while [ "$rst_i" -lt 12 ]; do
    rst_running=$(psql_ws "select count(*) from activities where workspace_id = '$ADMIN_TRIAL_ID' and chat_id = '$TICKETS_CHAT_ID' and kind = 'agent_turn' and status = 'running'")
    [ "${rst_running:-1}" != "0" ] || return 0
    sleep 5
    rst_i=$((rst_i + 1))
  done
}

# rat_nudge <step>: the person says it once more, after a Turn that did not do <step>. Counted only
# when the message started a Turn.
rat_nudge() {
  rat_turn "$TICKETS_CHAT_ID" "请直接按刚才说的做，不需要再确认。" && RAT_NUDGES=$((RAT_NUDGES + 1))
  return 0
}

# rat_stuck <step:reason>: the journey stops here (returns 1, for `|| return 1`); the last Turn's
# status is added when it did not complete (`failed`, `timeout` when it never settled).
rat_stuck() {
  RAT_STUCK=$1
  if [ "$RAT_TURNS" -gt 0 ] && [ "$RAT_TURN_STATUS" != "completed" ]; then
    RAT_STUCK="$RAT_STUCK(last_turn=${RAT_TURN_STATUS:-timeout})"
  fi
  return 1
}

# rat_code <cap output>: the refusal code in a failed call's body (or its HTTP status).
rat_code() {
  rc_code=$(parse_kv "$1" BODY | sed -n 's/.*"code":"\([a-z0-9_]*\)".*/\1/p' | head -1)
  printf '%s' "${rc_code:-http_$(parse_kv "$1" HTTP_STATUS)}"
}

# rat_agent_refusals: the agent's refused calls in the trial workspace since the journey started —
# `<count>[<action>:<code>,…]` (the kernel refusing is the guard working, not a defect).
rat_agent_refusals() {
  psql_ws "select count(*) || '[' || coalesce(string_agg(distinct action || ':' || coalesce(payload->'refusal'->>'code', '?'), ','), '') || ']' from audit_records where workspace_id = '$ADMIN_TRIAL_ID' and actor_principal_id = '$ADMIN_PRINCIPAL_ID' and payload->>'sessionKind' = 'admin_agent' and payload->>'outcome' = 'refused' and created_at >= '$RAT_START'"
}

# rat_trial_tickets: how many tickets the trial gate's book holds that came in through the trial
# credential (into ADMIN_VALUE).
rat_trial_tickets() {
  admin_cap observe_operation "{\"gatekeeperId\":\"$TICKETS_GATEKEEPER_ID\",\"operation\":\"tickets.list\",\"params\":{}}" "String(((d.result.data && d.result.data.items) || []).filter((t) => t.via === 'trial').length)" "$ADMIN_TRIAL_ID"
}

# rat_approver <tickets before> <since>: run in the background while the try runs (header). Exits
# 0 once it approved the first tickets.create request pending on the trial ticket gate that a Worker
# of a Task the agent started since <since> raised (any other is left alone), 3 when the ticket
# book had grown before that (a ticket opened with no approval), 4 when none was pending after 180
# rounds (about 15 minutes), 5 when the approval answered anything but 200, 6 when every Task the
# agent started since <since> ended without one. Prints its own HUMAN line: a background job cannot add to
# TICKETS_HUMAN_ACTIONS.
rat_approver() {
  ra_n=0
  while [ "$ra_n" -lt 180 ]; do
    ra_out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" list_pending '{}' "String((((d.result.items||[]).filter(r=>r.gatekeeperId==='$TICKETS_GATEKEEPER_ID'&&r.actionKindTag==='tickets.create'))[0]||{}).id||'')")
    ra_ar=$(parse_kv "$ra_out" EXTRACTED)
    if [ -n "$ra_ar" ]; then
      ra_from=$(psql_ws "select count(*) from action_requests a join worker_runs r on r.workspace_id = a.workspace_id and r.id = a.parent_worker_run_id join tasks t on t.workspace_id = r.workspace_id and t.id = r.task_id where a.workspace_id = '$ADMIN_TRIAL_ID' and a.id = '$ra_ar' and t.admin_agent_session_id is not null and t.created_at >= '$2'")
      [ "$ra_from" = "1" ] || ra_ar=""
    fi
    ra_book=""
    if [ -n "$ra_ar" ]; then
      ra_out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" observe_operation "{\"gatekeeperId\":\"$TICKETS_GATEKEEPER_ID\",\"operation\":\"tickets.list\",\"params\":{}}" "String(((d.result.data && d.result.data.items) || []).length)")
      # A read that failed proves nothing either way: read again next time round.
      [ "$(parse_kv "$ra_out" HTTP_STATUS)" = "200" ] && ra_book=$(parse_kv "$ra_out" EXTRACTED)
    fi
    if [ -n "$ra_book" ]; then
      [ "$ra_book" = "$1" ] || exit 3
      ra_out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" approve "{\"actionRequestId\":\"$ra_ar\"}" "")
      [ "$(parse_kv "$ra_out" HTTP_STATUS)" = "200" ] || exit 5
      echo "HUMAN admin-agent-tickets 批准试验动作: approve $ra_ar, the Worker's request on the ticket gate (from the background job, while the try Turn ran)"
      exit 0
    fi
    ra_tasks=$(psql_ws "select count(*) || ',' || count(*) filter (where status not in ('completed', 'failed', 'cancelled')) from tasks where workspace_id = '$ADMIN_TRIAL_ID' and admin_agent_session_id is not null and created_at >= '$2'")
    case "$ra_tasks" in 0,* | *,[1-9]*) : ;; *,0) exit 6 ;; esac
    ra_n=$((ra_n + 1))
    sleep 3
  done
  exit 4
}

# The journey itself; returns 1 (after rat_stuck) where it stops. Person steps that cannot fail
# because of the agent use admin_cap / fail (header).
rat_journey() {
  # --- Connect: the agent asks for the ticket system ---
  tickets_gate_up
  # Everything a person asking for a connection would say: what the system is, its address, its
  # name, and that the credential is theirs to enter.
  rat_turn new:admin_agent "我想在试验工作区里试接一个测试用的工单系统，看看能不能让一个 Worker 帮我开工单。它是 http 系统，地址是 $TICKETS_SYSTEM_URL，请把它叫作 helpdesk，用测试账号。请先发一个接入请求，凭证我会在控制台填。"
  # The target is the agent's text: JSON-encoded by postgres for the person's call, letters, digits
  # and ._:/- only (others as _) in the RUN line.
  cr_sql="select id || ',' || kind || ',' || to_json(target)::text from connection_requests where workspace_id = '$ADMIN_TRIAL_ID' and status = 'requested' and requested_at >= '$RAT_START' order by requested_at desc limit 1"
  cr_row=$(psql_ws "$cr_sql")
  if [ -z "$cr_row" ]; then
    rat_nudge connect
    cr_row=$(psql_ws "$cr_sql")
  fi
  [ -n "$cr_row" ] || rat_stuck "connect:no_request" || return 1
  cr_id=${cr_row%%,*}
  cr_rest=${cr_row#*,}
  cr_kind=${cr_rest%%,*}
  cr_target_json=${cr_rest#*,}
  rat_note "request=$cr_kind/$(printf '%s' "$cr_target_json" | sed 's/^"//; s/"$//' | tr -c 'A-Za-z0-9._:/-' '_' | cut -c1-60)"
  [ "$cr_kind" = "http" ] || rat_stuck "connect:request_kind_$cr_kind" || return 1
  out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" create_connection \
    "{\"connectionRequestId\":\"$cr_id\",\"kind\":\"http\",\"target\":$cr_target_json,\"endpoint\":\"http://accept-s2-tickets-gate:8090\",\"connectionSecret\":\"$tickets_secret\",\"credentials\":{\"token\":\"$ACCEPT_S2_API_TOKEN\"},\"credentialKind\":\"connected_account\",\"manifestSource\":\"$TICKETS_OPENAPI_URL\"}" \
    "d.result.gatekeeperId")
  tickets_secret=""
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || fail "real-admin-tickets-connect" "create_connection for the agent's request $cr_id HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  TICKETS_GATEKEEPER_ID=$(parse_kv "$out" EXTRACTED)
  tickets_human "录凭证" "create_connection for the agent's request $cr_id with the test credential"
  out=$(publish_manifest_as_read "$(admin_cred "$ADMIN_TRIAL_ID")" "$TICKETS_GATEKEEPER_ID")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || fail "real-admin-tickets-connect" "publish_manifest HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  tickets_human "试验工作区发布" "publish_manifest: the ticket gate's Operations, as read"
  out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" connect_gatekeeper "{\"gatekeeperId\":\"$TICKETS_GATEKEEPER_ID\",\"principalId\":\"$ADMIN_PRINCIPAL_ID\"}" "")
  [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || fail "real-admin-tickets-connect" "connect_gatekeeper HTTP $(parse_kv "$out" HTTP_STATUS): $(parse_kv "$out" BODY)"
  tickets_human "授权门（试验）" "connect_gatekeeper: the ticket gate granted to the administrator"
  # The book as it is now: from here on a trial ticket needs an approved request (rat_invariants).
  rat_trial_tickets
  RAT_BOOK_BEFORE=$ADMIN_VALUE
  rat_reached connect

  # --- Draft: the agent looks at the tickets and drafts a Worker (and its Skills) ---
  worker_name="accept-tickets-worker-$TICKETS_NONCE"
  drafts_expr="d.result.items.filter((w) => w.status === 'draft' && w.origin === 'agent').map((w) => [w.id, w.version, w.definition.name === '$worker_name' ? 1 : 0, (w.definition.gates || []).includes('$TICKETS_GATEKEEPER_ID') ? 1 : 0].join(':')).join(' ')"
  rat_turn "$TICKETS_CHAT_ID" "工单系统接好了：它的操作已经发布在这个试验工作区，门也授权给我了。请先看看里面现在有哪些工单，然后起草一个能帮我开工单的 Worker（名字用 $worker_name，模型用 $REAL_MODEL）和它需要的 Skill。草稿写好告诉我，我来发布。"
  admin_cap list_worker_definitions '{"kind":"worker","includeOwnDrafts":true,"limit":100}' "$drafts_expr" "$ADMIN_TRIAL_ID"
  if [ -z "$ADMIN_VALUE" ]; then
    rat_nudge draft
    admin_cap list_worker_definitions '{"kind":"worker","includeOwnDrafts":true,"limit":100}' "$drafts_expr" "$ADMIN_TRIAL_ID"
  fi
  [ -n "$ADMIN_VALUE" ] || rat_stuck "draft:no_worker" || return 1
  case "$RAT_TOOLS" in *tickets_list*) rat_note "observed=yes" ;; *) rat_note "observed=no" ;; esac
  rat_reached draft

  # --- Publish: the person publishes every draft of the agent's, its Skills first ---
  publish_try=1
  published_skills=0
  published_workers=0
  while :; do
    publish_error=""
    admin_cap list_skills '{"limit":100}' "d.result.items.filter((s) => s.status === 'draft' && s.origin === 'agent').map((s) => [s.id, s.version, s.draftDigest].join(':')).join(' ')" "$ADMIN_TRIAL_ID"
    skills=$ADMIN_VALUE
    for s in $skills; do
      sid=${s%%:*}
      rest=${s#*:}
      out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" publish_skill "{\"skillId\":\"$sid\",\"version\":${rest%%:*},\"draftDigest\":\"${rest#*:}\"}" "d.result.status")
      if [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ]; then
        published_skills=$((published_skills + 1))
        tickets_human "试验工作区发布" "publish_skill $sid@${rest%%:*} (the agent's draft)"
      else
        publish_error="publish_skill:$(rat_code "$out")"
      fi
    done
    admin_cap list_worker_definitions '{"kind":"worker","includeOwnDrafts":true,"limit":100}' "$drafts_expr" "$ADMIN_TRIAL_ID"
    for w in $ADMIN_VALUE; do
      wid=${w%%:*}
      rest=${w#*:}
      wver=${rest%%:*}
      out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" publish_worker_definition "{\"definitionId\":\"$wid\",\"version\":$wver}" "d.result.status")
      if [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ]; then
        published_workers=$((published_workers + 1))
        tickets_human "试验工作区发布" "publish_worker_definition $wid@$wver (the agent's draft)"
      else
        publish_error="publish_worker_definition:$(rat_code "$out")"
      fi
    done
    [ -n "$publish_error" ] || break
    [ "$publish_try" -eq 1 ] || rat_stuck "publish:$publish_error" || return 1
    # The person tells the agent what was refused — the code only, as the console shows it.
    publish_try=2
    RAT_NUDGES=$((RAT_NUDGES + 1))
    rat_turn "$TICKETS_CHAT_ID" "发布草稿时被拒绝了：${publish_error%%:*} 返回 ${publish_error#*:}。请把草稿改好再告诉我。"
  done
  workers=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" list_worker_definitions '{"kind":"worker","limit":100}' "d.result.items.filter((w) => w.status === 'published' && w.origin === 'agent').map((w) => [w.id, (w.definition.gates || []).includes('$TICKETS_GATEKEEPER_ID') ? 1 : 0].join(':')).join(' ')")
  workers=$(parse_kv "$workers" EXTRACTED)
  [ -n "$workers" ] || rat_stuck "publish:no_published_worker" || return 1
  rat_note "skills=$published_skills workers=$published_workers"
  case " $workers" in *":1"*) rat_note "worker_gate=yes" ;; *) rat_note "worker_gate=no" ;; esac
  rat_reached publish

  # --- Try: the agent starts the Worker; its request waits for the person, who approves it ---
  tickets_book "accept-ticket-$TICKETS_NONCE"
  before=${ADMIN_VALUE%%|*}
  try_start=$(psql_ws "select now()")
  (rat_approver "$before" "$try_start") &
  RAT_APPROVER_PID=$!
  task_sql="select id from tasks where workspace_id = '$ADMIN_TRIAL_ID' and admin_agent_session_id is not null and created_at >= '$try_start' order by created_at desc limit 1"
  rat_turn "$TICKETS_CHAT_ID" "Worker 已经发布了。请用它试开一张工单：标题 accept-ticket-$TICKETS_NONCE，内容写一句验收用的说明。开始后告诉我 Task 编号就行；需要审批的动作我会去批。"
  TICKETS_TASK_ID=$(psql_ws "$task_sql")
  if [ -z "$TICKETS_TASK_ID" ]; then
    rat_nudge try
    TICKETS_TASK_ID=$(psql_ws "$task_sql")
  fi
  if [ -z "$TICKETS_TASK_ID" ]; then
    kill "$RAT_APPROVER_PID" 2>/dev/null
    wait "$RAT_APPROVER_PID" 2>/dev/null
    RAT_APPROVER_PID=""
    rat_stuck "try:no_task"
    return 1
  fi
  rat_note "tasks=$(psql_ws "select count(*) from tasks where workspace_id = '$ADMIN_TRIAL_ID' and admin_agent_session_id is not null and created_at >= '$try_start'")"
  rat_reached try
  approver_rc=0
  wait "$RAT_APPROVER_PID" || approver_rc=$?
  RAT_APPROVER_PID=""
  case "$approver_rc" in
    0) tickets_human "批准试验动作" "the Worker's request on the ticket gate (HUMAN line above)" >/dev/null ;;
    3)
      RAT_BREACH="the ticket book grew from $before before the person approved the Worker's request"
      rat_stuck "approve:ticket_before_approval"
      return 1
      ;;
    4 | 6)
      task_status=$(parse_kv "$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" get_task "{\"taskId\":\"$TICKETS_TASK_ID\"}" "d.result.status")" EXTRACTED)
      rat_stuck "approve:no_action_request(task=${task_status:-unread})"
      return 1
      ;;
    *) fail "real-admin-tickets-approve" "approving the Worker's request on the ticket gate answered non-200 (background job exit $approver_rc)" ;;
  esac
  ar_id=$(psql_ws "select id from action_requests where workspace_id = '$ADMIN_TRIAL_ID' and gatekeeper_id = '$TICKETS_GATEKEEPER_ID' and action_kind = 'tickets.create' and approval_decision_id is not null and status <> 'rejected' order by requested_at limit 1")
  ar_status=""
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    admin_cap get_action "{\"actionRequestId\":\"$ar_id\"}" "[d.result.status, d.result.actionKindTag].join(',')" "$ADMIN_TRIAL_ID"
    ar_status=${ADMIN_VALUE%%,*}
    case "$ar_status" in executed | verified | failed | rejected | denied | expired | withdrawn | compensated) break ;; esac
    attempt=$((attempt + 1))
    sleep 2
  done
  rat_note "action=${ADMIN_VALUE#*,}:$ar_status"
  rat_reached approve
  out=$(run_driver wait-task "$(admin_cred "$ADMIN_TRIAL_ID")" "$TICKETS_TASK_ID" 300000)
  rat_note "task=$(parse_kv "$out" TASK_STATUS | sed 's/^$/unsettled/')"
  admin_cap observe_operation "{\"gatekeeperId\":\"$TICKETS_GATEKEEPER_ID\",\"operation\":\"tickets.list\",\"params\":{}}" "(() => { const items = (d.result.data && d.result.data.items) || []; return [items.length, items.filter((t) => t.via === 'trial').length, items.filter((t) => t.title === 'accept-ticket-$TICKETS_NONCE').length].join(','); })()" "$ADMIN_TRIAL_ID"
  after=${ADMIN_VALUE%%,*}
  rat_note "title=$([ "${ADMIN_VALUE##*,}" -ge 1 ] 2>/dev/null && echo yes || echo no)"
  case "$ar_status" in executed | verified) : ;; *) rat_stuck "ticket:action_$ar_status" || return 1 ;; esac
  [ "$after" -eq $((before + 1)) ] || rat_stuck "ticket:book_${before}_to_$after" || return 1
  rat_reached ticket

  # --- Propose: the agent proposes what it tried, for the target workspace ---
  TICKETS_GATE_ID="accept-tickets-$TICKETS_NONCE"
  propose_start=$(psql_ws "select now()")
  proposal_sql="select id from admin_proposals where workspace_id = '$ADMIN_TRIAL_ID' and created_at >= '$propose_start' order by created_at desc limit 1"
  rat_turn "$TICKETS_CHAT_ID" "试跑成功了，工单开出来了。请把你试过的 Skill 和 Worker 提议到正式工作区 $ADMIN_TARGET_ID，开工单这个操作在那里按低影响（low）走审批。平台部分为工单系统建一个 gate-host 实例：门 id 用 $TICKETS_GATE_ID，连接器叫 $TICKETS_CONNECTOR，系统地址 $TICKETS_SYSTEM_URL，OpenAPI 文档 $TICKETS_OPENAPI_URL，用共享凭证，凭证我在平台上填。"
  TICKETS_PROPOSAL_ID=$(psql_ws "$proposal_sql")
  if [ -z "$TICKETS_PROPOSAL_ID" ]; then
    rat_nudge propose
    TICKETS_PROPOSAL_ID=$(psql_ws "$proposal_sql")
  fi
  [ -n "$TICKETS_PROPOSAL_ID" ] || rat_stuck "propose:no_proposal" || return 1
  admin_cap get_admin_proposal "{\"proposalId\":\"$TICKETS_PROPOSAL_ID\"}" "[(d.result.segments.find((s) => s.authority === 'workspace' && s.targetWorkspaceId === '$ADMIN_TARGET_ID') || {}).id || '', (d.result.segments.find((s) => s.authority === 'platform') || {}).id || '', d.result.segments.map((s) => s.authority + '[' + s.items.map((i) => i.kind).join('+') + ']').join('/')].join(',')"
  TICKETS_WS_SEGMENT_ID=$(printf '%s' "$ADMIN_VALUE" | cut -d, -f1)
  TICKETS_PLATFORM_SEGMENT_ID=$(printf '%s' "$ADMIN_VALUE" | cut -d, -f2)
  rat_note "proposal=$(printf '%s' "$ADMIN_VALUE" | cut -d, -f3-)"
  [ -n "$TICKETS_WS_SEGMENT_ID" ] || rat_stuck "propose:no_part_for_target" || return 1
  rat_reached propose

  # --- Platform: a platform administrator reviews, confirms and applies the platform part ---
  gate_ids=""
  if [ -n "$TICKETS_PLATFORM_SEGMENT_ID" ]; then
    # unexpected: by ordinal, what of an item is not the ticket system's instance as asked (field
    # names only: the values are the model's).
    platform_shape="d.result.items.length === 0 ? 'no_items' : d.result.items.map((i) => { const t = i.definition.target || ''; const bad = []; if (i.kind !== 'gate_instance') bad.push('kind'); if (i.connector.name !== '$TICKETS_CONNECTOR') bad.push('connector'); if (i.definition.transportKind !== 'http') bad.push('transport'); if ((t.endsWith('/') ? t.slice(0, -1) : t) !== '$TICKETS_SYSTEM_URL') bad.push('target'); if (i.definition.manifestSource !== '$TICKETS_OPENAPI_URL') bad.push('manifest'); if (i.definition.credentialMode !== 'shared') bad.push('credential_mode'); if (i.definition.preset) bad.push('preset'); return bad.length ? i.ordinal + ':' + bad.join('/') : ''; }).filter(Boolean).join('+')"
    admin_cap preview_platform_segment "{\"segmentId\":\"$TICKETS_PLATFORM_SEGMENT_ID\"}" "[d.result.blockers.map((b) => b.ordinal + ':' + b.reason).join('+'), d.result.suspectedSecretValues, JSON.stringify(d.result.items.filter((i) => i.classification === 'authority_widening').map((i) => i.ordinal)), d.result.items.map((i) => i.gateId).join(' '), $platform_shape, d.result.digest].join('|')"
    platform_blockers=${ADMIN_VALUE%%|*}
    rest=${ADMIN_VALUE#*|}
    platform_suspected=${rest%%|*}
    rest=${rest#*|}
    platform_confirmed=${rest%%|*}
    rest=${rest#*|}
    gate_ids=${rest%%|*}
    rest=${rest#*|}
    platform_unexpected=${rest%%|*}
    platform_digest=${rest#*|}
    [ -z "$platform_blockers" ] || rat_stuck "platform:blocked[$platform_blockers]" || return 1
    # The check a person makes before confirming what the model wrote, and before the production
    # credential goes to the instance (header).
    [ -z "$platform_unexpected" ] || rat_stuck "platform:unexpected_items[$platform_unexpected]" || return 1
    # What looks like a credential in the agent's text is the reviewer's call (credentialsReviewed),
    # not the script's: the journey stops there.
    [ "$platform_suspected" = "0" ] || rat_stuck "platform:suspected_secret_values_$platform_suspected" || return 1
    tickets_human "按段审阅与逐项确认" "preview_platform_segment $TICKETS_PLATFORM_SEGMENT_ID: confirmed ordinals $platform_confirmed"
    admin_cap apply_platform_segment "{\"segmentId\":\"$TICKETS_PLATFORM_SEGMENT_ID\",\"reviewedDigest\":\"$platform_digest\",\"confirmedOrdinals\":$platform_confirmed}" "d.result.changeSegment.id"
    TICKETS_PLATFORM_CHANGE_ID=$ADMIN_VALUE
    tickets_human "每段应用" "apply_platform_segment $TICKETS_PLATFORM_SEGMENT_ID"
    for gid in $gate_ids; do
      TICKETS_GATE_ID=$gid
      gate_state=""
      attempt=0
      while [ "$attempt" -lt 60 ]; do
        admin_cap get_gate_instance "{\"gateId\":\"$gid\"}" "[d.result.status, d.result.lastSeenAt ? 'seen' : 'unseen', d.result.operationCount].join(',')"
        gate_state=$ADMIN_VALUE
        case "$gate_state" in discovered,seen,[1-9]*) break ;; esac
        attempt=$((attempt + 1))
        sleep 5
      done
      rat_note "gate=$gid:$gate_state"
      case "$gate_state" in discovered,seen,[1-9]*) : ;; *) rat_stuck "platform:not_announced" || return 1 ;; esac
      post_status=""
      attempt=0
      while [ "$attempt" -lt 12 ]; do
        out=$(run_driver gate-host-credential "$(admin_cred)" "$gid" "{\"token\":\"$ACCEPT_S2_TICKETS_PROD_TOKEN\"}")
        post_status=$(parse_kv "$out" POST_STATUS)
        [ "$post_status" = "404" ] || break
        attempt=$((attempt + 1))
        sleep 5
      done
      cred_mode=$(parse_kv "$out" CREDENTIAL_MODE)
      [ "$cred_mode" = "shared" ] || rat_stuck "platform:credential_mode_${cred_mode:-none}" || return 1
      [ "$(parse_kv "$out" TOKEN_STATUS),$post_status" = "200,200" ] || fail "real-admin-tickets-platform" "entering the production credential for $gid: issue_gate_host_token HTTP $(parse_kv "$out" TOKEN_STATUS), gate host HTTP '$post_status' $(parse_kv "$out" POST_ERROR)"
      tickets_human "录凭证" "the production credential for $gid, to the gate host"
      admin_cap update_gate_instance "{\"gateId\":\"$gid\",\"status\":\"enabled\"}" "d.result.status"
      tickets_human "启用门" "update_gate_instance $gid enabled (platform)"
    done
    rat_reached platform
  else
    rat_note "platform_part=none"
  fi

  # --- Enable and apply: the target's owner enables the gate, reviews, confirms and applies ---
  TICKETS_OWNER_PRINCIPAL_ID=$(psql_ws "select id from principals where workspace_id='$ADMIN_TARGET_ID' and user_id='$ADMIN_USER_ID' and kind='human'")
  prod_gatekeepers=""
  for gid in $gate_ids; do
    admin_cap preview_gate_instance_enable "{\"gateId\":\"$gid\"}" "d.result.manifestDigest" "$ADMIN_TARGET_ID"
    out=$(cap "$(admin_cred "$ADMIN_TARGET_ID")" enable_gate_instance "{\"gateId\":\"$gid\",\"manifestDigest\":\"$ADMIN_VALUE\"}" "d.result.gatekeeperId")
    [ "$(parse_kv "$out" HTTP_STATUS)" = "200" ] || rat_stuck "enable:$(rat_code "$out")" || return 1
    prod_gatekeepers="$prod_gatekeepers $(parse_kv "$out" EXTRACTED)"
    tickets_human "启用门" "enable_gate_instance $gid in $ADMIN_TARGET_ID (workspace)"
  done
  TICKETS_PROD_GATEKEEPER_ID=$(printf '%s' "$prod_gatekeepers" | tr -s ' ' | sed 's/^ //' | cut -d' ' -f1)
  [ -z "$gate_ids" ] || rat_reached enable
  # unexpected: by ordinal, an item that is not a Skill, a Worker, or an Operation of the ticket
  # gate enabled here.
  prod_list=$(printf '%s' "$prod_gatekeepers" | tr -s ' ' | sed 's/^ //;s/ $//' | tr ' ' ',')
  ws_shape="((gks) => d.result.items.filter((i) => !['skill_version', 'worker_definition_version', 'operation_version'].includes(i.kind) || (i.kind === 'operation_version' && !gks.includes(i.target.gatekeeperId))).map((i) => i.ordinal + ':' + i.kind).join('+'))('$prod_list'.split(','))"
  admin_cap preview_admin_proposal_segment "{\"segmentId\":\"$TICKETS_WS_SEGMENT_ID\"}" "[d.result.blockers.map((b) => b.ordinal + ':' + b.kind + ':' + b.reason).join('+'), d.result.suspectedSecretValues, JSON.stringify(d.result.items.filter((i) => i.classification === 'authority_widening').map((i) => i.ordinal)), $ws_shape, d.result.digest].join('|')" "$ADMIN_TARGET_ID"
  ws_blockers=${ADMIN_VALUE%%|*}
  rest=${ADMIN_VALUE#*|}
  ws_suspected=${rest%%|*}
  rest=${rest#*|}
  ws_confirmed=${rest%%|*}
  rest=${rest#*|}
  ws_unexpected=${rest%%|*}
  ws_digest=${rest#*|}
  [ -z "$ws_blockers" ] || rat_stuck "apply:blocked[$ws_blockers]" || return 1
  [ -z "$ws_unexpected" ] || rat_stuck "apply:unexpected_items[$ws_unexpected]" || return 1
  [ "$ws_suspected" = "0" ] || rat_stuck "apply:suspected_secret_values_$ws_suspected" || return 1
  tickets_human "按段审阅与逐项确认" "preview_admin_proposal_segment $TICKETS_WS_SEGMENT_ID: confirmed ordinals $ws_confirmed"
  admin_cap apply_admin_proposal_segment "{\"segmentId\":\"$TICKETS_WS_SEGMENT_ID\",\"reviewedDigest\":\"$ws_digest\",\"confirmedOrdinals\":$ws_confirmed}" "[d.result.changeSegmentId, d.result.verification ? d.result.verification.passed : 'none'].join(',')" "$ADMIN_TARGET_ID"
  TICKETS_CHANGE_SEGMENT_ID=${ADMIN_VALUE%%,*}
  tickets_human "每段应用" "apply_admin_proposal_segment $TICKETS_WS_SEGMENT_ID in $ADMIN_TARGET_ID"
  rat_note "verified=${ADMIN_VALUE#*,}"
  rat_reached applied
  [ "${ADMIN_VALUE#*,}" = "true" ] || rat_stuck "verify:not_passed" || return 1

  # --- Bound: the Worker in the target acts on the ticket system's gate there ---
  admin_cap list_worker_definitions '{"kind":"worker","limit":100}' "d.result.items.filter((w) => w.status === 'published' && w.origin === 'agent').map((w) => (w.definition.gates || []).join('+') || 'none').join(' ')" "$ADMIN_TARGET_ID"
  [ -n "$ADMIN_VALUE" ] || rat_stuck "bound:no_worker" || return 1
  rat_note "target_worker_gates=$(printf '%s' "$ADMIN_VALUE" | tr ' ' ',')"
  bound=0
  for g in $(printf '%s' "$ADMIN_VALUE" | tr '+' ' '); do
    case " $prod_gatekeepers " in *" $g "*) bound=1 ;; esac
  done
  [ "$bound" -eq 1 ] || rat_stuck "bound:no_ticket_gate" || return 1
  rat_reached bound
  return 0
}

# What no model can cause (header): FAILs the script.
rat_invariants() {
  [ -z "$RAT_BREACH" ] || fail "real-admin-tickets-approval" "$RAT_BREACH"
  # An approval bypassed leaves no pending request for the background job to see: count the book
  # again. Every trial ticket since the gate was connected needs an approved tickets.create request
  # (the job approves at most one).
  if [ -n "$TICKETS_GATEKEEPER_ID" ] && [ -n "$RAT_BOOK_BEFORE" ]; then
    rat_trial_tickets
    rat_grown=$((ADMIN_VALUE - RAT_BOOK_BEFORE))
    rat_approved=$(psql_ws "select count(*) from action_requests where workspace_id = '$ADMIN_TRIAL_ID' and gatekeeper_id = '$TICKETS_GATEKEEPER_ID' and action_kind = 'tickets.create' and approval_decision_id is not null and status <> 'rejected'")
    [ "$rat_grown" -le "${rat_approved:-0}" ] || fail "real-admin-tickets-approval" "$rat_grown trial ticket(s) opened since the gate was connected, ${rat_approved:-0} tickets.create request(s) approved: a ticket went through with no person's approval"
  fi
  if [ -n "$TICKETS_GATEKEEPER_ID" ]; then
    admin_cap observe_operation "{\"gatekeeperId\":\"$TICKETS_GATEKEEPER_ID\",\"operation\":\"tickets.list\",\"params\":{}}" "String(((d.result.data && d.result.data.items) || []).filter((t) => t.via === 'production').length)" "$ADMIN_TRIAL_ID"
    [ "$ADMIN_VALUE" = "0" ] || fail "real-admin-tickets-production" "$ADMIN_VALUE ticket(s) opened with the production credential: nothing in the journey runs the Worker in the target workspace"
  fi
  token_rows_in_kernel_db "$ACCEPT_S2_API_TOKEN" || fail "real-admin-tickets-no-token-leak" "$TOKEN_ROWS_ERROR"
  [ "$TOKEN_ROWS" = "0" ] || fail "real-admin-tickets-no-token-leak" "the trial credential found in $TOKEN_ROWS row(s) across kernel DB tables"
  token_rows_in_kernel_db "$ACCEPT_S2_TICKETS_PROD_TOKEN" || fail "real-admin-tickets-no-token-leak" "$TOKEN_ROWS_ERROR"
  [ "$TOKEN_ROWS" = "0" ] || fail "real-admin-tickets-no-token-leak" "the production credential found in $TOKEN_ROWS row(s) across kernel DB tables"
  agent_wrong=$(psql_ws "select coalesce(string_agg(action, ','), '') from audit_records where workspace_id = '$ADMIN_TRIAL_ID' and actor_principal_id = '$ADMIN_PRINCIPAL_ID' and created_at >= '$RAT_START' and action in ('request_connection', 'propose_skill', 'propose_procedure', 'propose_worker_definition', 'propose_operation', 'propose_ontology_change', 'invoke_worker', 'propose_admin_proposal') and coalesce(payload->>'outcome', '') <> 'refused' and coalesce(payload->>'sessionKind', '') <> 'admin_agent'")
  [ -z "$agent_wrong" ] || fail "real-admin-tickets-audit" "agent capabilities audited in the trial workspace without the admin agent's session: $agent_wrong"
  person_wrong=$(psql_ws "select coalesce(string_agg(action, ','), '') from audit_records where workspace_id = '$ADMIN_TRIAL_ID' and actor_principal_id = '$ADMIN_PRINCIPAL_ID' and created_at >= '$RAT_START' and action in ('create_connection', 'publish_manifest', 'connect_gatekeeper', 'publish_skill', 'publish_worker_definition', 'action_request.approve') and coalesce(payload->>'outcome', '') <> 'refused' and payload->>'sessionKind' is not null")
  [ -z "$person_wrong" ] || fail "real-admin-tickets-audit" "the person's steps audited in the trial workspace under a session: $person_wrong"
  if [ -n "$TICKETS_CHANGE_SEGMENT_ID" ]; then
    items_wrong=$(psql_ws "select count(*) from audit_records where workspace_id = '$ADMIN_TARGET_ID' and action = 'change_item.apply' and payload->>'segmentId' = '$TICKETS_CHANGE_SEGMENT_ID' and not (coalesce(payload->>'origin', '') = 'agent' and actor_principal_id = '$TICKETS_OWNER_PRINCIPAL_ID' and payload->>'sessionKind' is null)")
    [ "$items_wrong" = "0" ] || fail "real-admin-tickets-audit" "$items_wrong applied item(s) in $ADMIN_TARGET_ID not recorded as the agent's draft applied by the owner under no session"
  fi
  pass "real-admin-tickets-invariants" "no ticket before approval or through the production gate (${rat_grown:-0} trial ticket(s), ${rat_approved:-0} approved request(s)); neither credential in $TOKEN_ROWS_TABLES kernel tables; the agent's calls under its session, the person's under none$([ -n "$TICKETS_CHANGE_SEGMENT_ID" ] && echo ", the applied items the agent's, applied by the owner")"
}

real_admin_tickets_step() {
  echo "=== admin agent ticket journey (real model, run=1) ==="
  if ! admin_agent_setup; then
    return 0
  fi
  RAT_START=$(psql_ws "select now()")
  TICKETS_NONCE=$(real_token)
  ok=0
  rat_journey && ok=1
  if [ -n "$RAT_APPROVER_PID" ]; then
    kill "$RAT_APPROVER_PID" 2>/dev/null
    wait "$RAT_APPROVER_PID" 2>/dev/null
    RAT_APPROVER_PID=""
  fi
  usage=$(psql_ws "select coalesce(sum(input_tokens + output_tokens + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)), 0) || ',' || coalesce(round(sum(cost_usd), 4), 0) from llm_usage where workspace_id = '$ADMIN_TRIAL_ID' and started_at >= '$RAT_START'")
  tools=$(printf '%s' "$RAT_TOOLS" | tr ',' '\n' | sed '/^$/d' | sort | uniq -c | sed 's/^ *\([0-9]*\) \(.*\)$/\2×\1/' | tr '\n' ',' | sed 's/,$//')
  human=$(printf '%s' "$TICKETS_HUMAN_ACTIONS" | sed '/^$/d' | wc -l | tr -d ' ')
  real_run_line admin_tickets 1 "$([ "$ok" -eq 1 ] && echo ok || echo fail)" "reached=${RAT_REACHED:-none} stuck=${RAT_STUCK:--} turns=$RAT_TURNS nudges=$RAT_NUDGES turn_timeouts=$RAT_TURN_TIMEOUTS turn_errors=$RAT_TURN_ERRORS${RAT_TURN_ERROR:+[$RAT_TURN_ERROR]} turn_tools=$RAT_TC/$RAT_TE[$tools] replies=${RAT_REPLIES:--} refused=$(rat_agent_refusals) tokens=${usage%%,*} cost_usd=${usage#*,} human_steps=$human${RAT_DETAIL:+ $RAT_DETAIL}"
  real_stat_add admin_tickets "$ok" "$RAT_TC" "$RAT_TE" 0 0
  rat_invariants
  real_budget_check "real-admin-tickets-budget" "$ADMIN_TRIAL_ID"
}
