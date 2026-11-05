# scripts/lib/accept-s2-admin-agent-tickets.sh — S11 AA5c (the AA5 plan's §5.8 journey, its trial
# half): in the trial workspace the admin agent scenario (accept-s2-admin-agent.sh) set up, the
# platform administrator's admin agent connects a test ticket system, looks at it, drafts what a
# ticket Worker needs and tries that Worker once — on the real runtime (real pi in the admin
# container, its admin agent Handle, the admin mode of packages/platform-extension, llm-proxy in
# front of fake-llm, which scripts the three Turns: deploy/fake-llm/server.mjs `tickets*Scenario`).
# Run by scripts/accept_s2.sh in its fake-provider path right after `admin_agent_step`
# (`admin_agent_tickets_step`) and cleaned up by its cleanup_step (`admin_agent_tickets_cleanup`,
# before `admin_agent_cleanup`). Sourced after accept-s2-admin-agent.sh, whose globals and helpers
# (ADMIN_*, admin_cred, admin_cap) it uses; POSIX sh, same conventions (pass/fail, cap, parse_kv,
# run_driver, no temp file, no jq).
#
# The system: the openapi fixture's ticket book (deploy/accept-s2/openapi-fixture, `/tickets`,
# seeded with two tickets) behind its own gate, `accept-s2-tickets-gate` (docker-compose.yml) —
# started here, with the connection secret minted in the trial workspace, because the trial
# workspace connects it on its own (a gate answers only the secret it was started with). The test
# credential is the run's ACCEPT_S2_API_TOKEN; the fixture records it on each ticket as `via:
# trial`.
#
# The journey, three Turns of one admin agent Chat, the script playing the person in between:
#   A. the agent asks for the ticket system to be connected (`request_connection`, http,
#      `helpdesk`); the request records its session;
#      the person completes the request card: enters the test credential (`create_connection`
#      naming the request, the OpenAPI document as its manifest source), publishes the three
#      imported Operations as read (`publish_manifest`), grants the gate to themselves
#      (`connect_gatekeeper` — the console's 系统访问 card; without it the Worker below could not
#      ask for an action on the gate);
#   B. the agent finds the ticket Operations, observes `tickets.list` through its projected observe
#      tool (its execute tool is never offered to it), drafts two Skills and a Worker that may ask
#      for actions on that gate; the person publishes the three drafts in the trial workspace;
#   C. the agent tries the Worker (`invoke_worker`); the Worker's `tickets.create` waits for a
#      decision; the person approves it; the ticket book then holds exactly one more ticket, opened
#      with the trial credential, and the Task records the agent's session.
# Then: who did what (the agent's calls under its session, the person's without one), the test
# credential in no kernel table, and the list of what the person had to do, checked against the
# plan's kinds: 录凭证, 试验工作区发布, 批准试验动作 — plus 授权门（试验）, which the plan's list leaves
# out and this run prints as a NOTE (evidence for decision gate D-W5, AA5 plan §4 item 3).
#
# Not here (AA5 plan, AA5c's second half): the admin proposal carrying the ticket system to a
# production workspace, its platform and workspace segments applied, the production credential.
#
# Runs only when the admin agent scenario did (its administrator signed in, its trial workspace
# set up): otherwise one `NOTE admin-agent-tickets …` line, as admin_agent_step's switch NOTE.
#
# Cleanup (admin_agent_tickets_cleanup, logged, never failed): nothing of its own to end — the gate
# container goes with cleanup_step's `rm -sf` of the accept-s2 containers, the Worker's Task is
# terminal on the success path (a still-running one is cancelled), and the trial workspace is
# disabled by admin_agent_cleanup; the ticket book is the fixture's memory and goes with its
# container. The tickets gate's data directory (its ConnectedAccount store) stays, as the other
# accept-s2 gates' do.

TICKETS_NONCE=""
TICKETS_CHAT_ID=""
TICKETS_SESSION_ID=""
TICKETS_GATEKEEPER_ID=""
TICKETS_TASK_ID=""
TICKETS_HUMAN_ACTIONS=""

# tickets_human <kind> <what>: one thing the person did, logged and kept for the list at the end.
tickets_human() {
  TICKETS_HUMAN_ACTIONS="${TICKETS_HUMAN_ACTIONS}$1
"
  echo "HUMAN admin-agent-tickets $1: $2"
}

# tickets_field <reply> <KEY>: the value of KEY=… in an agent reply (values carry no spaces).
tickets_field() {
  printf '%s' "$1" | sed -n "s/.*$2=\([^ ]*\).*/\1/p"
}

# tickets_turn <step> <chat|new:admin_agent> <text>: one admin agent Turn as the administrator in
# the trial workspace; FAILs <step> unless it completed with no tool call in error. Leaves the
# Chat in TICKETS_CHAT_ID, the tools it called in TICKETS_TURN_TOOLS and its reply in
# TICKETS_REPLY.
tickets_turn() {
  out=$(run_driver send-and-wait "$(admin_cred "$ADMIN_TRIAL_ID")" "$2" "$3" 180000)
  TICKETS_CHAT_ID=$(parse_kv "$out" CHAT_ID)
  turn_status=$(parse_kv "$out" TURN_STATUS)
  TICKETS_TURN_TOOLS=$(parse_kv "$out" TOOL_NAMES)
  turn_errors=$(parse_kv "$out" TOOL_ERRORS)
  [ -n "$TICKETS_CHAT_ID" ] || fail "$1" "no admin agent Chat: $(printf '%s' "$out" | grep -E '^(ERROR|HTTP_STATUS|TURN_STATUS)=' | tail -3)"
  [ "$turn_status" = "completed" ] || fail "$1" "the admin agent Turn $(parse_kv "$out" TURN_ID) ended '${turn_status:-not settled within 180s}', not completed (tools: '$TICKETS_TURN_TOOLS') — docker compose logs worker-supervisor"
  [ "$turn_errors" = "0" ] || fail "$1" "$turn_errors of the admin agent's calls ended in an error ($(parse_kv "$out" TOOL_ERROR_NAMES); tools: '$TICKETS_TURN_TOOLS')"
  TICKETS_REPLY=$(parse_kv "$(run_driver get-history "$(admin_cred "$ADMIN_TRIAL_ID")" "$TICKETS_CHAT_ID" "(d.filter(m=>m.role==='assistant').pop()||{}).text||''")" EXTRACTED)
  [ "$(tickets_field "$TICKETS_REPLY" TICKETS_TOOLS)" = "ok" ] || fail "$1" "the admin container offered the wrong tools for this Turn: '$TICKETS_REPLY'"
}

# tickets_book: the ticket book as the person reads it through the gate (observe_operation
# `tickets.list` in the trial workspace) — `<count>|<JSON of the tickets titled $1>`.
tickets_book() {
  admin_cap observe_operation "{\"gatekeeperId\":\"$TICKETS_GATEKEEPER_ID\",\"operation\":\"tickets.list\",\"params\":{}}" "(() => { const items = (d.result.data && d.result.data.items) || []; return items.length + '|' + JSON.stringify(items.filter((t) => t.title === '$1').map((t) => ({ via: t.via, priority: t.priority }))); })()" "$ADMIN_TRIAL_ID"
}

admin_agent_tickets_step() {
  if [ -z "$ADMIN_SESSION" ] || [ -z "$ADMIN_TRIAL_ID" ] || [ -z "$ADMIN_PRINCIPAL_ID" ]; then
    echo "NOTE admin-agent-tickets the admin agent ticket journey (connect, draft, try a Worker in the trial workspace) not run: the admin agent scenario did not run (see its NOTE above)"
    return 0
  fi
  TICKETS_NONCE=$(real_token)
  model=${ACCEPT_S2_MODEL:-fake/fake-echo}

  # The ticket system's gate, on a connection secret minted in the trial workspace.
  tickets_dir="${NEXTTIME_DATA}/accept-s2/tickets-gate"
  mkdir -p "$tickets_dir"
  chmod 777 "$tickets_dir"
  if [ ! -f "$tickets_dir/store.key" ]; then
    out=$(docker compose --profile accept-s2 run --rm --no-deps -T --entrypoint node accept-s2-tickets-gate \
      -e "require('fs').mkdirSync('/data/gate',{recursive:true});require('fs').writeFileSync('/data/gate/store.key', require('crypto').randomBytes(32));console.log('STOREKEY_OK')" \
      </dev/null 2>&1)
    case "$out" in
      *STOREKEY_OK*) : ;;
      *) fail "admin-agent-tickets-gate" "store.key generation failed: $out" ;;
    esac
  fi
  tickets_secret=$(mint_gate_secret "$(admin_cred "$ADMIN_TRIAL_ID")" "admin-agent-tickets-gate")
  [ -n "$tickets_secret" ] || fail "admin-agent-tickets-gate" "mint_connection_secret in the trial workspace returned no secret"
  tickets_token_file="$tickets_dir/kernel.token"
  write_gate_secret "$tickets_secret" "$tickets_token_file" || fail "admin-agent-tickets-gate" "could not write $tickets_token_file"
  up_out=$(docker compose --profile accept-s2 up -d --force-recreate accept-s2-tickets-gate 2>&1)
  [ $? -eq 0 ] || fail "admin-agent-tickets-gate" "docker compose up failed: $(printf '%s' "$up_out" | tail -20)"
  wait_for_gate_health "http://accept-s2-tickets-gate:8090" "$tickets_token_file" || fail "admin-agent-tickets-gate" "accept-s2-tickets-gate /gate/health never came back ok — docker compose logs accept-s2-tickets-gate"
  pass "admin-agent-tickets-gate" "accept-s2-tickets-gate healthy on its own connection secret $(redact "$tickets_secret") (minted in the trial workspace)"

  # --- Turn A: the agent asks for the ticket system ---
  tickets_turn "admin-agent-tickets-request" new:admin_agent "验收工单：接入工单系统 TICKETS_NONCE=$TICKETS_NONCE"
  [ "$TICKETS_TURN_TOOLS" = "request_connection" ] || fail "admin-agent-tickets-request" "the admin agent called '$TICKETS_TURN_TOOLS', expected request_connection"
  cr_id=$(tickets_field "$TICKETS_REPLY" TICKETS_CONNECTION_REQUEST)
  [ -n "$cr_id" ] || fail "admin-agent-tickets-request" "no connection request in the admin agent's reply: '$TICKETS_REPLY'"
  admin_cap get_admin_agent_status '{}' "(() => { const w = d.result.workspaces.find((x) => x.workspaceId === '$ADMIN_TRIAL_ID'); return w && w.session ? w.session.sessionId : ''; })()"
  TICKETS_SESSION_ID=$ADMIN_VALUE
  [ -n "$TICKETS_SESSION_ID" ] || fail "admin-agent-tickets-request" "get_admin_agent_status shows no open admin agent session in the trial workspace after the Turn"
  cr_row=$(psql_ws "select kind || ',' || target || ',' || status || ',' || (requested_by = '$ADMIN_PRINCIPAL_ID')::text || ',' || coalesce(admin_agent_session_id::text, '') from connection_requests where workspace_id = '$ADMIN_TRIAL_ID' and id = '$cr_id'")
  [ "$cr_row" = "http,helpdesk,requested,true,$TICKETS_SESSION_ID" ] || fail "admin-agent-tickets-request" "connection request $cr_id reads '$cr_row', expected http,helpdesk,requested,true,$TICKETS_SESSION_ID (requested by the administrator's Principal, under the admin agent's session)"
  pass "admin-agent-tickets-request" "the admin agent (Chat $TICKETS_CHAT_ID) asked for an http system 'helpdesk': request $cr_id, recorded under its session $TICKETS_SESSION_ID"

  # The person completes the request: the test credential straight to the gate's store.
  out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" create_connection \
    "{\"connectionRequestId\":\"$cr_id\",\"kind\":\"http\",\"target\":\"helpdesk\",\"endpoint\":\"http://accept-s2-tickets-gate:8090\",\"connectionSecret\":\"$tickets_secret\",\"credentials\":{\"token\":\"$ACCEPT_S2_API_TOKEN\"},\"credentialKind\":\"connected_account\",\"manifestSource\":\"http://accept-s2-openapi:8080/tickets/openapi.json\"}" \
    "d.result.gatekeeperId")
  tickets_secret=""
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "admin-agent-tickets-connect" "create_connection for request $cr_id HTTP $status: $(parse_kv "$out" BODY)"
  TICKETS_GATEKEEPER_ID=$(parse_kv "$out" EXTRACTED)
  [ -n "$TICKETS_GATEKEEPER_ID" ] || fail "admin-agent-tickets-connect" "no gatekeeperId in response: $(parse_kv "$out" BODY)"
  tickets_human "录凭证" "create_connection for the agent's request $cr_id with the test credential (the console's request card)"
  cr_row=$(psql_ws "select status || ',' || coalesce(gatekeeper_id::text, '') || ',' || (completed_by = '$ADMIN_PRINCIPAL_ID')::text from connection_requests where workspace_id = '$ADMIN_TRIAL_ID' and id = '$cr_id'")
  [ "$cr_row" = "completed,$TICKETS_GATEKEEPER_ID,true" ] || fail "admin-agent-tickets-connect" "connection request $cr_id reads '$cr_row' after create_connection, expected completed,$TICKETS_GATEKEEPER_ID,true"
  # Not by the trial workspace exception (#954): http here is self_serve, which this script
  # requires of the S2 workspace too (connections_step).
  http_mode=$(psql_ws "select mode from connectors where name = 'http'")
  trial_self=$(psql_ws "select count(*) from audit_records where workspace_id = '$ADMIN_TRIAL_ID' and action = 'connection.trial_self_connect'")
  [ "$http_mode,$trial_self" = "self_serve,0" ] || fail "admin-agent-tickets-connect" "connector http is '$http_mode' with $trial_self connection.trial_self_connect audit row(s) in the trial workspace, expected self_serve and none"
  pass "admin-agent-tickets-connect" "the person completed request $cr_id: Gatekeeper $TICKETS_GATEKEEPER_ID, credential sent to the gate (self-serve http, no trial exception used)"

  # The gate imported the OpenAPI document: two observe reads, one execute write.
  admin_cap list_operations "{\"gatekeeperId\":\"$TICKETS_GATEKEEPER_ID\"}" "d.result.items.map((o) => o.name + ':' + o.mode).sort().join(',')" "$ADMIN_TRIAL_ID"
  [ "$ADMIN_VALUE" = "tickets.create:execute,tickets.get:observe,tickets.list:observe" ] || fail "admin-agent-tickets-operations" "the ticket gate's Operations read '$ADMIN_VALUE', expected tickets.create:execute,tickets.get:observe,tickets.list:observe"
  out=$(publish_manifest_as_read "$(admin_cred "$ADMIN_TRIAL_ID")" "$TICKETS_GATEKEEPER_ID")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "admin-agent-tickets-operations" "publish_manifest HTTP $status: $(parse_kv "$out" BODY)"
  tickets_human "试验工作区发布" "publish_manifest: the ticket gate's three Operations, as read"
  pass "admin-agent-tickets-operations" "the gate imported the OpenAPI document as tickets.list / tickets.get (observe) and tickets.create (execute); published in the trial workspace"
  out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" connect_gatekeeper "{\"gatekeeperId\":\"$TICKETS_GATEKEEPER_ID\",\"principalId\":\"$ADMIN_PRINCIPAL_ID\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "admin-agent-tickets-grant" "connect_gatekeeper HTTP $status: $(parse_kv "$out" BODY)"
  tickets_human "授权门（试验）" "connect_gatekeeper: the ticket gate granted to the administrator (the console's 系统访问 card)"
  pass "admin-agent-tickets-grant" "the ticket gate granted to the administrator's Principal in the trial workspace"

  # --- Turn B: the agent looks and drafts ---
  tickets_turn "admin-agent-tickets-draft" "$TICKETS_CHAT_ID" "验收工单：起草工单 Worker TICKETS_NONCE=$TICKETS_NONCE WORKER_MODEL=$model"
  case "$TICKETS_TURN_TOOLS" in
    find_operations,*_tickets_list,propose_skill,propose_skill,propose_worker_definition) : ;;
    *) fail "admin-agent-tickets-draft" "the admin agent called '$TICKETS_TURN_TOOLS', expected find_operations, its <gate>_tickets_list tool, propose_skill twice, propose_worker_definition" ;;
  esac
  [ "$(tickets_field "$TICKETS_REPLY" TICKETS_DRAFTED)" = "yes" ] || fail "admin-agent-tickets-draft" "the admin agent drafted no Worker: '$TICKETS_REPLY'"
  [ "$(tickets_field "$TICKETS_REPLY" TICKETS_GATEKEEPER)" = "$TICKETS_GATEKEEPER_ID" ] || fail "admin-agent-tickets-draft" "find_operations led the agent to Gatekeeper '$(tickets_field "$TICKETS_REPLY" TICKETS_GATEKEEPER)', expected $TICKETS_GATEKEEPER_ID"
  seen=$(tickets_field "$TICKETS_REPLY" TICKETS_SEEN)
  case "$seen" in
    '' | *[!0-9]*) fail "admin-agent-tickets-draft" "the agent's tickets.list came back without tickets: '$TICKETS_REPLY'" ;;
  esac
  [ "$seen" -ge 2 ] || fail "admin-agent-tickets-draft" "the agent saw $seen ticket(s) through tickets.list, expected the fixture's two seeded ones at least"
  skills=$(tickets_field "$TICKETS_REPLY" TICKETS_SKILLS)
  worker=$(tickets_field "$TICKETS_REPLY" TICKETS_WORKER)
  worker_id=${worker%%:*}
  worker_version=${worker#*:}
  [ -n "$worker_id" ] && [ -n "$worker_version" ] && [ "$worker_id" != "$worker" ] || fail "admin-agent-tickets-draft" "no Worker draft in the reply: '$TICKETS_REPLY'"
  skill_ids=""
  skill_count=0
  for s in $(printf '%s' "$skills" | tr ',' ' '); do
    skill_ids="$skill_ids ${s%%:*}"
    skill_count=$((skill_count + 1))
  done
  [ "$skill_count" -eq 2 ] || fail "admin-agent-tickets-draft" "the reply names $skill_count Skill draft(s), expected two: '$skills'"
  for sid in $skill_ids; do
    admin_cap list_skills '{"limit":100}' "(() => { const s = d.result.items.find((x) => x.id === '$sid'); return s ? [s.status, s.origin].join(',') : 'absent'; })()" "$ADMIN_TRIAL_ID"
    [ "$ADMIN_VALUE" = "draft,agent" ] || fail "admin-agent-tickets-draft" "Skill $sid reads '$ADMIN_VALUE' in the trial workspace, expected draft,agent (a private draft the agent proposed)"
  done
  admin_cap list_worker_definitions '{"kind":"worker","includeOwnDrafts":true,"limit":100}' "(() => { const w = d.result.items.find((x) => x.id === '$worker_id' && x.version === $worker_version); return w ? [w.status, w.origin, (w.definition.gates || []).join('|'), (w.definition.capabilities || []).join('|')].join(',') : 'absent'; })()" "$ADMIN_TRIAL_ID"
  [ "$ADMIN_VALUE" = "draft,agent,$TICKETS_GATEKEEPER_ID,request_action" ] || fail "admin-agent-tickets-draft" "WorkerDefinition $worker_id@$worker_version reads '$ADMIN_VALUE', expected draft,agent,$TICKETS_GATEKEEPER_ID,request_action"
  pass "admin-agent-tickets-draft" "the admin agent saw $seen ticket(s) through its observe tool and drafted two Skills and Worker $worker_id@$worker_version (asks for actions on the ticket gate only); all private drafts, origin agent"

  # The person publishes the three drafts in the trial workspace.
  for s in $(printf '%s' "$skills" | tr ',' ' '); do
    sid=${s%%:*}
    rest=${s#*:}
    sver=${rest%%:*}
    sdigest=${rest#*:}
    out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" publish_skill "{\"skillId\":\"$sid\",\"version\":$sver,\"draftDigest\":\"$sdigest\"}" "d.result.status")
    status=$(parse_kv "$out" HTTP_STATUS)
    [ "$status" = "200" ] && [ "$(parse_kv "$out" EXTRACTED)" = "published" ] || fail "admin-agent-tickets-publish" "publish_skill $sid@$sver HTTP $status: $(parse_kv "$out" BODY)"
    tickets_human "试验工作区发布" "publish_skill $sid@$sver (the agent's draft)"
  done
  out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" publish_worker_definition "{\"definitionId\":\"$worker_id\",\"version\":$worker_version}" "d.result.status")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] && [ "$(parse_kv "$out" EXTRACTED)" = "published" ] || fail "admin-agent-tickets-publish" "publish_worker_definition $worker_id@$worker_version HTTP $status: $(parse_kv "$out" BODY)"
  tickets_human "试验工作区发布" "publish_worker_definition $worker_id@$worker_version (the agent's draft)"
  pass "admin-agent-tickets-publish" "the person published both Skills and Worker $worker_id@$worker_version in the trial workspace"

  # --- Turn C: the agent tries the Worker ---
  tickets_book "accept-ticket-$TICKETS_NONCE"
  before=${ADMIN_VALUE%%|*}
  tickets_turn "admin-agent-tickets-try" "$TICKETS_CHAT_ID" "验收工单：试跑工单 Worker TICKETS_DEFINITION=$worker_id TICKETS_VERSION=$worker_version TICKET_TITLE=accept-ticket-$TICKETS_NONCE"
  [ "$TICKETS_TURN_TOOLS" = "invoke_worker" ] || fail "admin-agent-tickets-try" "the admin agent called '$TICKETS_TURN_TOOLS', expected invoke_worker"
  TICKETS_TASK_ID=$(tickets_field "$TICKETS_REPLY" TICKETS_TASK_ID)
  [ -n "$TICKETS_TASK_ID" ] || fail "admin-agent-tickets-try" "no Task in the admin agent's reply: '$TICKETS_REPLY'"
  pass "admin-agent-tickets-try" "the admin agent started Worker $worker_id@$worker_version: Task $TICKETS_TASK_ID"

  # The Worker's tickets.create waits for a decision; the person approves it.
  ar_id=""
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" list_pending '{}' "String((((d.result.items||[]).filter(r=>r.gatekeeperId==='$TICKETS_GATEKEEPER_ID'))[0]||{}).id||'')")
    ar_id=$(parse_kv "$out" EXTRACTED)
    [ -n "$ar_id" ] && break
    attempt=$((attempt + 1))
    sleep 2
  done
  [ -n "$ar_id" ] || fail "admin-agent-tickets-approve" "no ActionRequest on the ticket gate pending the person's approval within 120s of Task $TICKETS_TASK_ID — docker compose logs worker-supervisor"
  admin_cap get_action "{\"actionRequestId\":\"$ar_id\"}" "[d.result.actionKindTag, d.result.status, d.result.onBehalfOf === '$ADMIN_PRINCIPAL_ID' ? 'administrator' : 'obo:' + d.result.onBehalfOf].join(',')" "$ADMIN_TRIAL_ID"
  [ "$ADMIN_VALUE" = "tickets.create,pending_approval,administrator" ] || fail "admin-agent-tickets-approve" "ActionRequest $ar_id reads '$ADMIN_VALUE', expected tickets.create,pending_approval,administrator"
  out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" approve "{\"actionRequestId\":\"$ar_id\"}" "")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "admin-agent-tickets-approve" "approve $ar_id HTTP $status: $(parse_kv "$out" BODY)"
  tickets_human "批准试验动作" "approve $ar_id: the Worker's tickets.create"
  ar_status=""
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    admin_cap get_action "{\"actionRequestId\":\"$ar_id\"}" "d.result.status" "$ADMIN_TRIAL_ID"
    ar_status=$ADMIN_VALUE
    case "$ar_status" in executed | verified | failed | rejected | denied | expired | withdrawn | compensated) break ;; esac
    attempt=$((attempt + 1))
    sleep 2
  done
  case "$ar_status" in executed | verified) : ;; *) fail "admin-agent-tickets-approve" "ActionRequest $ar_id reads '$ar_status' after approval, expected executed — docker compose logs accept-s2-tickets-gate" ;; esac
  out=$(run_driver wait-task "$(admin_cred "$ADMIN_TRIAL_ID")" "$TICKETS_TASK_ID" 180000)
  task_status=$(parse_kv "$out" TASK_STATUS)
  [ "$task_status" = "completed" ] || fail "admin-agent-tickets-approve" "Task $TICKETS_TASK_ID ended '${task_status:-not within 180s}', not completed — docker compose logs worker-supervisor"
  pass "admin-agent-tickets-approve" "the person approved the Worker's tickets.create ($ar_id): $ar_status, Task $TICKETS_TASK_ID completed"

  # Exactly one more ticket, opened with the trial credential.
  tickets_book "accept-ticket-$TICKETS_NONCE"
  after=${ADMIN_VALUE%%|*}
  mine=${ADMIN_VALUE#*|}
  [ "$mine" = '[{"via":"trial","priority":"normal"}]' ] || fail "admin-agent-tickets-book" "the ticket book holds '$mine' titled accept-ticket-$TICKETS_NONCE, expected one, opened with the trial credential, priority normal"
  [ "$after" -eq $((before + 1)) ] || fail "admin-agent-tickets-book" "the ticket book went from $before to $after ticket(s), expected exactly one more"
  pass "admin-agent-tickets-book" "the ticket book went from $before to $after: one ticket accept-ticket-$TICKETS_NONCE, opened with the trial credential"
  ar_count=$(psql_ws "select count(*) from action_requests where workspace_id = '$ADMIN_TRIAL_ID' and gatekeeper_id = '$TICKETS_GATEKEEPER_ID'")
  [ "$ar_count" = "1" ] || fail "admin-agent-tickets-book" "$ar_count ActionRequest(s) on the ticket gate, expected the one approved"

  # The Task records the agent's session; the session did not change across the three Turns.
  task_row=$(psql_ws "select status || ',' || (on_behalf_of = '$ADMIN_PRINCIPAL_ID')::text || ',' || coalesce(admin_agent_session_id::text, '') from tasks where workspace_id = '$ADMIN_TRIAL_ID' and id = '$TICKETS_TASK_ID'")
  [ "$task_row" = "completed,true,$TICKETS_SESSION_ID" ] || fail "admin-agent-tickets-task" "Task $TICKETS_TASK_ID reads '$task_row', expected completed,true,$TICKETS_SESSION_ID (for the administrator, under the admin agent's session)"
  admin_cap get_admin_agent_status '{}' "(() => { const w = d.result.workspaces.find((x) => x.workspaceId === '$ADMIN_TRIAL_ID'); return w && w.session ? w.session.sessionId : ''; })()"
  [ "$ADMIN_VALUE" = "$TICKETS_SESSION_ID" ] || fail "admin-agent-tickets-task" "the admin agent's session is now '$ADMIN_VALUE', expected the same $TICKETS_SESSION_ID across the three Turns"
  pass "admin-agent-tickets-task" "Task $TICKETS_TASK_ID: for the administrator, recorded under the admin agent's session $TICKETS_SESSION_ID"

  # Who did what: the agent's calls under its session, the person's under none.
  agent_rows=$(psql_ws "select string_agg(action, ',' order by action) from audit_records where workspace_id = '$ADMIN_TRIAL_ID' and actor_principal_id = '$ADMIN_PRINCIPAL_ID' and payload->>'sessionKind' = 'admin_agent' and payload->>'sessionId' = '$TICKETS_SESSION_ID' and action in ('request_connection', 'propose_skill', 'propose_worker_definition', 'invoke_worker')")
  [ "$agent_rows" = "invoke_worker,propose_skill,propose_skill,propose_worker_definition,request_connection" ] || fail "admin-agent-tickets-audit" "the agent's audit rows under its session read '$agent_rows', expected invoke_worker,propose_skill,propose_skill,propose_worker_definition,request_connection"
  person_rows=$(psql_ws "select string_agg(action || ':' || coalesce(payload->>'sessionKind', 'person'), ',' order by action) from audit_records where workspace_id = '$ADMIN_TRIAL_ID' and actor_principal_id = '$ADMIN_PRINCIPAL_ID' and action in ('create_connection', 'publish_skill', 'publish_worker_definition')")
  [ "$person_rows" = "create_connection:person,publish_skill:person,publish_skill:person,publish_worker_definition:person" ] || fail "admin-agent-tickets-audit" "the person's audit rows read '$person_rows', expected create_connection, publish_skill twice and publish_worker_definition, none under a session"
  approve_row=$(psql_ws "select string_agg(coalesce(payload->>'sessionKind', 'person'), ',') from audit_records where workspace_id = '$ADMIN_TRIAL_ID' and actor_principal_id = '$ADMIN_PRINCIPAL_ID' and action = 'action_request.approve' and resource_id = '$ar_id'")
  [ "$approve_row" = "person" ] || fail "admin-agent-tickets-audit" "the approval of $ar_id reads '$approve_row', expected one row by the administrator's Principal under no session"
  pass "admin-agent-tickets-audit" "audit: the agent's request, drafts and try under its session; the credential, the publishing and the approval by the person, under none"

  # The test credential is in no kernel table.
  token_rows_in_kernel_db "$ACCEPT_S2_API_TOKEN" || fail "admin-agent-tickets-no-token-leak" "$TOKEN_ROWS_ERROR"
  [ "$TOKEN_ROWS" = "0" ] || fail "admin-agent-tickets-no-token-leak" "the test credential found in $TOKEN_ROWS row(s) across kernel DB tables"
  pass "admin-agent-tickets-no-token-leak" "the test credential appears in 0 rows across all $TOKEN_ROWS_TABLES public tables"

  # What the person had to do, against the plan's kinds for the trial half.
  extra=""
  for kind in $(printf '%s' "$TICKETS_HUMAN_ACTIONS" | sort -u); do
    case "$kind" in
      录凭证 | 试验工作区发布 | 批准试验动作) : ;;
      授权门（试验）) extra="$kind" ;;
      *) fail "admin-agent-tickets-human" "the person did '$kind', not one of the plan's kinds (录凭证, 试验工作区发布, 批准试验动作)" ;;
    esac
  done
  summary=$(printf '%s' "$TICKETS_HUMAN_ACTIONS" | sort | uniq -c | sed 's/^ *\([0-9]*\) \(.*\)$/\2×\1/' | tr '\n' ' ')
  pass "admin-agent-tickets-human" "what the person did: $summary"
  [ -z "$extra" ] || echo "NOTE admin-agent-tickets $extra is a person's step the AA5 plan's §5.8 list leaves out: the Worker asks for actions only on gates its person holds (connect_gatekeeper on the 系统访问 card) — D-W5 evidence (AA5 plan §4 item 3)"
}

# Logged, never failed (header): a Task still running is cancelled; everything else goes with
# cleanup_step's `rm -sf` and admin_agent_cleanup.
admin_agent_tickets_cleanup() {
  [ -n "$TICKETS_TASK_ID" ] && [ -n "$ADMIN_SESSION" ] && [ -n "$ADMIN_TRIAL_ID" ] || return 0
  out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" get_task "{\"taskId\":\"$TICKETS_TASK_ID\"}" "d.result.status")
  task_status=$(parse_kv "$out" EXTRACTED)
  case "$task_status" in
    completed | failed | cancelled) echo "cleanup: ticket journey Task $TICKETS_TASK_ID already $task_status" ;;
    *)
      out=$(cap "$(admin_cred "$ADMIN_TRIAL_ID")" cancel_task "{\"taskId\":\"$TICKETS_TASK_ID\"}" "")
      echo "cleanup: cancel_task $TICKETS_TASK_ID (was '${task_status:-unread}') HTTP $(parse_kv "$out" HTTP_STATUS)"
      ;;
  esac
}
