# scripts/lib/accept-s2-admin-agent-pack.sh — S11 AA5d-4 (the AA5d plan's §3 rehearsal row): what
# the ticket journey (accept-s2-admin-agent-tickets.sh) applied to the target workspace and verified,
# exported as a pack, put in the extra packs directory by hand and installed in a third workspace —
# on the real stack. Run by scripts/accept_s2.sh in its fake-provider path right after
# `admin_agent_tickets_step` (`admin_agent_pack_step`) and cleaned up by its cleanup_step
# (`admin_agent_pack_cleanup`, before `admin_agent_tickets_cleanup`). Sourced after
# accept-s2-admin-agent-tickets.sh, whose globals (TICKETS_*) and helpers it uses, and
# accept-s2-admin-agent.sh (ADMIN_*, admin_cred, admin_cap); POSIX sh, same conventions (pass/fail,
# cap, parse_kv, run_driver, no temp file, no jq).
#
# The journey, the script playing the platform administrator, a maintainer and an owner:
#   1. the platform administrator exports the applied workspace part (`export_admin_proposal_pack`,
#      the console's 导出成能力包…): version 1 of a pack named by the proposal's source name, the two
#      Skills and the Worker (naming its system, never its gates or model), tickets.create's blast
#      radius left out (`omitted`) — a pack carries no Operation; asked again, the same files and
#      digest (exporting writes nothing);
#   2. a maintainer puts the files in `${NEXTTIME_DATA}/config/packs/` (docs/runbooks/operations.md
#      §14.10: what the console's tar holds, unpacked; root-owned, 0644 / 0755 — the kernel reads
#      it as uid 10001 through its read-only config/ mount, EXTRA_PACKS_DIR), into a directory that
#      is not there yet; the platform reads it as an extra pack (`extra_packs_status`), no restart;
#   3. the target workspace, where the part was applied, reads the pack `up_to_date`
#      (`source: extra`): its Skills and Worker are the families the source name derives, with the
#      content they were applied with — the gate the apply bound the Worker to is the workspace's
#      own, not a customization;
#   4. a third workspace (`accept-s2-pack-<nonce>`, the same owner): the pack is `not_installed`,
#      its system `can_enable` (the platform part's gate-host instance is offered); the owner
#      enables the gate there, previews the install (the Worker bound by the install to that
#      workspace's gate, the one candidate), confirms the widening items and installs; the install
#      verifies itself (`trigger: system`: three items in effect, the system connected, its gate
#      probed ok, the source found); the pack reads `up_to_date` with the same component ids as in
#      the target, and the Worker is published there bound to the third workspace's own gate.
# What the people did is printed (D-W5 evidence, AA5 plan §4 item 3): 导出, 放进附加包目录, 启用门,
# 按段审阅与逐项确认, 安装 — none of them is the admin agent's.
#
# Every workspace's 能力包 list offers the pack while it is in config/packs/ (that is what the
# directory is for): on a host, for the minutes between step 2 and cleanup.
#
# Runs only when the ticket journey applied its workspace part: otherwise one
# `NOTE admin-agent-pack …` line, as admin_agent_tickets_step's.
#
# Cleanup (admin_agent_pack_cleanup, logged, never failed — --keep or not, since the directory is
# read by every workspace): the install rolled back in the third workspace, that workspace disabled,
# then the pack's directory removed (only the one this run created, named accept-tickets-<nonce>).
# The gate it enabled there goes with the ticket journey's cleanup, which disables the gate-host
# instance.

PACK_NAME=""
PACK_DIR=""
PACK_WORKSPACE_ID=""
PACK_GATEKEEPER_ID=""
PACK_SEGMENT_ID=""
PACK_HUMAN_ACTIONS=""

# pack_human <kind> <what>: one thing a person did, logged and kept for the list at the end.
pack_human() {
  PACK_HUMAN_ACTIONS="${PACK_HUMAN_ACTIONS}$1
"
  echo "HUMAN admin-agent-pack $1: $2"
}

# pack_in <workspaceId>: the pack as list_packs reads it in that workspace —
# `<source>|<status>|<installedVersion>|<components sorted: kind:name:status:id>|<requirements:
# connector:state:offered gate ids>`, or `absent`.
pack_in() {
  admin_cap list_packs '{}' "(() => { const p = d.result.items.find((x) => x.name === '$PACK_NAME'); return p ? [p.source, p.status, p.installedVersion === null ? '-' : p.installedVersion, p.components.map((c) => [c.kind, c.name, c.status, c.skillId || c.definitionId || c.family].join(':')).sort().join('+'), p.requirements.map((r) => [r.connector, r.state, r.offered.map((o) => o.gateId).join('/')].join(':')).join('+')].join('|') : 'absent'; })()" "$1"
}

# pack_worker_in <workspaceId>: the pack's Worker as that workspace's Worker list reads it —
# `<id>,<status>,<gates>`, or `absent`.
pack_worker_in() {
  admin_cap list_worker_definitions '{"kind":"worker","limit":100}' "(() => { const w = d.result.items.find((x) => x.definition.name === 'accept-tickets-worker-$TICKETS_NONCE'); return w ? [w.id, w.status, (w.definition.gates || []).join('+')].join(',') : 'absent'; })()" "$1"
}

admin_agent_pack_step() {
  if [ -z "$TICKETS_CHANGE_SEGMENT_ID" ] || [ -z "$TICKETS_WS_SEGMENT_ID" ] || [ -z "$TICKETS_NONCE" ]; then
    echo "NOTE admin-agent-pack the admin proposal exported as a pack and installed in a third workspace not run: the ticket journey did not apply its workspace part (see its NOTE above)"
    return 0
  fi
  packs_root="${NEXTTIME_DATA}/config/packs"
  [ -d "$packs_root" ] || fail "admin-agent-pack-place" "$packs_root is not there — scripts/host-env-init.sh makes it (scripts/apply-release.sh on an older host); the kernel reads it as EXTRA_PACKS_DIR"
  expected_name="accept-tickets-$TICKETS_NONCE"
  pack_summary="Helpdesk tickets for the operations workspace (accept_s2 $TICKETS_NONCE)"
  pack_notes="Not in this pack: tickets.create's blast radius on $TICKETS_GATE_ID. Each workspace keeps its own."

  # --- 1. The platform administrator exports the applied workspace part ---
  export_params="{\"segmentId\":\"$TICKETS_WS_SEGMENT_ID\",\"summary\":\"$pack_summary\",\"notes\":\"$pack_notes\"}"
  admin_cap export_admin_proposal_pack "$export_params" "[d.result.name, d.result.version, d.result.digest, d.result.omitted.map((o) => [o.index, o.kind, o.gateId, o.name].join(':')).join('+'), d.result.files.map((f) => f.path).join('+')].join('|')"
  exported=$ADMIN_VALUE
  PACK_NAME=${exported%%|*}
  rest=${exported#*|}
  rest=${rest#*|}
  pack_digest=${rest%%|*}
  expected_files="$expected_name/1/pack.yaml+$expected_name/1/skills/accept-tickets-open-$TICKETS_NONCE.md+$expected_name/1/skills/accept-tickets-triage-$TICKETS_NONCE.md+$expected_name/1/workers/accept-tickets-worker-$TICKETS_NONCE.yaml"
  case "$pack_digest" in sha256:*) : ;; *) pack_digest="" ;; esac
  [ "$PACK_NAME" = "$expected_name" ] && [ -n "$pack_digest" ] && [ "$exported" = "$expected_name|1|$pack_digest|3:operation_version:$TICKETS_GATE_ID:tickets.create|$expected_files" ] || fail "admin-agent-pack-export" "export_admin_proposal_pack $TICKETS_WS_SEGMENT_ID reads '$exported', expected version 1 of $expected_name with a digest, tickets.create on $TICKETS_GATE_ID left out (item 3, an Operation) and the files $expected_files"
  pack_human "导出" "export_admin_proposal_pack $TICKETS_WS_SEGMENT_ID (the console's 导出成能力包…)"
  # Asked again: the same pack (exporting writes nothing). This read carries the files' content,
  # each base64 so a line holds it.
  admin_cap export_admin_proposal_pack "$export_params" "d.result.digest + '|' + d.result.files.map((f) => f.path + '=' + Buffer.from(f.content, 'utf8').toString('base64')).join(',')"
  [ "${ADMIN_VALUE%%|*}" = "$pack_digest" ] || fail "admin-agent-pack-export" "exporting $TICKETS_WS_SEGMENT_ID again gave digest '${ADMIN_VALUE%%|*}', expected the same $pack_digest"
  pack_files=${ADMIN_VALUE#*|}
  pass "admin-agent-pack-export" "the platform administrator exported the target's applied part as $PACK_NAME version 1 ($pack_digest): two Skills and the Worker, tickets.create's blast radius left out; the same pack when asked again"

  # --- 2. A maintainer puts the files in config/packs/ ---
  # Each path checked before anything is written: under <name>/1/, no `..`, no empty segment, the
  # characters a pack's names allow. The directory must not be there yet (operations.md §14.10:
  # `mv -T` refuses to nest a pack in one that is).
  [ ! -e "$packs_root/$PACK_NAME" ] || fail "admin-agent-pack-place" "$packs_root/$PACK_NAME is already there — a pack of this run's name left by another run? Remove it by hand after checking"
  for entry in $(printf '%s' "$pack_files" | tr ',' ' '); do
    rel=${entry%%=*}
    case "$rel" in
      "$PACK_NAME/1/"*) : ;;
      *) fail "admin-agent-pack-place" "the export named a file '$rel' outside $PACK_NAME/1/" ;;
    esac
    case "$rel" in
      *..* | *//* | */ | *[!A-Za-z0-9._/-]*) fail "admin-agent-pack-place" "the export named a file '$rel' this script does not write" ;;
    esac
  done
  PACK_DIR="$packs_root/$PACK_NAME"
  for entry in $(printf '%s' "$pack_files" | tr ',' ' '); do
    rel=${entry%%=*}
    dest="$packs_root/$rel"
    (umask 022 && mkdir -p "$(dirname "$dest")" && printf '%s' "${entry#*=}" | base64 -d >"$dest") || fail "admin-agent-pack-place" "could not write $dest"
  done
  placed=$(cd "$packs_root" && find "$PACK_NAME" -type f | LC_ALL=C sort | tr '\n' '+')
  [ "${placed%+}" = "$expected_files" ] || fail "admin-agent-pack-place" "$packs_root holds '${placed%+}' for $PACK_NAME, expected $expected_files"
  pack_human "放进附加包目录" "the exported files into $packs_root/$PACK_NAME/1/ (operations.md §14.10)"
  admin_cap extra_packs_status '{}' "[d.result.configured, d.result.unreadable === null ? '-' : d.result.unreadable, (d.result.packs.find((p) => p.name === '$PACK_NAME') || {}).latestVersion || 'absent', (d.result.skipped.find((s) => s.name === '$PACK_NAME') || {}).reason || '-'].join('|')"
  [ "$ADMIN_VALUE" = "true|-|1|-" ] || fail "admin-agent-pack-place" "extra_packs_status reads '$ADMIN_VALUE' (configured|unreadable|$PACK_NAME's latest version|why it is left out), expected true|-|1|- — docker compose logs kernel"
  pass "admin-agent-pack-place" "the files in $packs_root/$PACK_NAME/1/; the platform reads $PACK_NAME as an extra pack at version 1, nothing left out, no restart"

  # --- 3. The target workspace already has it ---
  pack_in "$ADMIN_TARGET_ID"
  target_pack=$ADMIN_VALUE
  target_components=$(printf '%s' "$target_pack" | cut -d'|' -f4)
  [ "$target_pack" = "extra|up_to_date|1|$target_components|$TICKETS_CONNECTOR:connected:" ] || fail "admin-agent-pack-target" "$PACK_NAME in the target $ADMIN_TARGET_ID reads '$target_pack', expected extra, up_to_date at version 1 and its system $TICKETS_CONNECTOR connected"
  case "$target_components" in
    "skill:accept-tickets-open-$TICKETS_NONCE:up_to_date:"?*"+skill:accept-tickets-triage-$TICKETS_NONCE:up_to_date:"?*"+worker:accept-tickets-worker-$TICKETS_NONCE:up_to_date:"?*) : ;;
    *) fail "admin-agent-pack-target" "$PACK_NAME's components in the target read '$target_components', expected the two Skills and the Worker, each up_to_date" ;;
  esac
  pack_worker_in "$ADMIN_TARGET_ID"
  target_worker=$ADMIN_VALUE
  worker_id=${target_worker%%,*}
  case "$target_components" in
    *"+worker:accept-tickets-worker-$TICKETS_NONCE:up_to_date:$worker_id") : ;;
    *) fail "admin-agent-pack-target" "the Worker in the target reads '$target_worker', but the pack's Worker is the family of '$target_components'" ;;
  esac
  [ "$target_worker" = "$worker_id,published,$TICKETS_PROD_GATEKEEPER_ID" ] || fail "admin-agent-pack-target" "the Worker in the target reads '$target_worker', expected published and still bound to $TICKETS_PROD_GATEKEEPER_ID"
  pass "admin-agent-pack-target" "the target $ADMIN_TARGET_ID reads $PACK_NAME up_to_date (extra): its Skills and Worker $worker_id are the pack's families, the Worker's gate there its own"

  # --- 4. A third workspace installs it ---
  model=${ACCEPT_S2_MODEL:-fake/fake-echo}
  admin_cap create_workspace "{\"name\":\"accept-s2-pack-$TICKETS_NONCE\",\"ownerUserId\":\"$ADMIN_USER_ID\",\"entryModel\":\"$model\"}" 'd.result.id'
  PACK_WORKSPACE_ID=$ADMIN_VALUE
  [ -n "$PACK_WORKSPACE_ID" ] || fail "admin-agent-pack-workspace" "create_workspace answered no id"
  pack_in "$PACK_WORKSPACE_ID"
  [ "$ADMIN_VALUE" = "extra|not_installed|-|$(printf '%s' "$target_components" | sed 's/:up_to_date:/:not_installed:/g')|$TICKETS_CONNECTOR:can_enable:$TICKETS_GATE_ID" ] || fail "admin-agent-pack-workspace" "$PACK_NAME in the new workspace $PACK_WORKSPACE_ID reads '$ADMIN_VALUE', expected extra, not_installed, the same components not installed, and $TICKETS_CONNECTOR can_enable from $TICKETS_GATE_ID"
  pass "admin-agent-pack-workspace" "workspace $PACK_WORKSPACE_ID: $PACK_NAME not installed, its system $TICKETS_CONNECTOR offered by the platform ($TICKETS_GATE_ID)"

  # The owner enables the gate here, as the target's owner did.
  admin_cap preview_gate_instance_enable "{\"gateId\":\"$TICKETS_GATE_ID\"}" "[d.result.wouldLink === null, d.result.awaitingPlatformAdoption === null, d.result.operationsToImport.map((o) => o.name).sort().join('+'), d.result.manifestDigest].join(',')" "$PACK_WORKSPACE_ID"
  case "$ADMIN_VALUE" in
    "true,true,tickets.create+tickets.get+tickets.list,"?*) : ;;
    *) fail "admin-agent-pack-enable" "preview_gate_instance_enable in $PACK_WORKSPACE_ID reads '$ADMIN_VALUE', expected a new link, nothing awaiting the platform, the three Operations to import and a manifest digest" ;;
  esac
  out=$(cap "$(admin_cred "$PACK_WORKSPACE_ID")" enable_gate_instance "{\"gateId\":\"$TICKETS_GATE_ID\",\"manifestDigest\":\"${ADMIN_VALUE##*,}\"}" "d.result.gatekeeperId")
  status=$(parse_kv "$out" HTTP_STATUS)
  [ "$status" = "200" ] || fail "admin-agent-pack-enable" "enable_gate_instance $TICKETS_GATE_ID in $PACK_WORKSPACE_ID HTTP $status: $(parse_kv "$out" BODY)"
  PACK_GATEKEEPER_ID=$(parse_kv "$out" EXTRACTED)
  [ -n "$PACK_GATEKEEPER_ID" ] || fail "admin-agent-pack-enable" "enable_gate_instance answered no gatekeeperId: $(parse_kv "$out" BODY)"
  pack_human "启用门" "enable_gate_instance $TICKETS_GATE_ID in $PACK_WORKSPACE_ID (from the pack's requirement)"
  pass "admin-agent-pack-enable" "the owner enabled $TICKETS_GATE_ID in $PACK_WORKSPACE_ID (Gatekeeper $PACK_GATEKEEPER_ID)"

  # The dry run: three items; the Worker, with no gates here, bound by the install to this
  # workspace's one gate of its system.
  admin_cap preview_pack_install "{\"name\":\"$PACK_NAME\"}" "[d.result.targetVersion, d.result.unchanged, d.result.breaking, d.result.items.map((i) => i.kind).join('+'), (() => { const w = d.result.items.find((i) => i.kind === 'worker_definition_version'); return w ? [w.classification, w.binding.source, w.binding.systems.join('+'), w.binding.candidates.map((c) => c.id + '/' + c.connector).join('+'), w.binding.gates.map((g) => g.id).join('+')].join(':') : 'absent'; })(), d.result.items.filter((i) => i.classification === 'authority_widening').map((i) => i.ordinal).join(','), d.result.digest].join('|')" "$PACK_WORKSPACE_ID"
  preview=$ADMIN_VALUE
  install_digest=${preview##*|}
  confirmed=$(printf '%s' "$preview" | cut -d'|' -f6)
  case "$preview" in
    "1|false|false|skill_version+skill_version+worker_definition_version|authority_widening:install:$TICKETS_CONNECTOR:$PACK_GATEKEEPER_ID/$TICKETS_CONNECTOR:$PACK_GATEKEEPER_ID|"?*"|sha256:"*) : ;;
    *) fail "admin-agent-pack-install" "preview_pack_install $PACK_NAME in $PACK_WORKSPACE_ID reads '$preview', expected version 1, not unchanged, not breaking, two Skills and the Worker, the Worker authority_widening and bound by this install to $PACK_GATEKEEPER_ID (its system's one gate here), the widening ordinals and a digest" ;;
  esac
  pack_human "按段审阅与逐项确认" "preview_pack_install $PACK_NAME in $PACK_WORKSPACE_ID: items $confirmed confirmed by their ordinals"
  admin_cap install_pack "{\"name\":\"$PACK_NAME\",\"version\":1,\"reviewedDigest\":\"$install_digest\",\"confirmedOrdinals\":[$confirmed]}" "[d.result.pack.source, d.result.pack.status, d.result.pack.installedVersion, d.result.segmentId, (() => { const v = d.result.verification; return v ? [v.trigger, v.passed, v.sourceFound, v.items.map((i) => i.state).join('+'), v.requirements.map((r) => [r.connector, r.state, r.met, r.gates.map((g) => g.id + '/' + g.health).join('+')].join(':')).join(';')].join(',') : 'null'; })()].join('|')" "$PACK_WORKSPACE_ID"
  PACK_SEGMENT_ID=$(printf '%s' "$ADMIN_VALUE" | cut -d'|' -f4)
  [ -n "$PACK_SEGMENT_ID" ] && [ "$ADMIN_VALUE" = "extra|up_to_date|1|$PACK_SEGMENT_ID|system,true,true,in_effect+in_effect+in_effect,$TICKETS_CONNECTOR:connected:true:$PACK_GATEKEEPER_ID/ok" ] || fail "admin-agent-pack-install" "install_pack $PACK_NAME in $PACK_WORKSPACE_ID reads '$ADMIN_VALUE', expected extra, up_to_date at version 1, its change segment, and the verification it ran: trigger system, passed, the source found, the three items in effect and $TICKETS_CONNECTOR connected and met, $PACK_GATEKEEPER_ID probed ok"
  pack_human "安装" "install_pack $PACK_NAME 1 in $PACK_WORKSPACE_ID"
  admin_cap get_change_segment "{\"segmentId\":\"$PACK_SEGMENT_ID\"}" "[d.result.segment.status, d.result.verification ? d.result.verification.trigger : 'none'].join(',')" "$PACK_WORKSPACE_ID"
  [ "$ADMIN_VALUE" = "verified,system" ] || fail "admin-agent-pack-install" "get_change_segment $PACK_SEGMENT_ID reads '$ADMIN_VALUE', expected verified by the install's own run (trigger system)"

  # The same families as in the target, and the Worker bound to this workspace's own gate.
  pack_in "$PACK_WORKSPACE_ID"
  [ "$ADMIN_VALUE" = "extra|up_to_date|1|$target_components|$TICKETS_CONNECTOR:connected:" ] || fail "admin-agent-pack-install" "$PACK_NAME in $PACK_WORKSPACE_ID reads '$ADMIN_VALUE' after the install, expected up_to_date at version 1 with the target's components ($target_components) and $TICKETS_CONNECTOR connected"
  pack_worker_in "$PACK_WORKSPACE_ID"
  [ "$ADMIN_VALUE" = "$worker_id,published,$PACK_GATEKEEPER_ID" ] || fail "admin-agent-pack-install" "the Worker in $PACK_WORKSPACE_ID reads '$ADMIN_VALUE', expected $worker_id (the target's), published, bound to $PACK_GATEKEEPER_ID"
  pass "admin-agent-pack-install" "the owner installed $PACK_NAME in $PACK_WORKSPACE_ID (change segment $PACK_SEGMENT_ID, verified by itself): the target's Skill and Worker ids, the Worker $worker_id bound to $PACK_GATEKEEPER_ID"

  summary=$(printf '%s' "$PACK_HUMAN_ACTIONS" | sort | uniq -c | sed 's/^ *\([0-9]*\) \(.*\)$/\2×\1/' | tr '\n' ' ')
  pass "admin-agent-pack-human" "what the people did to reuse it: $summary"
}

# Logged, never failed (header).
admin_agent_pack_cleanup() {
  if [ -n "$ADMIN_SESSION" ] && [ -n "$PACK_WORKSPACE_ID" ]; then
    if [ -n "$PACK_SEGMENT_ID" ]; then
      out=$(cap "$(admin_cred "$PACK_WORKSPACE_ID")" preview_roll_back_change_segment "{\"segmentId\":\"$PACK_SEGMENT_ID\"}" "JSON.stringify(d.result.items.filter((i) => i.classification === 'authority_widening').map((i) => i.ordinal))")
      confirmed=$(parse_kv "$out" EXTRACTED)
      out=$(cap "$(admin_cred "$PACK_WORKSPACE_ID")" roll_back_change_segment "{\"segmentId\":\"$PACK_SEGMENT_ID\",\"confirmedOrdinals\":${confirmed:-[]}}" "d.result.status")
      echo "cleanup: roll_back_change_segment $PACK_SEGMENT_ID in $PACK_WORKSPACE_ID HTTP $(parse_kv "$out" HTTP_STATUS) ($(parse_kv "$out" EXTRACTED))"
    fi
    out=$(cap "$(admin_cred)" set_workspace_status "{\"workspaceId\":\"$PACK_WORKSPACE_ID\",\"status\":\"disabled\"}")
    echo "cleanup: set_workspace_status disabled $PACK_WORKSPACE_ID HTTP $(parse_kv "$out" HTTP_STATUS)"
  fi
  [ -n "$PACK_DIR" ] || return 0
  case "$PACK_NAME" in
    accept-tickets-*) : ;;
    *)
      echo "cleanup: not removing $PACK_DIR — '$PACK_NAME' is not a name this script exports"
      return 0
      ;;
  esac
  if [ -n "$NEXTTIME_DATA" ] && [ "$PACK_DIR" = "$NEXTTIME_DATA/config/packs/$PACK_NAME" ]; then
    rm -rf -- "$PACK_DIR" && echo "cleanup: removed $PACK_DIR (the extra pack $PACK_NAME)" ||
      echo "cleanup: could not remove $PACK_DIR — remove it by hand: every workspace's 能力包 list offers $PACK_NAME while it is there"
  fi
  PACK_DIR=""
}
