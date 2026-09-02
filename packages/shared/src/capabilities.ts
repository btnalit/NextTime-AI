import { z } from 'zod';
import type { CapabilityChannel, OperationMode, Role } from './enums.js';

/**
 * Capability registry (design doc §9.3, "Capability 契约 — HTTP 与 MCP 两个投影"). Pure data: one
 * row per capability the kernel exposes, with the metadata gateway/policy/mcp/http all need to
 * route, authorize, and validate a call — `group`/`mode`/`channel` classify *what kind* of thing
 * a capability is (§5.1.4, §5.3, §9.3); `paramsSchema` validates the call's arguments.
 *
 * Reading note (assumption, see PR body "假设"): §9.3's table lists capability names in
 * comma-separated groups against a shared "模式" (mode) column that mixes the actual mode
 * (observe/propose/execute) with channel hints in parentheses (e.g. "execute（human）",
 * "human（owner）", "propose（Handle 通道）"). This file decomposes that prose into the structured
 * `{mode, channel, minRole?}` triple per capability, using: the mode token(s) present in each
 * row; I16/I17 (publish_*, deprecate_*, set_policy, set_quota, grant_capability, revoke_capability,
 * approve, reject, issue_handle, connect_gatekeeper, create_connection are human-channel only);
 * I14 (approval-queue capabilities gate on the `operator` role, actual authorization is
 * scope-based); and the Role table in §5.1.1 (owner ↔
 * authorization & policy, builder ↔ propose ontology/WorkerDefinition, operator ↔ approval queue,
 * member ↔ chat/invoke/observe, auditor ↔ read-only+secrets) for `minRole`. Where §9.3 does not
 * name a role explicitly, `minRole` is left undefined rather than invented.
 */

export const CAPABILITY_GROUP_VALUES = [
  'chat',
  'ontology',
  'graph',
  'gate',
  'connection',
  'meta',
  'epistemic',
  'governance',
  'task',
  'worker',
  'ingest',
  'audit',
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUP_VALUES)[number];
export const CapabilityGroupSchema = z.enum(CAPABILITY_GROUP_VALUES);

export interface Capability {
  readonly name: string;
  readonly group: CapabilityGroup;
  readonly mode: OperationMode | 'propose';
  readonly channel: CapabilityChannel;
  readonly minRole?: Role;
  readonly paramsSchema: z.ZodType;
  readonly description: string;
}

const id = z.string().min(1);
const jsonRecord = z.record(z.string(), z.unknown());
const noParams = z.object({}).strict();

// -------------------------------------------------------------------------------------------
// chat — human channel only ("只走 human 通道")
// -------------------------------------------------------------------------------------------

const chatCapabilities: readonly Capability[] = [
  {
    name: 'list_chats',
    group: 'chat',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: noParams,
    description: 'List the chats owned by the calling principal.',
  },
  {
    name: 'new_chat',
    group: 'chat',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ title: z.string().optional() }).strict(),
    description: 'Create a new private Chat for the calling principal.',
  },
  {
    name: 'send_chat_message',
    group: 'chat',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ chatId: id, text: z.string().min(1) }).strict(),
    description:
      'Send a message on a Chat and start a Turn (§8.1 sendChatMessage). Rejected if a Turn is already running.',
  },
  {
    name: 'stop_agent',
    group: 'chat',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ chatId: id }).strict(),
    description: 'Stop the in-progress Turn on a Chat.',
  },
  {
    name: 'get_chat_history',
    group: 'chat',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        chatId: id,
        cursor: z.string().optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    description:
      'Page through a Chat’s persisted messages. Must be called after subscribe_chat (§9.4).',
  },
  {
    name: 'subscribe_chat',
    group: 'chat',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ chatId: id, startAfter: z.string().optional() }).strict(),
    description:
      'Subscribe to a Chat’s push events before paging history, so no event is missed (§9.4).',
  },
];

// -------------------------------------------------------------------------------------------
// ontology
// -------------------------------------------------------------------------------------------

const ontologyCapabilities: readonly Capability[] = [
  {
    name: 'publish_ontology_version',
    group: 'ontology',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ ontologyVersionId: id }).strict(),
    description: 'Publish a draft OntologyVersion (I16). Human channel only.',
  },
  {
    name: 'propose_ontology_change',
    group: 'ontology',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    paramsSchema: z.object({ change: jsonRecord }).strict(),
    description:
      'Propose a private draft ontology change (I16); visible only to the proposer until published.',
  },
  {
    name: 'get_type',
    group: 'ontology',
    mode: 'observe',
    channel: 'handle',
    paramsSchema: z.object({ typeName: z.string() }).strict(),
    description: 'Read one ObjectType/LinkType/ActionType definition.',
  },
  {
    name: 'list_types',
    group: 'ontology',
    mode: 'observe',
    channel: 'handle',
    paramsSchema: z.object({ kind: z.enum(['object', 'link', 'action']).optional() }).strict(),
    description: 'List type definitions in the published OntologyVersion.',
  },
  {
    name: 'validate',
    group: 'ontology',
    mode: 'observe',
    channel: 'handle',
    paramsSchema: z.object({ typeName: z.string(), payload: z.unknown() }).strict(),
    description:
      'Validate a payload against a type’s JSON Schema projection without writing anything.',
  },
];

// -------------------------------------------------------------------------------------------
// graph
// -------------------------------------------------------------------------------------------

const graphCapabilities: readonly Capability[] = [
  {
    name: 'get_object',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ objectId: id }).strict(),
    description: 'Read one Object with its current PropertyAssertions.',
  },
  {
    name: 'traverse',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        fromId: id,
        linkType: z.string().optional(),
        depth: z.number().int().min(1).max(3).optional(),
      })
      .strict(),
    description: 'Walk Links from an Object, bounded to depth ≤ 3 (I18-adjacent traversal cap).',
  },
  {
    name: 'search',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ query: z.string(), objectType: z.string().optional() }).strict(),
    description: 'Search Objects/Facts, results carry epistemic_status.',
  },
  {
    name: 'state_at',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ objectId: id, at: z.string() }).strict(),
    description: 'Bitemporal read: the Object’s state as of a given instant.',
  },
  {
    name: 'find_operations',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ need: z.string() }).strict(),
    description:
      'Traverse the platform meta-ontology for Operations matching a need, intersected with the caller’s Grant.',
  },
  {
    name: 'find_workers',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ need: z.string() }).strict(),
    description:
      'Traverse the platform meta-ontology for WorkerDefinition@version matching a need.',
  },
  {
    name: 'find_procedures',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ need: z.string() }).strict(),
    description: 'Traverse the platform meta-ontology for Procedures matching a need.',
  },
];

// -------------------------------------------------------------------------------------------
// gate — interface-manifest projection. `<gate>.<op>` is a *pattern*: the real, dynamic capability
// names (e.g. `docker.container_restart`) are generated at runtime from a Gatekeeper's published
// Operations (§7.4, §7.5) and are therefore not enumerable here. Two pattern rows stand in for
// the two Operation modes: the observe-class projection (called directly) and the execute-class
// projection (intercepted client-side and turned into a `request_action` call, per §7.4 "拦截是
// 便利闸门，安全边界在 gateway"). assertRegistryConsistent()'s execute+handle allow-list
// recognizes both `request_action` and this execute-class gate pattern by name.
// -------------------------------------------------------------------------------------------

const gateCapabilities: readonly Capability[] = [
  {
    name: '<gate>.<op>',
    group: 'gate',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: jsonRecord,
    description:
      'Observe-class Operation projected from a Gatekeeper’s interface manifest as a tool; params validated against that Operation’s own params_schema at runtime. Available to entry and Worker Handles.',
  },
  {
    name: '<gate>.<op>:execute',
    group: 'gate',
    mode: 'execute',
    channel: 'handle',
    paramsSchema: jsonRecord,
    description:
      'Execute-class Operation projected from a Gatekeeper’s interface manifest; the tool call is intercepted and turned into request_action (§7.4). Only a Worker’s Handle may hold this.',
  },
];

// -------------------------------------------------------------------------------------------
// connection
// -------------------------------------------------------------------------------------------

const connectionCapabilities: readonly Capability[] = [
  {
    name: 'request_connection',
    group: 'connection',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({ kind: z.enum(['http', 'mcp', 'cli', 'ssh']), target: z.string() })
      .strict(),
    description:
      'Propose connecting a new system; produces a connection-request card for a human to fill in credentials.',
  },
  {
    name: 'create_connection',
    group: 'connection',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        kind: z.enum(['http', 'mcp', 'cli', 'ssh']),
        target: z.string(),
        credentials: z.unknown(),
      })
      .strict(),
    description:
      'Register a Gatekeeper instance with address and credentials (credentials go straight to the gatekeeper, never persisted by the kernel); auto-imports a manifest draft for http/mcp.',
  },
  {
    name: 'publish_manifest',
    group: 'connection',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ gatekeeperId: id }).strict(),
    description: 'Publish a Gatekeeper’s draft interface manifest (I16/I17).',
  },
  {
    name: 'connect_gatekeeper',
    group: 'connection',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ gatekeeperId: id, principalId: id }).strict(),
    description: 'Grant a user’s entry agent use of an existing Gatekeeper (a CapabilityGrant).',
  },
];

// -------------------------------------------------------------------------------------------
// meta
// -------------------------------------------------------------------------------------------

const metaCapabilities: readonly Capability[] = [
  {
    name: 'propose_operation',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    paramsSchema: z.object({ gatekeeperId: id, operation: jsonRecord }).strict(),
    description: 'Propose a private draft Operation after exploring a Gatekeeper (I16).',
  },
  {
    name: 'propose_skill',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    paramsSchema: z.object({ skill: jsonRecord }).strict(),
    description: 'Propose a private draft Skill, typically at the end of a successful WorkerRun.',
  },
  {
    name: 'propose_procedure',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    paramsSchema: z.object({ procedure: jsonRecord }).strict(),
    description: 'Propose a private draft Procedure distilled from a successful Task.',
  },
  {
    name: 'publish_skill',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ skillId: id }).strict(),
    description: 'Publish a draft Skill (I16).',
  },
  {
    name: 'publish_procedure',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ procedureId: id }).strict(),
    description: 'Publish a draft Procedure (I16).',
  },
  {
    name: 'deprecate_skill',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ skillId: id }).strict(),
    description: 'Deprecate a published Skill.',
  },
  {
    name: 'deprecate_procedure',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ procedureId: id }).strict(),
    description: 'Deprecate a published Procedure.',
  },
  {
    name: 'assert_fact',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({ objectId: id, linkType: z.string(), value: z.unknown(), sourceId: id.optional() })
      .strict(),
    description:
      'Assert a Fact; resulting epistemic_status depends on the caller’s principal kind (§5.5).',
  },
  {
    name: 'supersede_fact',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ factId: id, value: z.unknown() }).strict(),
    description: 'Supersede a Fact from the same Source with a newer value.',
  },
  {
    name: 'invalidate_fact',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ factId: id, reason: z.string().optional() }).strict(),
    description: 'Invalidate a Fact.',
  },
];

// -------------------------------------------------------------------------------------------
// epistemic — Semantica tool-name contract preserved (get_provenance=explain,
// get_causal_chain=causal_chain, analyze_decision_impact=decision_impact); §9.3 row constrains
// every capability in this group to observe or propose (never execute).
// -------------------------------------------------------------------------------------------

const epistemicCapabilities: readonly Capability[] = [
  {
    name: 'explain',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ nodeId: id }).strict(),
    description:
      'Fact/Decision/Turn → Observation → Activity → Source + Principal provenance chain (Semantica get_provenance).',
  },
  {
    name: 'record_decision',
    group: 'epistemic',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        summary: z.string(),
        relatedFactIds: z.array(id).optional(),
        relatedTaskId: id.optional(),
      })
      .strict(),
    description: 'Record a Decision (starts in `proposed`, see transitions.ts).',
  },
  {
    name: 'query_decisions',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ filter: jsonRecord.optional() }).strict(),
    description: 'Query recorded Decisions.',
  },
  {
    name: 'find_precedents',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ need: z.string() }).strict(),
    description: 'Find prior Decisions/Tasks addressing a similar need.',
  },
  {
    name: 'causal_chain',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ decisionId: id }).strict(),
    description: 'Causal chain leading to a Decision (Semantica get_causal_chain).',
  },
  {
    name: 'decision_impact',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ decisionId: id }).strict(),
    description: 'Downstream impact of a Decision (Semantica analyze_decision_impact).',
  },
  {
    name: 'list_conflicts',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ status: z.string().optional() }).strict(),
    description:
      'List Conflicts visible to the caller (private-Source Conflicts are one-sided, §5.6).',
  },
  {
    name: 'resolve_conflict',
    group: 'epistemic',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ conflictId: id, resolution: z.string() }).strict(),
    description: 'Resolve a Conflict.',
  },
  {
    name: 'verify_fact',
    group: 'epistemic',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ factId: id, evidenceIds: z.array(id) }).strict(),
    description: 'Promote a Fact to epistemic_status=verified with Evidence (I3.6).',
  },
];

// -------------------------------------------------------------------------------------------
// governance
// -------------------------------------------------------------------------------------------

const governanceCapabilities: readonly Capability[] = [
  {
    name: 'request_action',
    group: 'governance',
    mode: 'execute',
    channel: 'handle',
    paramsSchema: z
      .object({ gatekeeperId: id, operation: z.string(), params: jsonRecord })
      .strict(),
    description:
      'A Worker’s only execute-mode entry point onto a Gatekeeper; creates an ActionRequest.',
  },
  {
    name: 'approve',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ actionRequestId: id }).strict(),
    description:
      'Approve a pending ActionRequest (I14: the approver must hold the requested scope).',
  },
  {
    name: 'reject',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ actionRequestId: id, reason: z.string().optional() }).strict(),
    description: 'Reject a pending ActionRequest.',
  },
  {
    name: 'list_pending',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({}).strict(),
    description: 'List ActionRequests pending the caller’s approval.',
  },
  {
    name: 'get_action',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ actionRequestId: id }).strict(),
    description: 'Read one ActionRequest.',
  },
  {
    name: 'set_auto_approved_action_kind',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ actionKind: z.string() }).strict(),
    description:
      '"Always allow this kind" — writes a workspace auto-approval rule for an ActionKind.',
  },
  {
    name: 'grant_capability',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ principalId: id, capability: z.string(), scope: jsonRecord }).strict(),
    description: 'Grant a Capability to a Principal.',
  },
  {
    name: 'revoke_capability',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ grantId: id }).strict(),
    description: 'Revoke a CapabilityGrant.',
  },
  {
    name: 'set_policy',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ policy: jsonRecord }).strict(),
    description: 'Write a Policy rule (allow/require_approval/deny).',
  },
  {
    name: 'set_quota',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ key: z.string(), value: z.unknown() }).strict(),
    description: 'Set an I18 quota (invoke_worker depth, concurrency, token/time, daily cost).',
  },
  {
    name: 'issue_handle',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ sessionId: id, scope: jsonRecord }).strict(),
    description: 'Issue a CapabilityHandle for a Session.',
  },
];

// -------------------------------------------------------------------------------------------
// task — §9.3 row constrains this group to propose or observe (never execute). `get_entry_context`
// and `report_turn` are S1.6 additions, not named in §9.3's table: §7.4's mode table describes
// their behavior ("该用户的待审批、进行中 Task 及其结果、相关 Fact、先例…" injected via `context`;
// "每轮回传 Turn 与决策") without naming the capabilities. Assumption (see PR body "假设"): grouped
// under `task` rather than a new group, since both are per-Turn/Task-lifecycle facilities for the
// entry agent (bootstrap read / write-back), not graph reads (`graph`) or provenance queries
// (`epistemic`). `get_entry_context` takes no params — the kernel derives the caller and workspace
// from the Handle. `report_turn`'s field names follow this file's established camelCase param
// convention (`turnId`, not the task brief's prose `turn_id`) for consistency with every other
// capability here.
// -------------------------------------------------------------------------------------------

const taskCapabilities: readonly Capability[] = [
  {
    name: 'get_entry_context',
    group: 'task',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: noParams,
    description:
      'Entry-mode context bootstrap (§7.4 `context` injection, S1 scope): the calling principal’s ' +
      'pending approvals, running Tasks and their results, relevant Facts (with epistemic_status), ' +
      'and precedents. Called once per LLM call from the entry agent’s pi `context` event handler.',
  },
  {
    name: 'report_turn',
    group: 'task',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        turnId: id,
        summary: z.string(),
        decisions: z.array(id).optional(),
      })
      .strict(),
    description:
      'Report a completed Turn’s outcome back to the kernel (§7.2 "每轮回传 Turn 与决策"); called ' +
      'from the entry agent’s pi `agent_end` handler.',
  },
  {
    name: 'create_task',
    group: 'task',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ input: z.unknown() }).strict(),
    description: 'Create a Task.',
  },
  {
    name: 'invoke_worker',
    group: 'task',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        definitionId: id,
        version: z.number().int().positive(),
        input: z.unknown(),
        wait: z.boolean().optional(),
        timeout: z.number().int().positive().optional(),
      })
      .strict(),
    description:
      'invoke_worker(definition@version, input, wait, timeout) — §8.2; a decayed child Handle inherits on_behalf_of.',
  },
  {
    name: 'get_task',
    group: 'task',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ taskId: id }).strict(),
    description: 'Read one Task and its WorkerRun.',
  },
  {
    name: 'cancel_task',
    group: 'task',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ taskId: id }).strict(),
    description: 'Request cancellation of a running Task.',
  },
];

// -------------------------------------------------------------------------------------------
// worker
// -------------------------------------------------------------------------------------------

const workerCapabilities: readonly Capability[] = [
  {
    name: 'propose_worker_definition',
    group: 'worker',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    paramsSchema: z.object({ definition: jsonRecord }).strict(),
    description: 'Propose a private draft WorkerDefinition.',
  },
  {
    name: 'publish_worker_definition',
    group: 'worker',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ definitionId: id, version: z.number().int().positive() }).strict(),
    description: 'Publish a draft WorkerDefinition (I12: immutable once published).',
  },
  {
    name: 'deprecate_worker_definition',
    group: 'worker',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ definitionId: id, version: z.number().int().positive() }).strict(),
    description: 'Deprecate a published WorkerDefinition version.',
  },
  {
    name: 'list_worker_definitions',
    group: 'worker',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ kind: z.enum(['entry', 'worker']).optional() }).strict(),
    description: 'List published WorkerDefinitions.',
  },
];

// -------------------------------------------------------------------------------------------
// ingest — service principals (collectors, §7.8)
// -------------------------------------------------------------------------------------------

const ingestCapabilities: readonly Capability[] = [
  {
    name: 'register_source',
    group: 'ingest',
    mode: 'propose',
    channel: 'handle',
    paramsSchema: z
      .object({
        name: z.string(),
        ownerPrincipalId: id.optional(),
        visibility: z.enum(['workspace', 'private']),
      })
      .strict(),
    description: 'Register a Source (document/DB/API/person/agent session).',
  },
  {
    name: 'submit_observations',
    group: 'ingest',
    mode: 'propose',
    channel: 'handle',
    paramsSchema: z.object({ sourceId: id, observations: z.array(jsonRecord) }).strict(),
    description: 'Submit a batch of Observations from one Activity (collectors, §7.8).',
  },
];

// -------------------------------------------------------------------------------------------
// audit
// -------------------------------------------------------------------------------------------

const auditCapabilities: readonly Capability[] = [
  {
    name: 'audit_query',
    group: 'audit',
    mode: 'observe',
    channel: 'human',
    minRole: 'auditor',
    paramsSchema: z.object({ filter: jsonRecord.optional() }).strict(),
    description: 'Query AuditRecords.',
  },
  {
    name: 'reconstruct',
    group: 'audit',
    mode: 'observe',
    channel: 'human',
    minRole: 'auditor',
    paramsSchema: z.object({ entityId: id }).strict(),
    description: 'Reconstruct an entity’s history from AuditRecords.',
  },
  {
    name: 'export_prov',
    group: 'audit',
    mode: 'observe',
    channel: 'human',
    minRole: 'auditor',
    paramsSchema: z.object({ scope: jsonRecord.optional() }).strict(),
    description: 'Export a PROV-O provenance graph.',
  },
];

/** The complete capability registry (design doc §9.3). */
export const CAPABILITY_REGISTRY: readonly Capability[] = [
  ...chatCapabilities,
  ...ontologyCapabilities,
  ...graphCapabilities,
  ...gateCapabilities,
  ...connectionCapabilities,
  ...metaCapabilities,
  ...epistemicCapabilities,
  ...governanceCapabilities,
  ...taskCapabilities,
  ...workerCapabilities,
  ...ingestCapabilities,
  ...auditCapabilities,
];

/** Capability names that must always be on the human channel (I16/I17/§9.3), never handle. */
const HUMAN_ONLY_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  'publish_ontology_version',
  'create_connection',
  'publish_manifest',
  'connect_gatekeeper',
  'publish_skill',
  'publish_procedure',
  'deprecate_skill',
  'deprecate_procedure',
  'approve',
  'reject',
  'list_pending',
  'get_action',
  'set_auto_approved_action_kind',
  'grant_capability',
  'revoke_capability',
  'set_policy',
  'set_quota',
  'issue_handle',
  'publish_worker_definition',
  'deprecate_worker_definition',
  'audit_query',
  'reconstruct',
  'export_prov',
]);

/** Execute-mode capabilities allowed on the handle channel: only request_action and the gate execute pattern (§9.3, §7.4). */
const HANDLE_EXECUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'request_action',
  '<gate>.<op>:execute',
]);

/** Looks up a capability by name, or `undefined` if it is not registered. */
export function getCapability(name: string): Capability | undefined {
  return CAPABILITY_REGISTRY.find((capability) => capability.name === name);
}

/** Lists every capability available on a given channel. */
export function listByChannel(channel: CapabilityChannel): readonly Capability[] {
  return CAPABILITY_REGISTRY.filter((capability) => capability.channel === channel);
}

/**
 * Validates registry-wide invariants: every name is unique and carries exactly one channel;
 * human-only capability names are never on the handle channel; every execute-mode capability on
 * the handle channel is either `request_action` or the gate execute pattern. Throws on the first
 * violation found; returns void on success.
 */
export function assertRegistryConsistent(): void {
  const seen = new Map<string, Capability>();
  for (const capability of CAPABILITY_REGISTRY) {
    const existing = seen.get(capability.name);
    if (existing) {
      throw new Error(`capability registry: duplicate name "${capability.name}"`);
    }
    seen.set(capability.name, capability);

    if (capability.channel !== 'human' && capability.channel !== 'handle') {
      throw new Error(`capability registry: "${capability.name}" has no valid channel`);
    }

    if (HUMAN_ONLY_CAPABILITY_NAMES.has(capability.name) && capability.channel !== 'human') {
      throw new Error(`capability registry: "${capability.name}" must be on the human channel`);
    }

    if (
      capability.mode === 'execute' &&
      capability.channel === 'handle' &&
      !HANDLE_EXECUTE_ALLOWLIST.has(capability.name)
    ) {
      throw new Error(
        `capability registry: "${capability.name}" is execute-mode on the handle channel but is not request_action or the gate execute pattern`,
      );
    }
  }
}
