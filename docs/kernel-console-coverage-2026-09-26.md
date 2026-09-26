# Kernel capabilities × call chains × console coverage map

Scope: `packages/kernel/src/application/gateway/handlers.ts` (`CAPABILITY_HANDLERS`, single
registry — no separate `platform-handlers.ts` registry, it only exports handler functions that
this one map imports), `packages/shared/src/capabilities.ts` (the capability catalogue), and
`packages/web/src` (console caller sites), `packages/platform-extension/src/modes/{entry,worker,
gate-tools}.ts` + `ontology/entry-agent.yaml` (agent-side exposure). Read-only inventory, no repo
files modified.

## Summary

- **161 capabilities** wired end-to-end (`CAPABILITY_HANDLERS` has exactly 161 entries; every name
  matches one row in `packages/shared/src/capabilities.ts`, 1:1, no orphans either direction).
- Mode split: **72 observe / 58 write / 25 execute / 6 propose**. Channel split: **119 human-only /
  42 handle-eligible** (channel `handle` means "human or Handle caller", not "agent-only" —
  confirmed from `authorize.ts`'s own doc comment).
- Domain split (`group`): platform 46, governance 17, connection 16, meta 16, chat 9, epistemic 9,
  members 9, graph 8, task 8, ontology 5, worker 5, agent_profile 4, modules 3, audit 3, ingest 2,
  gate 1.
- **19 capabilities have zero console caller** (no `http.call('<name>', …)`, no `useCapability*`
  hook, nowhere in `packages/web/src`, tests included):
  `list_user_memberships`, `get_gate_instance`, `refresh_operation_governance`, `traverse`,
  `assert_fact`, `supersede_fact`, `invalidate_fact`, `request_action`, `find_workers`,
  `find_operations`, `find_procedures`, `connect_gatekeeper`, `get_type`, `validate`,
  `propose_ontology_change`, `publish_ontology_version`, `register_source`,
  `submit_observations`, `list_runtime_images`.
  Of these, 9 are legitimately agent-only (entry/worker-mode tools: `traverse`, `request_action`,
  `find_workers`, `find_operations`, `find_procedures`, plus the 7 counted separately below that
  *do* have a console touchpoint through the `issue_handle` scope picker). The remaining ~10 are
  real console gaps — see Gap list.
- **7 more capabilities have no direct `http.call`** but the console does touch them as
  selectable rows in the `issue_handle` / `issue_service_handle` scope-picker form
  (`lib/entry-ceiling.ts`): `get_entry_context`, `report_turn`, `record_decision`, `invoke_worker`,
  `list_allowed_operations`, `report_task_result`, `observe_operation`. Not a UI gap — a human
  cannot meaningfully "click" these (they are worker/entry-agent callbacks), the console's only
  legitimate role is letting an owner include them in a Handle's granted scope.
- **21 of 23 routed pages still import legacy `components/ui/*`** per
  `scripts/guards/legacy-ui-importers.json`; only `systems/SystemsPage.tsx` and
  `platform/PlatformResiduePage.tsx` are fully migrated to `components/kit/*`.
- Agent exposure is narrow and deliberate: the built-in **entry agent** (`ontology/entry-agent.yaml`
  + `modes/entry.ts`) gets a fixed 21-capability tool set; the **worker** runtime
  (`modes/worker.ts`) gets 5; a further ~23 (`lib/entry-ceiling.ts`'s `entryCeilingCapabilities()`
  — every `group:'graph'` + every `propose_*` + 10 fixed extras) are *issuable* to a self-service
  Handle via `issue_handle`/`issue_service_handle`, but not otherwise agent-wired. Everything else
  (~120 capabilities) is human/console/platform-only by design.

### Top 10 gaps ranked by user impact

1. **No ontology governance UI at all** — `get_type`, `validate`, `propose_ontology_change`,
   `publish_ontology_version` have zero console callers. An owner/builder cannot review a type,
   dry-run a change, or publish an ontology version from the console despite the capability, role
   and mode being fully modeled in `packages/shared`. Ontology changes today are API/CLI-only.
2. **No manual fact-correction UI beyond conflict resolution** — `assert_fact`, `supersede_fact`,
   `invalidate_fact` are unused. The only human-facing fact actions are `verify_fact` (mark
   verified) and `resolve_conflict` (pick a winner among existing candidates); there is no way for
   an owner to manually assert or correct a Fact from the console.
3. **`roll_entry_containers` has no confirm/impact dialog** — it force-rebuilds live entry
   containers (optionally scoped, but with none selected it hits every idle container
   platform-wide) on a single button click, on the same page (`PlatformRuntimePage.tsx`) where its
   two siblings (`set_active_runtime_image`, `rollback_runtime_image`) both use a `tier="medium"`
   `Confirm` with descriptive impact text. Inconsistent, and the riskier of the three by blast
   radius.
4. **`connect_gatekeeper` looks unfinished** — zero console callers; only a permission test and a
   doc comment in `ConnectSystemLauncher.tsx` describing it as a still-planned step
   ("→ grant a member (`connect_gatekeeper`)"). Either dead code or a half-finished flow.
5. **`refresh_operation_governance` (S8 W3-K1, "the write half of `preview_gate_instance_enable`'s
   diff") has zero console callers** — the read half (`preview_gate_instance_enable`) is wired into
   `EnableGateConfirm.tsx`; its write counterpart never got a caller. Likely an incomplete follow-up.
6. **`get_gate_instance` is dead** — every gate-instance detail view, including the
   `#/platform/integrations` deep-link path, resolves its row by client-side filtering
   `list_gate_instances`/`list_available_gate_instances` instead of calling the dedicated
   single-object getter. Candidate for removal, or for actually using it on cold-load deep links.
7. **`list_runtime_images` duplicates `runtime_inventory`** — `PlatformRuntimePage.tsx`'s own doc
   comment confirms `runtime_inventory` already returns "the full image inventory"; the standalone
   list capability has no caller and no reason to exist as a separate read model.
8. **`list_user_memberships` is unused** — `UserMembershipsPanel.tsx` (rendered from
   `UserDetailPanel.tsx`) never calls it directly; membership rows must be arriving through another
   path (embedded in a wider read or a different capability), leaving this one orphaned.
9. **IA: `execution_readiness` / readiness copy is the one genuinely-converged read model** — worth
   calling out as the *opposite* of a gap: this replaced what used to be client-side reachability
   computation (S8 W2 U3a). No remaining client-side duplication of a kernel read model was found
   during this pass (`useMemberReachability.ts` and `readiness-copy.ts` both consume
   `execution_readiness` rather than recomputing it) — a good precedent to point at when deciding
   how to close gap #6/#7 above.
10. **`register_source` / `submit_observations` (ingest) have no console UI** — plausibly correct
    (pipeline/collector-only, API-key auth) rather than a defect, but worth an explicit product
    decision rather than silent absence, since ingest failures currently have no console-side
    manual retry/inspect path.

## Capability table

`channel: handle` means "callable by a human/API-key caller *or* a Handle-authenticated agent", not
"agent-only" (see `application/gateway/authorize.ts`'s own doc comment) — it does not by itself
explain an empty web-caller column; see the gap note for those rows. `agent exposure`: `entry` =
built-in entry-agent tool (`modes/entry.ts`); `worker` = worker-runtime tool (`modes/worker.ts`);
`handle-issuable` = not a built-in tool, but selectable when an owner mints a custom Handle via
`issue_handle`/`issue_service_handle` (`lib/entry-ceiling.ts`); `-` = none of the above (console/
platform-human-only by design).

| name | domain | channel | R/W | web caller(s) | agent exposure | gap note |
|---|---|---|---|---|---|---|
| `platform_overview` | platform | human | R | PlatformOverviewPage.tsx; shell/useKernelVersion.ts | - |  |
| `list_users` | platform | human | R | PlatformUsersPage.tsx; PlatformAuditPage.tsx (filter dropdown); platform/UserPicker.tsx; platform/PurgeUsersDialog.tsx | - |  |
| `create_user` | platform | human | W | platform/CreateUserForm.tsx | - |  |
| `update_user` | platform | human | W | platform/UserDetailPanel.tsx | - |  |
| `set_user_status` | platform | human | W | platform/UserDetailPanel.tsx | - |  |
| `reset_user_password` | platform | human | W | platform/UserDetailPanel.tsx | - |  |
| `list_user_memberships` | platform | human | R | (none) | - | No console caller found. UserMembershipsPanel.tsx renders per-user membership rows but they arrive embedded in list_users/UserDetailPanel props, not via a direct list_user_memberships call -- capability looks unused end-to-end from web. |
| `add_membership` | platform | human | W | platform/UserMembershipsPanel.tsx; platform/WorkspaceDetailPanel.tsx | - |  |
| `set_membership_role` | platform | human | W | platform/UserMembershipsPanel.tsx; platform/WorkspaceDetailPanel.tsx | - |  |
| `remove_membership` | platform | human | W | platform/UserMembershipsPanel.tsx | - |  |
| `merge_user` | platform | human | W | platform/UserDetailPanel.tsx | - |  |
| `set_user_budget` | platform | human | W | platform/UserDetailPanel.tsx | - |  |
| `get_platform_settings` | platform | human | R | PlatformModulesPage.tsx; PlatformSettingsPage.tsx; PlatformUsersPage.tsx; platform/providers/DefaultModelControl.tsx | - |  |
| `update_platform_settings` | platform | human | W | PlatformSettingsPage.tsx | - |  |
| `platform_audit_query` | platform | human | R | PlatformAuditPage.tsx | - |  |
| `platform_draft_residue` | platform | human | R | PlatformResiduePage.tsx | - |  |
| `list_workspaces` | platform | human | R | PlatformResiduePage.tsx; PlatformModelsPage.tsx; PlatformOverviewPage.tsx; PlatformRuntimePage.tsx; PlatformSettingsPage.tsx (dropdown); PlatformWorkspacesPage.tsx | - |  |
| `list_platform_models` | platform | human | R | PlatformModelsPage.tsx; platform/providers/DefaultModelControl.tsx; PlatformWorkspacesPage.tsx | - |  |
| `create_workspace` | platform | human | W | platform/CreateWorkspaceForm.tsx | - |  |
| `update_workspace` | platform | human | W | platform/WorkspaceDetailPanel.tsx | - |  |
| `set_workspace_status` | platform | human | W | platform/WorkspaceDetailPanel.tsx | - |  |
| `purge_workspace` | platform | human | W | platform/PurgeWorkspaceDrawer.tsx | - |  |
| `purge_user` | platform | human | W | platform/PurgeUsersDialog.tsx | - |  |
| `issue_llm_admin_token` | platform | human | W | lib/llm-admin.ts | - |  |
| `set_allowed_models` | platform | human | W | platform/WorkspaceDetailPanel.tsx | - |  |
| `list_connectors` | platform | human | R | connect/ConnectSystemLauncher.tsx; PlatformIntegrationsPage.tsx | - |  |
| `set_connector_mode` | platform | human | W | connect/ConnectSystemLauncher.tsx (useConnectorDenyList/useConnectorMode) | - |  |
| `list_gate_instances` | platform | human | R | connect/ConnectSystemLauncher.tsx; integrations/useGateInstancesPanel.ts; integrations/useConnectorDenyList.ts | - |  |
| `get_gate_instance` | platform | human | R | (none) | - | No console caller. Every gate-instance detail view (incl. the #/platform/integrations deep link) resolves the row by filtering the already-loaded list_gate_instances/list_available_gate_instances result client-side; the dedicated single-object getter is dead from the console's perspective. |
| `update_gate_instance` | platform | human | W | connect/ConnectSystemLauncher.tsx; platform/GateInstanceDetailPanel.tsx | - |  |
| `test_gate_instance` | platform | human | R | connect/ConnectSystemLauncher.tsx; platform/GateInstanceDetailPanel.tsx | - |  |
| `list_external_runtimes` | platform | human | R | PlatformIntegrationsPage.tsx | - |  |
| `revoke_external_runtime` | platform | human | W | integrations/useRevokeRuntime.ts | - |  |
| `list_available_gate_instances` | connection | human | R | AvailableGateInstancesSection.tsx; connect/ConnectSystemLauncher.tsx; systems/SystemsPage.tsx; platform/GateInstanceDetailPanel.tsx | - |  |
| `enable_gate_instance` | connection | human | W | connect/EnableGateConfirm.tsx | - |  |
| `preview_gate_instance_enable` | connection | human | R | connect/EnableGateConfirm.tsx | - |  |
| `refresh_operation_governance` | connection | human | W | (none) | - | No console caller. Registered as 'the write half of preview_gate_instance_enable's diff' (S8 W3-K1) but nothing in web/src invokes it -- looks like an unfinished wire-up (leftover 79 follow-up may be incomplete). |
| `issue_service_handle` | connection | human | W | members/IssueServiceHandleSection.tsx | - |  |
| `create_gate_instance` | platform | human | W | platform/CreateGateInstanceForm.tsx | - |  |
| `delete_gate_instance` | platform | human | W | platform/GateInstanceDetailPanel.tsx | - |  |
| `issue_gate_host_token` | platform | human | W | connect/ConnectSystemLauncher.tsx; platform/GateInstanceDetailPanel.tsx | - |  |
| `issue_gate_credential_token` | connection | human | W | AvailableGateInstancesSection.tsx | - |  |
| `list_modules` | platform | human | R | PlatformModulesPage.tsx | - |  |
| `set_default_modules` | platform | human | W | PlatformModulesPage.tsx | - |  |
| `list_workspace_modules` | modules | human | R | catalog/ModulesTab.tsx | - |  |
| `install_module` | modules | human | W | catalog/ModulesTab.tsx | - |  |
| `upgrade_module` | modules | human | W | catalog/ModulesTab.tsx | - |  |
| `get_object` | graph | handle | R | graph/GraphObjectsContext.tsx | entry |  |
| `traverse` | graph | handle | R | (none) | entry | No direct console http.call, but IS a built-in entry-agent tool (ontology/entry-agent.yaml + modes/entry.ts). Console never needs its own UI for it. |
| `resolve_refs` | members | human | R | kit/ref-chip.tsx | - |  |
| `search` | graph | handle | R | graph/ObjectSearch.tsx; OnboardingWizardReview.tsx; access/GrantGateForm.tsx (resource picker, via search cap in scope) | entry+worker |  |
| `state_at` | graph | handle | R | graph/ObjectView.tsx | entry |  |
| `explain` | epistemic | handle | R | audit/ExplainSection.tsx; graph/ProvenanceDrawer.tsx; chat/MessageReferences.tsx | entry |  |
| `audit_query` | audit | human | R | audit/AuditLogSection.tsx | - |  |
| `reconstruct` | audit | human | R | AuditPage.tsx | - |  |
| `list_chats` | chat | human | R | ChatListPage.tsx; chat/useChatSummary.ts | - |  |
| `new_chat` | chat | human | W | ChatListPage.tsx | - |  |
| `send_chat_message` | chat | human | W | lib/ws-client.ts (ChatPage) | - |  |
| `stop_agent` | chat | human | W | lib/ws-client.ts (ChatPage) | - |  |
| `get_chat_history` | chat | human | R | lib/ws-client.ts (ChatPage) | - |  |
| `subscribe_chat` | chat | human | R | lib/ws-client.ts (ChatPage) | - |  |
| `archive_chat` | chat | human | W | lib/chat-lifecycle.ts (ChatListPage/ChatHeader) | - |  |
| `unarchive_chat` | chat | human | W | lib/chat-lifecycle.ts (ChatListPage/ChatHeader) | - |  |
| `rename_chat` | chat | human | W | lib/chat-lifecycle.ts (ChatListPage/ChatHeader) | - |  |
| `get_entry_context` | task | handle | R | issue_handle scope picker only (lib/entry-ceiling.ts) — no direct call | entry | No direct console http.call. Entry-agent tool + pickable in issue_handle's scope form (lib/entry-ceiling.ts) -- console's only role is letting a human include it in a self-issued Handle's scope. |
| `report_turn` | task | handle | W | issue_handle scope picker only (lib/entry-ceiling.ts) — no direct call | entry | No direct console http.call. Entry-agent tool + issue_handle scope-picker option only. |
| `record_decision` | epistemic | handle | W | issue_handle scope picker only (lib/entry-ceiling.ts) — no direct call | entry | No direct console http.call. Entry-agent tool + issue_handle scope-picker option only. |
| `list_conflicts` | epistemic | handle | R | graph/GraphPage.tsx | - |  |
| `resolve_conflict` | epistemic | human | W | graph/ConflictsPanel.tsx | - |  |
| `verify_fact` | epistemic | human | W | graph/FactRow.tsx | - |  |
| `query_decisions` | epistemic | handle | R | audit/ProvenanceToolsSection.tsx | - |  |
| `causal_chain` | epistemic | handle | R | audit/ProvenanceToolsSection.tsx | - |  |
| `decision_impact` | epistemic | handle | R | audit/ProvenanceToolsSection.tsx | - |  |
| `find_precedents` | epistemic | handle | R | audit/ProvenanceToolsSection.tsx | - |  |
| `propose_worker_definition` | worker | handle | W | catalog/WorkerDefinitionEditor.tsx | entry |  |
| `publish_worker_definition` | worker | human | W | catalog/WorkerDefinitionEditor.tsx; CatalogPage.tsx | - |  |
| `deprecate_worker_definition` | worker | human | W | CatalogPage.tsx | - |  |
| `list_worker_definitions` | worker | handle | R | CatalogPage.tsx; AgentProfilePage.tsx; TasksPage.tsx; catalog/ProcedureEditorHost.tsx | - |  |
| `discard_draft` | worker | human | W | CatalogPage.tsx | - |  |
| `assert_fact` | meta | handle | W | (none) | - | No console caller. No manual 'assert a fact' UI exists anywhere in the console -- facts are asserted only by ingest/agents. Only verify_fact and resolve_conflict exist as human-facing fact actions. |
| `supersede_fact` | meta | handle | W | (none) | - | No console caller. Same gap as assert_fact -- no manual fact-correction UI beyond resolve_conflict/verify_fact. |
| `invalidate_fact` | meta | handle | W | (none) | - | No console caller. Same gap as assert_fact. |
| `approve` | governance | human | W | approvals/useApprovalQueue.ts; chat/useActionCards.ts | - |  |
| `reject` | governance | human | W | approvals/useApprovalQueue.ts; chat/useActionCards.ts | - |  |
| `list_pending` | governance | human | R | approvals/useApprovalQueue.ts; hooks/usePendingCount.ts | - |  |
| `get_action` | governance | human | R | audit/ApprovalContext.tsx; approvals/useApprovalQueue.ts | - |  |
| `list_action_requests` | governance | human | R | ApprovalQueuePage.tsx; approvals/LinkedApprovals.tsx | - |  |
| `set_auto_approved_action_kind` | governance | human | W | approvals/useApprovalQueue.ts; chat/useActionCards.ts; ChatPage.tsx | - |  |
| `set_policy` | governance | human | W | governance/PolicyEditSheet.tsx (ModelsPage) | - |  |
| `grant_capability` | governance | human | W | access/GrantGateForm.tsx (SystemsPage); connect/ConnectSystemLauncher.tsx | - |  |
| `revoke_capability` | governance | human | W | systems/SystemsPage.tsx | - |  |
| `issue_handle` | governance | human | W | account/IssueOwnHandleSection.tsx | - |  |
| `list_grants` | governance | human | R | connect/ConnectSystemLauncher.tsx; systems/SystemsPage.tsx | - |  |
| `list_policies` | governance | human | R | ModelsPage.tsx | - |  |
| `list_quotas` | governance | human | R | ModelsPage.tsx | - |  |
| `list_capability_names` | governance | human | R | CatalogPage.tsx (catalog/WorkerDefinitionEditor.tsx capability picker) | - |  |
| `execution_readiness` | governance | human | R | readiness/useExecutionReadiness.ts (ExecutionReadinessCard/ExecutionPrerequisiteBar on Systems/Catalog pages, ChatListPage); systems/useMemberReachability.ts (SystemsPage per-member) | - |  |
| `graph_freshness` | graph | handle | R | graph/GraphFreshnessNotice.tsx (GraphPage) | handle-issuable |  |
| `request_action` | governance | handle | W | (none) | worker | No console caller anywhere -- purely a worker-mode tool (every <gate>.<op> execute call resolves through it). catalog.ts implicitly appends it to every WorkerDefinition's capability list; the console never calls it directly, which is correct by design. |
| `propose_operation` | meta | handle | W | OnboardingWizardReview.tsx | entry |  |
| `publish_operation` | meta | human | W | CatalogPage.tsx; OnboardingWizardReview.tsx | - |  |
| `deprecate_operation` | meta | human | W | CatalogPage.tsx | - |  |
| `update_operation_description` | meta | human | W | CatalogPage.tsx | - |  |
| `propose_skill` | meta | handle | W | catalog/SkillEditor.tsx | entry |  |
| `publish_skill` | meta | human | W | catalog/SkillEditor.tsx; CatalogPage.tsx | - |  |
| `deprecate_skill` | meta | human | W | CatalogPage.tsx | - |  |
| `list_skills` | meta | handle | R | AgentProfilePage.tsx; CatalogPage.tsx; ModelsPage.tsx; catalog/WorkerEditorHost.tsx | - |  |
| `get_skill` | meta | handle | R | catalog/SkillEditor.tsx | - |  |
| `propose_procedure` | meta | handle | W | catalog/ProcedureEditor.tsx | entry |  |
| `publish_procedure` | meta | human | W | catalog/ProcedureEditor.tsx | - |  |
| `deprecate_procedure` | meta | human | W | CatalogPage.tsx | - |  |
| `list_procedures` | meta | handle | R | CatalogPage.tsx | - |  |
| `invoke_worker` | task | handle | W | issue_handle scope picker only (lib/entry-ceiling.ts) — no direct call | entry | No direct console http.call. Entry-agent tool + issue_handle scope-picker option only. |
| `get_task` | task | handle | R | TasksPage.tsx | entry+worker |  |
| `list_tasks` | task | human | R | TasksPage.tsx | - |  |
| `cancel_task` | task | handle | W | TasksPage.tsx | - |  |
| `set_quota` | governance | human | W | governance/QuotaEditSheet.tsx (ModelsPage) | - |  |
| `find_workers` | graph | handle | R | (none) | entry | No direct console http.call (only appears as example capability names in tests). Entry-agent tool (modes/entry.ts) -- by design, agent-invoked only. |
| `find_operations` | graph | handle | R | (none) | entry | No direct console http.call (referenced only in help copy). Entry-agent tool -- agent-invoked only. |
| `find_procedures` | graph | handle | R | (none) | entry | No console caller AND not even referenced in comments/docs (zero hits). Entry-agent tool -- agent-invoked only, but the only find_* with no console mention at all, worth a naming/discoverability check. |
| `list_allowed_operations` | task | handle | R | issue_handle scope picker only (lib/entry-ceiling.ts) — no direct call | entry+worker | No direct console http.call. Entry-agent AND worker tool + issue_handle scope-picker option only. |
| `report_task_result` | task | handle | W | issue_handle scope picker only (lib/entry-ceiling.ts) — no direct call | worker | No direct console http.call. Worker-mode tool + issue_handle scope-picker option only. |
| `request_connection` | connection | handle | W | RequestConnectionForm.tsx | entry |  |
| `observe_operation` | gate | handle | R | issue_handle scope picker only (lib/entry-ceiling.ts) — no direct call | entry | No direct console http.call. Entry-agent tool (projected per-gate as <gate>.<op>) + issue_handle scope-picker option only. |
| `create_connection` | connection | human | W | CompleteConnectionForm.tsx | - |  |
| `connect_gatekeeper` | connection | human | W | (none) | - | No console caller (only appears in a permission test and a doc comment describing a planned step 'grant a member (connect_gatekeeper)'). Looks like an unfinished/superseded step in the systems-connection flow. |
| `list_connection_requests` | connection | human | R | systems/SystemsPage.tsx | - |  |
| `cancel_connection_request` | connection | human | W | systems/SystemsPage.tsx | - |  |
| `publish_manifest` | connection | human | W | systems/SystemAccessCard.tsx; OnboardingWizard.tsx; systems/SystemsPage.tsx | - |  |
| `list_gatekeepers` | connection | human | R | account/IssueOwnHandleSection.tsx; AgentProfilePage.tsx; approvals/useDirectoryNames.tsx; ModelsPage.tsx; catalog/ProcedureEditorHost.tsx; catalog/WorkerEditorHost.tsx; access/GrantGateForm.tsx | - |  |
| `get_gatekeeper` | connection | human | R | GatekeeperDetailDrawer.tsx | - |  |
| `list_operations` | connection | human | R | CatalogPage.tsx; systems/SystemsPage.tsx; access/GrantGateForm.tsx | - |  |
| `get_operation_stats` | connection | human | R | CatalogPage.tsx | - |  |
| `list_principals` | members | human | R | access/GrantGateForm.tsx; AgentProfilePage.tsx; approvals/useDirectoryNames.tsx; systems/SystemsPage.tsx; MembersPage.tsx | - |  |
| `create_principal` | members | human | W | CreatePrincipalForm.tsx | - |  |
| `add_member` | members | human | W | AddMemberForm.tsx | - |  |
| `set_principal_role` | members | human | W | PrincipalDetail.tsx | - |  |
| `rotate_api_key` | members | human | W | PrincipalDetail.tsx | - |  |
| `disable_principal` | members | human | W | PrincipalDetail.tsx | - |  |
| `get_workspace` | members | human | R | hooks/useWorkspaceIdentity.ts; shell/AppShell.tsx; AccountPage.tsx | - |  |
| `list_models` | members | human | R | AgentProfilePage.tsx; catalog/WorkerEditorHost.tsx; chat/ModelSwitcher.tsx; ModelsPage.tsx | - |  |
| `get_agent_profile` | agent_profile | human | R | AgentProfilePage.tsx; chat/ModelSwitcher.tsx | - |  |
| `set_agent_profile` | agent_profile | human | W | AgentProfileForm.tsx; chat/ModelSwitcher.tsx | - |  |
| `get_agent_policy` | agent_profile | human | R | AgentProfilePage.tsx; chat/ModelSwitcher.tsx; ModelsPage.tsx | - |  |
| `set_agent_policy` | agent_profile | human | W | AgentPolicyForm.tsx (ModelsPage) | - |  |
| `get_type` | ontology | handle | R | (none) | - | No console caller anywhere. GraphPage's type filter uses list_types only; there is no single-type detail view and no ontology admin page at all. |
| `list_types` | ontology | handle | R | graph/GraphPage.tsx | - |  |
| `validate` | ontology | handle | R | (none) | - | No console caller anywhere. No dry-run/validate UI for ontology changes. |
| `propose_ontology_change` | ontology | handle | W | (none) | entry | No console caller anywhere. Zero ontology-authoring UI exists in the console despite the capability, minRole and mode being fully modeled in packages/shared. |
| `publish_ontology_version` | ontology | human | W | (none) | - | No console caller anywhere. Same gap -- no ontology publish UI; likely CLI/API-only today. |
| `export_prov` | audit | human | R | audit/ExplainSection.tsx (AuditPage) | - |  |
| `register_source` | ingest | handle | W | (none) | - | No console caller. Ingest is pipeline/collector-only (API key), which is plausibly correct -- flagged for confirmation rather than as a clear defect. |
| `submit_observations` | ingest | handle | W | (none) | - | No console caller. Same as register_source -- plausibly pipeline-only by design. |
| `runtime_inventory` | platform | human | R | PlatformResiduePage.tsx; PlatformRuntimePage.tsx | - |  |
| `list_runtime_images` | platform | human | R | (none) | - | No console caller. PlatformRuntimePage.tsx's own doc comment confirms runtime_inventory's result already carries 'the full image inventory' -- this capability duplicates data already returned by runtime_inventory and is dead from the console's side. |
| `set_active_runtime_image` | platform | human | W | PlatformRuntimePage.tsx | - |  |
| `rollback_runtime_image` | platform | human | W | PlatformRuntimePage.tsx | - |  |
| `roll_entry_containers` | platform | human | W | PlatformRuntimePage.tsx | - | Has a console caller (PlatformRuntimePage.tsx) but NO confirm/impact dialog -- unlike its sibling actions on the same page (set_active_runtime_image, rollback_runtime_image), which both use a tier='medium' Confirm with descriptive impact text. This one fires immediately on click and force-rebuilds live entry containers (optionally platform-wide). |
| `pi_drift` | platform | human | R | PlatformRuntimePage.tsx | - |  |
| `platform_status` | platform | human | R | PlatformOverviewPage.tsx; PlatformStatusPage.tsx | - |  |
| `set_platform_default_model` | platform | human | W | platform/providers/DefaultModelControl.tsx (PlatformModelsPage) | - |  |

## Page reverse index

Routes from `packages/web/src/routes.tsx` (component per `Route.kind`), nav grouping from
`packages/web/src/lib/nav.ts`. Capabilities listed are those called by the page's own top-level
component or its direct children found during this pass — shared sub-components (`ModulesTab`,
`providers/DefaultModelControl`, the `issue_handle` forms) legitimately appear under two pages.

**使用 Use** (always visible)
- `#/work/chats` → `ChatListPage.tsx`: `list_chats`, `new_chat`, `archive_chat`, `unarchive_chat`,
  `rename_chat`
- `#/work/chats/:id` (chat) → `ChatPage.tsx`: `send_chat_message`, `stop_agent`,
  `get_chat_history`, `subscribe_chat`, `archive_chat`, `unarchive_chat`, `rename_chat`, `approve`,
  `reject`, `set_auto_approved_action_kind` (action cards), `explain` (message references),
  `get_agent_profile`, `set_agent_profile`, `get_agent_policy`, `list_models` (header
  `ModelSwitcher`)
- `#/work/approvals` → `ApprovalQueuePage.tsx`: `list_pending`, `get_action`, `approve`, `reject`,
  `set_auto_approved_action_kind`, `list_action_requests`, `list_principals`/`list_gatekeepers`
  (name resolution)
- `#/work/tasks` → `TasksPage.tsx`: `list_tasks`, `get_task`, `cancel_task`,
  `list_worker_definitions`
- `#/work/graph` → `GraphPage.tsx`: `get_object`, `search`, `state_at`, `explain`, `list_types`,
  `list_conflicts`, `resolve_conflict`, `verify_fact`, `graph_freshness`, `resolve_refs` (ref
  chips, shared widget)
- `#/me/agent` → `AgentProfilePage.tsx`: `get_agent_profile`, `set_agent_profile`,
  `get_agent_policy`, `list_models`, `list_worker_definitions`, `list_skills`, `list_gatekeepers`,
  `list_principals`
- `#/me/account` → `AccountPage.tsx`: `get_workspace`, `issue_handle`

**治理 Govern** (this workspace; hidden for a proven member)
- `#/govern/members` → `MembersPage.tsx`: `list_principals`, `get_workspace`, plus child forms
  `create_principal` (`CreatePrincipalForm`), `add_member` (`AddMemberForm`),
  `set_principal_role`/`rotate_api_key`/`disable_principal` (`PrincipalDetail`),
  `issue_service_handle` (`IssueServiceHandleSection`)
- `#/govern/systems` (and legacy `#/govern/access`) → `systems/SystemsPage.tsx`: `list_connectors`,
  `set_connector_mode`, `list_gate_instances`, `update_gate_instance`, `test_gate_instance`,
  `list_available_gate_instances`, `issue_gate_host_token`, `enable_gate_instance`,
  `preview_gate_instance_enable` (all via `connect/ConnectSystemLauncher.tsx`), `list_grants`,
  `grant_capability`, `revoke_capability` (`access/GrantGateForm.tsx`, `SystemAccessCard.tsx`),
  `list_connection_requests`, `cancel_connection_request`, `publish_manifest`,
  `create_connection`, `request_connection`, `list_gatekeepers`, `list_operations`,
  `list_principals`, `execution_readiness` (`ExecutionPrerequisiteBar`)
- `#/govern/catalog/{operations|skills|procedures|workers|modules}` → `CatalogPage.tsx`:
  `list_operations`, `publish_operation`, `deprecate_operation`, `update_operation_description`,
  `get_operation_stats`, `list_skills`, `propose_skill`, `publish_skill`, `deprecate_skill`,
  `get_skill`, `list_procedures`, `propose_procedure`, `publish_procedure`, `deprecate_procedure`,
  `list_worker_definitions`, `propose_worker_definition`, `publish_worker_definition`,
  `deprecate_worker_definition`, `discard_draft`, `list_capability_names`, `list_gatekeepers`,
  `list_workspace_modules`, `install_module`, `upgrade_module` (`catalog/ModulesTab.tsx`),
  `execution_readiness` (`ExecutionPrerequisiteBar`)
- `#/govern/models` → `ModelsPage.tsx`: `list_policies`, `set_policy`, `list_quotas`, `set_quota`,
  `list_skills`, `list_gatekeepers`, `get_agent_policy`, `set_agent_policy`, `list_models`
- `#/govern/audit` → `AuditPage.tsx`: `audit_query`, `reconstruct`, `explain`, `export_prov`,
  `query_decisions`, `causal_chain`, `decision_impact`, `find_precedents`

**平台 Platform** (platform admin only, cross-workspace)
- `#/platform/overview` → `PlatformOverviewPage.tsx`: `platform_overview`, `list_workspaces`,
  `platform_status`
- `#/platform/workspaces` → `PlatformWorkspacesPage.tsx`: `list_workspaces`,
  `list_platform_models`, plus `WorkspaceDetailPanel.tsx` (`update_workspace`,
  `set_allowed_models`, `set_workspace_status`, `add_membership`, `set_membership_role`)
- `#/platform/users` → `PlatformUsersPage.tsx`: `list_users`, `get_platform_settings`, plus
  `CreateUserForm` (`create_user`), `UserDetailPanel` (`update_user`, `set_user_status`,
  `reset_user_password`, `merge_user`, `set_user_budget`), `UserMembershipsPanel`
  (`add_membership`, `set_membership_role`, `remove_membership`), `PurgeUsersDialog` (`purge_user`)
- `#/platform/integrations` → `PlatformIntegrationsPage.tsx`: `list_connectors`,
  `set_connector_mode`, `list_external_runtimes`, `revoke_external_runtime`,
  `CreateGateInstanceForm` (`create_gate_instance`), `GateInstanceDetailPanel`
  (`update_gate_instance`, `test_gate_instance`, `delete_gate_instance`, `issue_gate_host_token`,
  `list_available_gate_instances`)
- `#/platform/modules` → `PlatformModulesPage.tsx`: `list_modules`, `get_platform_settings`,
  `set_default_modules`
- `#/platform/models` → `PlatformModelsPage.tsx`: `list_platform_models`, `list_workspaces`,
  `issue_llm_admin_token`, `get_platform_settings`, `set_platform_default_model`
  (`providers/DefaultModelControl.tsx`, shared with nothing else)
- `#/platform/settings` → `PlatformSettingsPage.tsx`: `get_platform_settings`,
  `update_platform_settings`, `list_workspaces`
- `#/platform/runtime` → `PlatformRuntimePage.tsx`: `runtime_inventory`, `pi_drift`,
  `set_active_runtime_image`, `rollback_runtime_image`, `roll_entry_containers`, `list_workspaces`
- `#/platform/status` → `PlatformStatusPage.tsx`: `platform_status`
- `#/platform/audit` → `PlatformAuditPage.tsx`: `platform_audit_query`, `list_users` (filter)
- `#/platform/residue` → `PlatformResiduePage.tsx`: `platform_draft_residue`, `list_workspaces`,
  `runtime_inventory`

## Gap list (grouped)

### A. Kernel capability with no console UI, and a human plausibly needs one
- `get_type`, `validate`, `propose_ontology_change`, `publish_ontology_version` —
  `packages/shared/src/capabilities.ts` L~ (group `ontology`) fully models these (role, mode,
  paramsSchema) but no page/component in `packages/web/src` calls any of them. `GraphPage.tsx`
  only reads `list_types` for its filter. Ontology governance is console-invisible today.
- `assert_fact`, `supersede_fact`, `invalidate_fact` — `packages/kernel/src/application/gateway/
  fact-handlers.ts`'s three write handlers have no console caller; only `verify_fact`
  (`graph/FactRow.tsx`) and `resolve_conflict` (`graph/ConflictsPanel.tsx`) exist as human fact
  actions.
- `connect_gatekeeper` — `packages/kernel/src/application/gateway/connection-handlers.ts`; no
  caller, referenced only as a still-to-build step in `connect/ConnectSystemLauncher.tsx`'s own
  doc comment.
- `refresh_operation_governance` — `packages/kernel/src/application/gateway/platform-gates-
  handlers.ts` (per registry comment); the read half `preview_gate_instance_enable` is wired
  (`connect/EnableGateConfirm.tsx`), the write half is not.
- `list_user_memberships` — `packages/kernel/src/application/gateway/members-handlers.ts`; no
  direct caller found, even though `platform/UserMembershipsPanel.tsx` renders exactly this kind
  of row (worth checking whether that panel's data actually comes from `list_users`/a nested field
  rather than this capability, or whether it's simply dead).

### B. Kernel capability that duplicates or is superseded by another read model
- `list_runtime_images` — duplicates `runtime_inventory`'s embedded image inventory
  (`PlatformRuntimePage.tsx` doc comment says so explicitly). No caller.
- `get_gate_instance` — duplicates client-side filtering of `list_gate_instances`/
  `list_available_gate_instances` everywhere a single instance is needed, including the
  `#/platform/integrations?gateId=` deep link (`platform/PlatformIntegrationsPage.tsx` →
  `integrations/useGateInstancesPanel.ts`). No caller.
- (Negative finding, for contrast) `execution_readiness` is the one place this pattern was
  *already fixed*: `systems/useMemberReachability.ts` and `components/readiness/readiness-
  copy.ts` both consume the kernel's own read model rather than recomputing reachability
  client-side — no remaining client-side-computed-duplicate-of-a-kernel-model was found in this
  pass.

### C. Write action with no confirm/impact display for a high-impact op
- `roll_entry_containers` (`platform/PlatformRuntimePage.tsx` line ~585) — `onClick=
  {onRollEntryContainers}` direct, no `Confirm`. Its two siblings on the same page,
  `set_active_runtime_image` (line ~316) and `rollback_runtime_image` (line ~508), both wrap their
  button in a `tier="medium"` `Confirm` with a descriptive impact sentence. This is the
  higher-blast-radius of the three (force-rebuilds every idle entry container platform-wide when
  no principal is selected) and is the outlier.
- Spot-checked and found to already have proper confirms: `purge_user`/`purge_workspace`
  (dedicated dialogs), `delete_gate_instance`, `revoke_capability`, `disable_principal`,
  `remove_membership`, `merge_user`, `revoke_external_runtime` — no further gaps found in this
  category during the pass, but the check was a spot-check (~15 of 58 write + 25 execute
  capabilities), not exhaustive.

### D. IA mismatch (capability's UI lives where a user wouldn't look)
- None found with high confidence. The one candidate considered — `platform_status` appearing on
  both `PlatformOverviewPage.tsx` (summary) and its own `PlatformStatusPage.tsx` (detail) — reads
  as deliberate landing-page-plus-detail-page duplication, not a mismatch, and nav labels
  (`概览`/`运行状态`) already distinguish scope per `lib/nav.ts`'s own doc comment about the
  治理/平台 near-duplicate-label problem it already fixed once (S8 W4 audit U1).
- Worth watching rather than acting on: `list_gatekeepers` is read from 7 different files across 3
  nav groups (使用/我的智能体, 治理/成员+目录+模型, 治理/系统与授权) purely as a name-resolution
  helper — not a mismatch, but a sign this should probably be one shared hook rather than 7
  independent `useCapabilityList` call sites (a refactor-plan candidate, not a coverage gap).

### E. Legacy UI migration (components/ui/* vs components/kit/*)
Per `scripts/guards/legacy-ui-importers.json` (the shrink-only allowlist `scripts/guards/
css-tokens.mjs` enforces): **21 of 23 routed pages are still on the legacy list.** Only
`components/systems/SystemsPage.tsx` and `components/platform/PlatformResiduePage.tsx` are absent
from it (fully migrated to `components/kit/*`). Every other route component (`ChatPage`,
`ChatListPage`, `ApprovalQueuePage`, `TasksPage`, `AgentProfilePage`, `AccountPage`, `MembersPage`,
`CatalogPage`, `ModelsPage`, `AuditPage`, `GraphPage`, and all 9 remaining `Platform*Page.tsx`
files except `PlatformResiduePage`) is on the allowlist, i.e. still imports `components/ui/*`.
This is the single largest piece of the console-redesign backlog by file count.

## Uncertainties / things not independently re-verified

- Web-caller detection is string-grep based (`'<name>'`/`"<name>"` plus common call idioms:
  `http.call`, `useCapability`/`useCapabilityList`, `permissions.isDenied`/`markDenied`). A call
  built from a dynamic/computed capability name (none observed, but not provably absent) would be
  missed.
- The C section (confirm dialogs) was spot-checked on ~15 high-impact write/execute capabilities,
  not all 83. Treat "no further gaps found" as a sample result, not a full audit.
- `list_user_memberships`'s true data source was not traced past "no direct capability-name
  match" — it's possible `UserMembershipsPanel.tsx` receives its rows as a prop computed elsewhere
  from a different capability's result rather than being genuinely dead; worth a 10-minute
  follow-up read of that component's prop chain before removing the capability.
- Agent-exposure classification (`entry`/`worker`/`handle-issuable`) is derived from static string
  scans of `modes/entry.ts` / `modes/worker.ts` / `lib/entry-ceiling.ts`, not from running the
  extension; it should match the registered tool schemas but wasn't cross-checked against
  `tool-schema.ts`'s actual runtime output.
- No repo files were modified; no build/test was run (per dispatch constraints).
