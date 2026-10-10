import { type Capability, capabilityHasSideEffects } from './capabilities.js';
import type { Role } from './enums.js';

// Moved from kernel `governance/capability/roles.ts` (no behavior change) so the console decides
// "may this reader fix it" with the same predicate the kernel authorizes with; the kernel file
// re-exports everything here.

/**
 * Whether a human Principal's `role` satisfies a capability's `minRole`. Moved to kernel governance from
 * `application/gateway/authorize.ts` (W5.5, STATUS leftover 18) so the governance layer can apply
 * the same rule when *issuing* an entry Handle (`entryScope({ role })`, handles.ts) — the six-layer
 * dependency rule forbids governance importing application, and this rule is pure data logic.
 *
 * Role hierarchy (unchanged from authorize.ts's own doc comment): `owner` satisfies everything;
 * `minRole: 'member'` is the floor every human role clears; any other `minRole` requires that exact
 * role — `builder` / `operator` / `auditor` are peers, not a ladder.
 *
 * This is only the `minRole` half. Whether a role may use a capability at all is
 * `roleMayUseCapability` below, which also applies the auditor's allowlist (D-07).
 */
export function roleSatisfiesMinRole(role: Role, minRole: Role | undefined): boolean {
  if (minRole === undefined) return true;
  if (role === 'owner') return true;
  if (minRole === 'member') return true;
  return role === minRole;
}

/**
 * Review 2026-10-02 R-35 / decision D-07: `auditor` is strictly read-only (design §5.1.1 "只读含
 * 密钥元数据"). Before, it cleared every `minRole: 'member'` (and every un-`minRole`d) capability
 * through `roleSatisfiesMinRole`, so an auditor could `invalidate_fact`, `deprecate_operation` or
 * `invoke_worker`, and its entry agent observed every gate. An auditor now uses exactly:
 *
 *   - **reads** (`AUDITOR_READ_CAPABILITIES`): the audit and provenance tools plus the graph,
 *     ontology, registry and workspace reads an audit needs. Every one must be side-effect free
 *     by the registry's explicit flag (`capabilityHasSideEffects`, D-08) — never by
 *     `mode === 'observe'`, which some writing capabilities also carry. No gate capability
 *     (`observe_operation`, `<gate>.<op>`, `request_action`, `list_allowed_operations`) and none
 *     of the agent-execution planning reads (`find_operations` / `find_workers` /
 *     `find_procedures` / `execution_readiness`, which describe what the caller's agent could
 *     reach — nothing, for an auditor).
 *   - **its own conversation** (`AUDITOR_CONVERSATION_CAPABILITIES`): talking to its entry agent
 *     writes only the auditor's own chat, Turn and context-item records. The entry agent's Handle
 *     carries this same ceiling (`entryScope({ role })`), so it can read and answer, never act.
 *
 * Explicit names, not a rule derived from `mode`: a capability added later is not available to an
 * auditor until someone puts it here.
 */
export const AUDITOR_READ_CAPABILITIES: ReadonlySet<string> = new Set([
  // audit and provenance
  'audit_query',
  'export_prov',
  'reconstruct',
  'explain',
  'causal_chain',
  'decision_impact',
  'find_precedents',
  'query_decisions',
  'list_conflicts',
  // graph and ontology
  'search',
  'list_facts',
  'graph_overview',
  'traverse',
  'get_object',
  'state_at',
  'graph_freshness',
  'get_type',
  'list_types',
  'validate',
  'list_ontology_versions',
  // registries and the gate catalog's metadata (never a gate call)
  'get_skill',
  'list_skills',
  'list_procedures',
  'list_worker_definitions',
  'list_gatekeepers',
  'get_gatekeeper',
  'list_operations',
  'get_operation_stats',
  'list_available_gate_instances',
  'list_capability_names',
  'list_workspace_modules',
  // the workspace and the auditor itself
  'get_workspace',
  'list_models',
  'resolve_refs',
  'get_agent_profile',
  'get_agent_policy',
  'list_tasks',
  'get_task',
  'list_chats',
  'get_chat_history',
  'subscribe_chat',
  'list_chat_turns',
]);

/** See `AUDITOR_READ_CAPABILITIES`: the writes an auditor's own conversation with its read-only
 *  entry agent needs — its chats, the Turn's context-item lease and Turn record. */
export const AUDITOR_CONVERSATION_CAPABILITIES: ReadonlySet<string> = new Set([
  'new_chat',
  'send_chat_message',
  'stop_agent',
  'rename_chat',
  'archive_chat',
  'unarchive_chat',
  'get_entry_context',
  'report_turn',
]);

/**
 * The one role predicate (R-35 / D-07): may a Principal with `role` use `capability`?
 * `authorizeCapabilityCall` (the human channel), `entryScope({ role })` (every entry Handle and
 * `issue_handle`), `issue_service_handle` and the gate paths (`observe_operation` /
 * `request_action` re-check it for the on-behalf-of Principal on both channels) all call it.
 * `capability` is `undefined` for a name the registry does not know: an auditor may never use one;
 * every other role keeps the pre-R-35 reading (no `minRole`, so allowed).
 */
export function roleMayUseCapability(
  role: Role,
  capability: Pick<Capability, 'name' | 'mode' | 'minRole' | 'sideEffects'> | undefined,
): boolean {
  if (role === 'auditor') {
    if (capability === undefined) return false;
    if (!roleSatisfiesMinRole(role, capability.minRole)) return false;
    if (AUDITOR_CONVERSATION_CAPABILITIES.has(capability.name)) return true;
    return AUDITOR_READ_CAPABILITIES.has(capability.name) && !capabilityHasSideEffects(capability);
  }
  return roleSatisfiesMinRole(role, capability?.minRole);
}
