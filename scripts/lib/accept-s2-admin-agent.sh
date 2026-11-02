# scripts/lib/accept-s2-admin-agent.sh — S11 AA4d (AA4 plan F9, its rehearsal half): a platform
# administrator's admin agent, on the real runtime, proposes one admin proposal. Run by
# scripts/accept_s2.sh in its fake-provider path (`admin_agent_step`, after step 9) and cleaned up by
# its cleanup_step (`admin_agent_cleanup`). Sourced by accept_s2.sh right after accept-common.sh;
# POSIX sh, same conventions (pass/fail, cap, parse_kv, run_driver, no temp file, no jq).
#
# What it proves, on the stack as deployed (real pi in the admin container worker-supervisor
# starts for an admin agent Turn, its admin agent Handle, the admin mode of
# packages/platform-extension, llm-proxy in front of fake-llm):
#   - the runtime: an admin agent Chat's Turn starts the admin container and completes — Docker
#     shows `nexttime-admin-<principal>` running with `nexttime.role=admin`, and no entry
#     container for that Principal;
#   - the tool list it starts with: the admin agent's tools are offered, the entry agent's are not
#     (fake-llm reports what pi offered the model, `ADMIN_TOOLS`);
#   - the ceiling and the per-call authority recheck on the real path: the agent's three calls
#     (`agent_list_proposal_targets`, `platform_state_connectors`, `propose_admin_proposal`) each
#     reach the kernel with the container's Handle, which re-checks on every call that its
#     person is still an administrator in an active trial workspace with the switch on, and land
#     where the kernel says they may: a proposal in the trial workspace, made by the agent
#     (`origin = agent`), to the target its person chose, audited under the Turn's session;
#   - what the agent reads back withholds the gate-host instance's address (`addressWithheld`).
# The refusals themselves (switch off, session ended, person no longer an administrator, no
# targets, an entry Turn) are the kernel's integration tests (fake-admin-propose.integration.test.ts,
# the admin-agent and gateway suites); here the positive path runs once, in the real container.
#
# The switch: ADMIN_AGENT_ENABLED is the host's kernel environment (secrets/kernel.env), and this
# script never turns it on. When the running kernel has it off, nothing here creates anything and
# one `NOTE admin-agent …` line says so (a NOTE, not a SKIP: the run still ends in "S2 OK") — the
# production host's default. scripts/staging-rehearsal.sh turns it on in its throwaway kernel.env
# and sets ACCEPT_REQUIRE_ADMIN_AGENT=1, which makes the switch being off a FAIL instead.
#
# Who acts: a platform administrator created for this run with the bootstrap CLI
# (`create-platform-admin --login accept-s2-admin-<nonce>`), its password random, sent through
# stdin, never printed and dropped once the console login has its session; the console session
# (a cookie, a secret like any key) reaches the driver as a console credential
# (`console:<workspaceId|->:<cookie>`, driver.mjs header) through the environment (R-34). It owns
# a trial workspace and a standard target workspace created here (create_workspace, both on this
# run's model), and chooses the target on the platform plane as the console's 平台 · 管理员智能体
# page does. The agent's proposal is never applied.
#
# Cleanup (admin_agent_cleanup, logged, never failed; with --keep too — a session and an
# administrator are not fixtures): the proposal withdrawn, the admin agent stopped (its session and
# Handle revoked), its container reclaimed, both workspaces disabled (their rows stay: audit only
# grows), the administrator demoted to a user, then signed out; each part's HTTP status is logged,
# the reclaim's too. A demotion the kernel refuses (the last active administrator, e.g. on a fresh
# staging host) is logged: what then remains is an administrator nobody can sign in as — its
# password existed only in this shell. So is an administrator created whose console login failed:
# nothing else exists then, and nothing here can demote it.

ADMIN_SESSION=""
ADMIN_USER_ID=""
ADMIN_LOGIN=""
ADMIN_TRIAL_ID=""
ADMIN_TARGET_ID=""
ADMIN_PRINCIPAL_ID=""
ADMIN_PROPOSAL_ID=""
ADMIN_NONCE=""

# 1 makes the switch being off a FAIL (scripts/staging-rehearsal.sh); otherwise a NOTE line.
ACCEPT_REQUIRE_ADMIN_AGENT="${ACCEPT_REQUIRE_ADMIN_AGENT:-0}"

# admin_cred [workspaceId]: the console credential of this run's administrator — in that
# workspace, or (none) on the platform plane alone.
admin_cred() {
  printf 'console:%s:%s' "${1:--}" "$ADMIN_SESSION"
}

# The running kernel's ADMIN_AGENT_ENABLED, as it read it at start (its environment — one
# variable, no secret).
admin_agent_switch() {
  docker compose exec -T kernel node -e "process.stdout.write(process.env.ADMIN_AGENT_ENABLED || '')" </dev/null 2>/dev/null
}

# admin_cap <name> <paramsJson> <expr> [workspaceId]: one call as the administrator; FAILs <name>
# on anything but 200, else leaves the extracted value in ADMIN_VALUE.
admin_cap() {
  ac_out=$(cap "$(admin_cred "${4:-}")" "$1" "$2" "$3")
  ac_status=$(parse_kv "$ac_out" HTTP_STATUS)
  [ "$ac_status" = "200" ] || fail "admin-agent-$1" "$1 HTTP $ac_status: $(parse_kv "$ac_out" BODY)"
  ADMIN_VALUE=$(parse_kv "$ac_out" EXTRACTED)
}

admin_agent_step() {
  switch=$(admin_agent_switch | tr 'A-Z' 'a-z')
  case "$switch" in
    1 | true) : ;;
    *)
      if [ "$ACCEPT_REQUIRE_ADMIN_AGENT" = "1" ]; then
        fail "admin-agent-switch" "ACCEPT_REQUIRE_ADMIN_AGENT=1 but the running kernel reads ADMIN_AGENT_ENABLED='${switch}' — set ADMIN_AGENT_ENABLED=1 in secrets/kernel.env before the stack starts"
      fi
      echo "NOTE admin-agent the admin agent scenario (real pi in its admin container proposing once) not run: the kernel reads ADMIN_AGENT_ENABLED='${switch:-unset}' — the platform switch stays off unless the maintainer turns it on (docs/runbooks/host-accept-s2.md)"
      return 0
      ;;
  esac

  # The administrator: the bootstrap CLI with a random password through stdin, then a console
  # login. The password lives in this function only.
  ADMIN_NONCE=$(real_token)
  ADMIN_LOGIN="accept-s2-admin-$ADMIN_NONCE"
  admin_pw=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  out=$(printf '%s' "$admin_pw" | docker compose run --rm --no-deps -T kernel node dist/cli/bootstrap.js create-platform-admin --login "$ADMIN_LOGIN" 2>&1)
  ADMIN_USER_ID=$(printf '%s\n' "$out" | sed -n 's/^platform admin created: //p')
  [ -n "$ADMIN_USER_ID" ] || { admin_pw=""; fail "admin-agent-administrator" "create-platform-admin: $(printf '%s' "$out" | tail -5)"; }
  out=$(run_driver login "$ADMIN_LOGIN" "$admin_pw")
  admin_pw=""
  ADMIN_SESSION=$(parse_kv "$out" SESSION)
  [ -n "$ADMIN_SESSION" ] || fail "admin-agent-administrator" "console login as $ADMIN_LOGIN: HTTP $(parse_kv "$out" HTTP_STATUS)"
  admin_cap get_admin_agent_status '{}' 'String(d.result.enabled)'
  [ "$ADMIN_VALUE" = "true" ] || fail "admin-agent-administrator" "get_admin_agent_status reads enabled=$ADMIN_VALUE while the kernel's environment has the switch on"
  pass "admin-agent-administrator" "platform administrator $ADMIN_USER_ID ($ADMIN_LOGIN) signed in to the console; the platform has the admin agent on"

  # Its trial workspace and one target, both on this run's model; the target chosen as the
  # console's page chooses it.
  model=${ACCEPT_S2_MODEL:-fake/fake-echo}
  admin_cap create_workspace "{\"name\":\"accept-s2-target-$ADMIN_NONCE\",\"ownerUserId\":\"$ADMIN_USER_ID\",\"entryModel\":\"$model\"}" 'd.result.id'
  ADMIN_TARGET_ID=$ADMIN_VALUE
  admin_cap create_workspace "{\"name\":\"accept-s2-trial-$ADMIN_NONCE\",\"ownerUserId\":\"$ADMIN_USER_ID\",\"entryModel\":\"$model\",\"purpose\":\"admin_trial\"}" '[d.result.id, d.result.purpose].join(",")'
  ADMIN_TRIAL_ID=${ADMIN_VALUE%%,*}
  [ "${ADMIN_VALUE#*,}" = "admin_trial" ] || fail "admin-agent-workspaces" "the trial workspace reads purpose '${ADMIN_VALUE#*,}', expected admin_trial"
  admin_cap set_admin_agent_targets "{\"trialWorkspaceId\":\"$ADMIN_TRIAL_ID\",\"targetWorkspaceIds\":[\"$ADMIN_TARGET_ID\"]}" 'd.result.targets.map((t) => t.workspaceId).join(",")'
  [ "$ADMIN_VALUE" = "$ADMIN_TARGET_ID" ] || fail "admin-agent-workspaces" "set_admin_agent_targets answered targets '$ADMIN_VALUE', expected $ADMIN_TARGET_ID"
  admin_cap get_admin_agent_status '{}' "(() => { const w = d.result.workspaces.find((x) => x.workspaceId === '$ADMIN_TRIAL_ID'); return w ? String(w.refusal) : 'absent'; })()"
  [ "$ADMIN_VALUE" = "null" ] || fail "admin-agent-workspaces" "get_admin_agent_status reads refusal '$ADMIN_VALUE' for the trial workspace, expected none"
  ADMIN_PRINCIPAL_ID=$(psql_ws "select id from principals where workspace_id='$ADMIN_TRIAL_ID' and user_id='$ADMIN_USER_ID' and kind='human'")
  [ -n "$ADMIN_PRINCIPAL_ID" ] || fail "admin-agent-workspaces" "no Principal of $ADMIN_USER_ID in the trial workspace $ADMIN_TRIAL_ID"
  pass "admin-agent-workspaces" "trial workspace $ADMIN_TRIAL_ID (admin_trial) and target $ADMIN_TARGET_ID; the admin agent may start in the trial workspace and propose to the target"

  # The Turn: a new admin agent Chat in the trial workspace; fake-llm scripts the three calls
  # (deploy/fake-llm/server.mjs adminAgentProposeChatScenario).
  out=$(run_driver send-and-wait "$(admin_cred "$ADMIN_TRIAL_ID")" new:admin_agent "提一份验收管理员提案 ADMIN_NONCE=$ADMIN_NONCE" 180000)
  admin_chat_id=$(parse_kv "$out" CHAT_ID)
  admin_turn_status=$(parse_kv "$out" TURN_STATUS)
  admin_tools=$(parse_kv "$out" TOOL_NAMES)
  admin_tool_errors=$(parse_kv "$out" TOOL_ERRORS)
  [ -n "$admin_chat_id" ] || fail "admin-agent-turn" "no admin agent Chat: $(printf '%s' "$out" | grep -E '^(ERROR|HTTP_STATUS|TURN_STATUS)=' | tail -3)"
  [ "$admin_turn_status" = "completed" ] || fail "admin-agent-turn" "the admin agent Turn $(parse_kv "$out" TURN_ID) ended '${admin_turn_status:-not settled within 180s}', not completed (tools: '$admin_tools') — docker compose logs worker-supervisor"
  [ "$admin_tools" = "agent_list_proposal_targets,platform_state_connectors,propose_admin_proposal" ] || fail "admin-agent-turn" "the admin agent called '$admin_tools', expected agent_list_proposal_targets,platform_state_connectors,propose_admin_proposal"
  [ "$admin_tool_errors" = "0" ] || fail "admin-agent-turn" "$admin_tool_errors of the admin agent's calls ended in an error ($(parse_kv "$out" TOOL_ERROR_NAMES))"

  # The container the Turn ran in, as Docker has it (#481 on #949): worker-supervisor's admin
  # container for the administrator's Principal in the trial workspace (resident-kind.ts,
  # spawn-spec.ts labels), running; and no entry container for that Principal — the Turn was not
  # served by the entry runtime.
  admin_container="nexttime-admin-$ADMIN_PRINCIPAL_ID"
  admin_seen=$(docker inspect -f '{{.State.Running}} {{index .Config.Labels "nexttime.role"}} {{index .Config.Labels "nexttime.principal"}} {{index .Config.Labels "nexttime.workspace"}}' "$admin_container" 2>/dev/null)
  [ "$admin_seen" = "true admin $ADMIN_PRINCIPAL_ID $ADMIN_TRIAL_ID" ] || fail "admin-agent-container" "container $admin_container reads '${admin_seen:-absent}', expected running, nexttime.role=admin, nexttime.principal=$ADMIN_PRINCIPAL_ID, nexttime.workspace=$ADMIN_TRIAL_ID"
  ! docker inspect "nexttime-entry-$ADMIN_PRINCIPAL_ID" >/dev/null 2>&1 || fail "admin-agent-container" "an entry container nexttime-entry-$ADMIN_PRINCIPAL_ID exists for the administrator's Principal in the trial workspace: the admin agent Turn should start only its admin container"
  pass "admin-agent-container" "the Turn ran in $admin_container (running, nexttime.role=admin, the administrator's Principal in the trial workspace); no entry container for that Principal"
  admin_reply=$(parse_kv "$(run_driver get-history "$(admin_cred "$ADMIN_TRIAL_ID")" "$admin_chat_id" "(d.filter(m=>m.role==='assistant').pop()||{}).text||''")" EXTRACTED)
  ADMIN_PROPOSAL_ID=$(printf '%s' "$admin_reply" | sed -n 's/.*ADMIN_PROPOSAL_ID=\([0-9a-f-]*\).*/\1/p')
  case "$admin_reply" in
    *"ADMIN_TOOLS=ok"*) : ;;
    *) fail "admin-agent-tools" "the admin container offered the model the wrong tools: '$admin_reply'" ;;
  esac
  pass "admin-agent-tools" "the admin container offered the admin agent's tools and none of the entry agent's"
  [ -n "$ADMIN_PROPOSAL_ID" ] || fail "admin-agent-proposed" "no proposal in the admin agent's reply: '$admin_reply'"
  case "$admin_reply" in
    *"ADMIN_PROPOSAL_STATUS=proposed"*"ADMIN_TARGETS=1"*) : ;;
    *) fail "admin-agent-proposed" "propose_admin_proposal did not answer a proposed proposal to one target: '$admin_reply'" ;;
  esac
  case "$admin_reply" in
    *"ADMIN_ADDRESS_WITHHELD=yes"*) : ;;
    *) fail "admin-agent-address-withheld" "the agent read its gate-host instance back with an address: '$admin_reply'" ;;
  esac
  pass "admin-agent-proposed" "the admin agent (Chat $admin_chat_id) proposed $ADMIN_PROPOSAL_ID to its one target; it read the gate-host instance back without its address"

  # The proposal as the administrator reads it on the platform plane: the agent's, one workspace
  # segment for the chosen target and the platform segment, nothing decided.
  admin_cap get_admin_proposal "{\"proposalId\":\"$ADMIN_PROPOSAL_ID\"}" "(() => { const s = d.result.segments; const w = s.filter((x) => x.authority === 'workspace'); const p = s.filter((x) => x.authority === 'platform'); return [d.result.origin, w.map((x) => x.targetWorkspaceId).join('|'), p.length, p.length ? p[0].items.map((i) => i.kind).join('|') : '', s.every((x) => x.status === 'proposed')].join(','); })()"
  [ "$ADMIN_VALUE" = "agent,$ADMIN_TARGET_ID,1,gate_instance,true" ] || fail "admin-agent-proposal" "proposal $ADMIN_PROPOSAL_ID reads '$ADMIN_VALUE', expected agent,$ADMIN_TARGET_ID,1,gate_instance,true (made by the agent, one segment for the target, a platform segment with one gate-host instance, all still proposed)"
  pass "admin-agent-proposal" "proposal $ADMIN_PROPOSAL_ID: made by the agent, a segment for the chosen target and a platform segment, nothing decided"

  # Its audit row in the trial workspace: the administrator's Principal, under the admin agent's
  # session — the one get_admin_agent_status shows open (the kernel stamps sessionKind/sessionId
  # on every call through an admin agent Handle).
  admin_cap get_admin_agent_status '{}' "(() => { const w = d.result.workspaces.find((x) => x.workspaceId === '$ADMIN_TRIAL_ID'); return w && w.session ? w.session.sessionId : ''; })()"
  admin_session_id=$ADMIN_VALUE
  [ -n "$admin_session_id" ] || fail "admin-agent-audit" "get_admin_agent_status shows no open admin agent session in the trial workspace after the Turn"
  admin_cap audit_query '{"filter":{"action":"propose_admin_proposal"},"limit":10}' "d.result.items.filter((r) => r.resourceId === '$ADMIN_PROPOSAL_ID').map((r) => [r.actorPrincipalId === '$ADMIN_PRINCIPAL_ID' ? 'administrator' : 'actor:' + r.actorPrincipalId, r.payload.sessionKind, r.payload.sessionId === '$admin_session_id' ? 'session' : 'other-session:' + r.payload.sessionId].join(':')).join(',')" "$ADMIN_TRIAL_ID"
  [ "$ADMIN_VALUE" = "administrator:admin_agent:session" ] || fail "admin-agent-audit" "the trial workspace's propose_admin_proposal audit rows for $ADMIN_PROPOSAL_ID read '$ADMIN_VALUE', expected one, by the administrator's Principal $ADMIN_PRINCIPAL_ID as admin_agent under session $admin_session_id"
  pass "admin-agent-audit" "one propose_admin_proposal audit row in the trial workspace: the administrator's Principal, as its admin agent, under the open session"
}

# Logged, never failed (header). Runs whether or not the step got far; each part only when what
# it ends exists.
admin_agent_cleanup() {
  if [ -z "$ADMIN_SESSION" ]; then
    # Created, but its console login failed (#488 on #949): nothing else was made, and nothing can
    # demote it from here — the bootstrap CLI only creates. Say so, so it is not left unnoticed.
    [ -z "$ADMIN_USER_ID" ] || echo "cleanup: administrator $ADMIN_USER_ID ($ADMIN_LOGIN) was created but its console login failed — it stays an active administrator nobody can sign in as (its password existed only in this shell); demote it on 平台 · 用户"
    return 0
  fi
  if [ -n "$ADMIN_PROPOSAL_ID" ]; then
    out=$(cap "$(admin_cred)" withdraw_admin_proposal "{\"proposalId\":\"$ADMIN_PROPOSAL_ID\",\"reason\":\"accept_s2 admin agent scenario: never applied\"}")
    echo "cleanup: withdraw_admin_proposal $ADMIN_PROPOSAL_ID HTTP $(parse_kv "$out" HTTP_STATUS)"
  fi
  if [ -n "$ADMIN_TRIAL_ID" ]; then
    out=$(cap "$(admin_cred)" stop_admin_agent "{\"trialWorkspaceId\":\"$ADMIN_TRIAL_ID\"}")
    echo "cleanup: stop_admin_agent in $ADMIN_TRIAL_ID HTTP $(parse_kv "$out" HTTP_STATUS)"
    # Its admin container (and an entry container, had one started): removed, not just stopped.
    if [ -n "$ADMIN_PRINCIPAL_ID" ]; then
      out=$(resident_reclaim "$ADMIN_PRINCIPAL_ID")
      reclaim_status=$(parse_kv "$out" STATUS)
      echo "cleanup: /resident/reclaim $ADMIN_PRINCIPAL_ID ${reclaim_status:+HTTP $reclaim_status}${reclaim_status:-failed: $(printf '%s' "$out" | tail -n 1)}"
    fi
  fi
  for admin_ws in $ADMIN_TRIAL_ID $ADMIN_TARGET_ID; do
    out=$(cap "$(admin_cred)" set_workspace_status "{\"workspaceId\":\"$admin_ws\",\"status\":\"disabled\"}")
    echo "cleanup: set_workspace_status disabled $admin_ws HTTP $(parse_kv "$out" HTTP_STATUS)"
  done
  out=$(cap "$(admin_cred)" update_user "{\"userId\":\"$ADMIN_USER_ID\",\"platformRole\":\"user\"}")
  status=$(parse_kv "$out" HTTP_STATUS)
  if [ "$status" = "200" ]; then
    echo "cleanup: administrator $ADMIN_USER_ID demoted to user"
  else
    echo "cleanup: administrator $ADMIN_USER_ID not demoted (HTTP $status: $(parse_kv "$out" BODY)) — it stays an administrator nobody can sign in as"
  fi
  out=$(run_driver logout "$(admin_cred)")
  echo "cleanup: console logout HTTP $(parse_kv "$out" HTTP_STATUS)"
  ADMIN_SESSION=""
}
