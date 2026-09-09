import { z } from 'zod';
import { ConnectionRequestStatusSchema, RoleSchema, WorkerDefinitionKindSchema } from './enums.js';
import type { CapabilityChannel, Role } from './enums.js';
import { listEnvelope } from './envelope.js';
import { WorkerResultCapabilityParamsSchema } from './worker-result.js';

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
  // S3.11 (docs/development-tasks.md, 2026-09-08 "中台控制面" decision): member/API-key
  // management and workspace-summary reads have no existing group they fit — `governance` already
  // holds Grant/Policy/Quota management (list_grants/list_policies/list_quotas join it directly,
  // below); `connection` already holds Gatekeeper registration/lifecycle (list_gatekeepers/
  // get_gatekeeper/list_operations join it). `members` is the catch-all for what is left:
  // Principal CRUD (`list_principals`/`create_principal`/`set_principal_role`/`rotate_api_key`/
  // `disable_principal`), plus `get_workspace`/`list_models`, which are workspace-summary/config
  // reads with no other natural home.
  'members',
  // S3.13 (docs/development-tasks.md "每用户智能体配置"): per-principal AgentProfile
  // (`get_agent_profile`/`set_agent_profile`) plus the workspace-wide AgentPolicy that governs it
  // (`get_agent_policy`/`set_agent_policy`) — a distinct enough concept (its own two tables, its
  // own resolution semantics) to earn its own group rather than further overloading `members`.
  'agent_profile',
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUP_VALUES)[number];
export const CapabilityGroupSchema = z.enum(CAPABILITY_GROUP_VALUES);

/**
 * Capability-registry governance category (docs/wire-contract-conventions.md §1 vocabulary table,
 * 2026-09-08 decision): four values, distinct from the gate-side `OperationMode`
 * (`observe`/`execute` only, enums.ts) even though the two share two literal tokens —
 * `CapabilityMode` and `OperationMode` are separate types, never structurally interchanged.
 *
 *   - `observe`  — read-only.
 *   - `write`    — an immediate, in-platform state change: audited, no human approval gate
 *     (`assert_fact`, `create_task`, `invoke_worker`, `report_task_result`, `cancel_task`,
 *     `register_source`, `submit_observations`, `record_decision`, `resolve_conflict`,
 *     `verify_fact`, `report_turn`, `supersede_fact`, `invalidate_fact` — the exact list the
 *     conventions doc names, previously mistagged `propose`).
 *   - `propose`  — produces a draft or request awaiting human publish/approval: `propose_*`,
 *     `request_connection`, `propose_ontology_change` only (never any other name).
 *   - `execute`  — acts through a Gatekeeper on an external system, policy-approved.
 */
export const CAPABILITY_MODE_VALUES = ['observe', 'write', 'propose', 'execute'] as const;
export type CapabilityMode = (typeof CAPABILITY_MODE_VALUES)[number];
export const CapabilityModeSchema = z.enum(CAPABILITY_MODE_VALUES);

export interface Capability {
  readonly name: string;
  readonly group: CapabilityGroup;
  readonly mode: CapabilityMode;
  readonly channel: CapabilityChannel;
  readonly minRole?: Role;
  readonly paramsSchema: z.ZodType;
  /**
   * docs/wire-contract-conventions.md §5 ("为每个 capability 增加 `resultSchema`...列表结果复用
   * `listEnvelope(itemSchema)`") — the workspace-wide rollout (contract snapshots, the vocabulary
   * guard, every existing capability) is S3.7's own job, not this one; left `undefined` on every
   * pre-existing row rather than guessed at. `get_operation_stats` (S3.12 follow-up) is the first
   * entry to carry one, since its own task brief asked for it explicitly ahead of S3.7 landing.
   */
  readonly resultSchema?: z.ZodType;
  readonly description: string;
  /**
   * S2.13 addition (design doc §11 "凭证不进任何 agent 进程，也不进内核进程"; docs/development-
   * tasks.md S2.13 "内核数据库任何表中不存在凭证明文"): top-level param field names that
   * `application/gateway/dispatch.ts` must replace with a fixed placeholder before writing this
   * capability's call into `audit_records.payload` — the credential passed to `create_connection`
   * is forwarded straight to the Gatekeeper's own ConnectedAccount store and must never reach any
   * kernel table, audit included. Data, not a function (this registry is otherwise pure data,
   * §9.3's own framing, and a plain string list stays trivially serializable for future tooling
   * like `check-capability-consistency.ts`, S3.7). Absent (the default for every other capability)
   * means the parsed params are audited verbatim, exactly as before this field existed.
   */
  readonly redactedParamKeys?: readonly string[];
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
    // The dispatchable capability behind the `<gate>.<op>` observe projection below (design doc
    // §5.1.4 "门上的 observe 类 Operation" is in the entry ceiling; §11 "观察免审"): runs exactly one
    // published observe-class Operation and returns its data — an execute-class Operation is
    // refused (403), never turned into an ActionRequest here; that is `request_action`'s job, and
    // an entry Handle deliberately does not hold it (governance/capability/handles.ts).
    name: 'observe_operation',
    group: 'gate',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({ gatekeeperId: id, operation: z.string().min(1), params: jsonRecord.optional() })
      .strict(),
    description:
      'Run one published observe-class Operation on a Gatekeeper and return its data (the capability behind every <gate>.<op> observe tool); execute-class Operations are refused.',
  },
  {
    name: '<gate>.<op>',
    group: 'gate',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: jsonRecord,
    description:
      'Observe-class Operation projected from a Gatekeeper’s interface manifest as a tool (placeholder pattern, not dispatchable — the tool calls `observe_operation`); params validated against that Operation’s own params_schema at runtime. Available to entry and Worker Handles.',
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
    // S2.13 extension (task brief: "add the follow-up capability the human uses to complete a
    // connection ... e.g. complete_connection {connectionRequestId, endpoint, credential?,
    // credentialKind, manifestSource?}"): this repo already registered `create_connection` for
    // that step (design doc §9.3's own name) before S2.13 started — extended additively here
    // rather than adding a second, competing capability name for the same action. Every new field
    // is optional and `credentials` (existing, was required) is loosened to optional, so no
    // pre-existing caller of the old shape breaks:
    //   - `connectionRequestId`: the `request_connection` card being resolved, when there is one
    //     (owner may also call this directly, S2.4's precedent for owner-channel testing).
    //   - `endpoint`: the already-running Gatekeeper instance's own HTTP address (every transport
    //     kind — including cli/ssh — is fronted by one, `@nexttime/gatekeeper-base`'s `server.ts`).
    //   - `credentialKind`: `'connected_account'` (default when `credentials` is given) posts
    //     `credentials` to the gate's per-`onBehalfOf` ConnectedAccount store; `'shared'` (default
    //     when `credentials` is omitted) skips that call — the gate was already configured with a
    //     shared/env credential out-of-band (§7.5, the docker/ragflow gates' own pattern).
    //   - `onBehalfOf`: whose ConnectedAccount this credential is filed under; defaults to the
    //     connection request's own requester, or the calling owner if there was no request.
    //   - `manifestSource`: an OpenAPI document URL (`http`) or MCP server endpoint (`mcp`) to
    //     import from; omitted falls back to the gate's own already-configured manifest
    //     (`describe_operations`).
    name: 'create_connection',
    group: 'connection',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        connectionRequestId: id.optional(),
        kind: z.enum(['http', 'mcp', 'cli', 'ssh']),
        target: z.string(),
        endpoint: z.string().min(1),
        credentials: z.unknown().optional(),
        credentialKind: z.enum(['shared', 'connected_account']).optional(),
        onBehalfOf: id.optional(),
        manifestSource: z.string().optional(),
      })
      .strict(),
    description:
      'Register a Gatekeeper instance with address and credentials (credentials go straight to the gatekeeper, never persisted by the kernel); auto-imports a manifest draft for http/mcp.',
    redactedParamKeys: ['credentials'],
  },
  {
    name: 'publish_manifest',
    group: 'connection',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ gatekeeperId: id }).strict(),
    description: 'Publish every draft Operation in a Gatekeeper’s interface manifest (I16/I17).',
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
  {
    // S2.13 addition: the owner-facing queue `request_connection` cards land in — same "list a
    // human queue" shape as `list_pending` (governance group) below.
    name: 'list_connection_requests',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ status: ConnectionRequestStatusSchema.optional() }).strict(),
    description: 'List ConnectionRequests, optionally filtered by status.',
  },
  // -----------------------------------------------------------------------------------------
  // S3.11 read-side additions (docs/development-tasks.md, 2026-09-08 "中台控制面" decision): the
  // console's "系统接入" (system connections) directory — every Gatekeeper instance and its
  // Operations, member-visible (unlike `list_connection_requests` above, which is the owner-only
  // in-flight queue). `find_operations` (task group) stays the agent-side ranked-search
  // counterpart; these are the flat human directory.
  // -----------------------------------------------------------------------------------------
  {
    name: 'list_gatekeepers',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: noParams,
    description:
      'List every registered Gatekeeper instance (health/manifest not included — see get_gatekeeper).',
  },
  {
    name: 'get_gatekeeper',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ gatekeeperId: id }).strict(),
    description: 'One Gatekeeper instance with its Operations and a live health probe.',
  },
  {
    name: 'list_operations',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ gatekeeperId: id.optional() }).strict(),
    description:
      'Human-facing Operation directory across Gatekeepers (any status), optionally filtered to one gate.',
  },
  {
    // S3.12 catalog-usage follow-up (docs/development-tasks.md S3.12, 2026-09-08+): the catalog's
    // per-Operation "调用/批准/拒绝/最近" (calls/approved/rejected/last-called) usage widget —
    // `list_operations` joins this by `{gatekeeperId, operationName}`.
    //
    // Source and semantics (`governance/approval/reads.ts`'s `getOperationStats` owns the query):
    // execute-class Operations only — `calls`/`approved`/`rejected`/`autoApproved`/`failed` are
    // counts of `action_requests` rows for that `{gatekeeperId, action_kind}` within the trailing
    // `days` window, grouped by the row's **current** `status` column (governance/approval's own
    // 13-state machine, `@nexttime/shared`'s `transitions.ts` `ACTION_REQUEST_TRANSITIONS`):
    // `approved`/`auto_approved`(→`autoApproved`)/`rejected`/`failed` count rows *currently sitting
    // in* that status — not a cumulative "ever passed through" history, so a request that was
    // `approved` and has since finished executing (`executing`/`executed`/`verified`) is counted
    // under `calls` only, since `executing` does not itself distinguish the `approved` vs.
    // `auto_approved` path it arrived from. `calls` is every status, unfiltered.
    //
    // Observe-class Operations (`<gate>.<op>` / `observe_operation`, §11 "观察免审" — never create
    // an ActionRequest row at all) are **not** included: `substrate/audit`'s own `queryAudit`
    // service interface (the only sanctioned way to read `audit_records` — that module's boundary
    // forbids querying its table directly) has no date-range filter and no payload-path grouping,
    // so an efficient per-operation, `days`-windowed observe count is not achievable through it
    // without extending that module's query surface — out of this task's bounded scope. Left as a
    // documented gap rather than an approximate guess; the web catalog degrades to "—" for any
    // Operation absent from `items` (which, today, is every observe-class one, and any execute-class
    // one with zero calls in the window — the two are indistinguishable on this wire shape, and
    // "no calls happened" is the correct real-world reading of "—" either way).
    name: 'get_operation_stats',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({ gatekeeperId: id.optional(), days: z.number().int().min(1).max(90).optional() })
      .strict(),
    resultSchema: listEnvelope(
      z
        .object({
          gatekeeperId: id,
          operationName: z.string().min(1),
          calls: z.number().int().nonnegative(),
          approved: z.number().int().nonnegative(),
          rejected: z.number().int().nonnegative(),
          autoApproved: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          lastCalledAt: z.string(),
        })
        .strict(),
    ),
    description:
      'Per-Operation call/approve/reject counters over the trailing `days` window (default 30, max 90) — execute-class only, aggregated from action_requests.status (see this entry’s own doc comment for the observe-class gap and the "current status, not decision history" semantics).',
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
    // S2.4 addition (see task brief: "add publish_operation/deprecate_operation in the existing
    // style only if absent"). Params identify one Operation by its `{gatekeeperId, name}` identity
    // (governance/gatekeepers/manifest.ts — an Operation has no dedicated id column, unlike
    // WorkerDefinition/Skill/Procedure, design doc §9.2 "operations 作为平台元本体存于 objects /
    // links"). No `minRole` — same as `publish_skill`/`publish_procedure`/
    // `publish_worker_definition` below, human-channel-only is the actual gate (I16). Distinct
    // from the *connection flow*'s (S2.13) owner-scoped `publish_manifest`, which publishes a
    // whole newly-imported manifest at once (design doc §7.5 "owner 发布清单") — this capability
    // publishes one already-drafted Operation, the same granularity `publish_skill` operates at.
    name: 'publish_operation',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ gatekeeperId: id, name: z.string().min(1) }).strict(),
    description: 'Publish a draft Operation (I16).',
  },
  {
    name: 'deprecate_operation',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ gatekeeperId: id, name: z.string().min(1) }).strict(),
    description: 'Deprecate a published Operation.',
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
    // S2.14 addition, same style as `list_worker_definitions` (worker group, below): observe,
    // handle channel, no minRole beyond authentication. Unlike `list_worker_definitions` ("List
    // published WorkerDefinitions" only), this also returns the caller's own drafts (I16 read-
    // privacy: a draft is private to its proposer, enforced by `application/worker/skills.ts`'s
    // `listSkills` query itself, not by this schema) — see this task's PR body for the "propose →
    // not visible to another principal → publish → visible" acceptance test this backs.
    name: 'list_skills',
    group: 'meta',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: noParams,
    description: 'List published Skills plus the caller’s own draft Skills.',
  },
  {
    name: 'list_procedures',
    group: 'meta',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: noParams,
    description: 'List published Procedures plus the caller’s own draft Procedures.',
  },
  {
    name: 'assert_fact',
    group: 'meta',
    mode: 'write',
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
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ factId: id, value: z.unknown() }).strict(),
    description: 'Supersede a Fact from the same Source with a newer value.',
  },
  {
    name: 'invalidate_fact',
    group: 'meta',
    mode: 'write',
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
    mode: 'write',
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
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ conflictId: id, resolution: z.string() }).strict(),
    description: 'Resolve a Conflict.',
  },
  {
    name: 'verify_fact',
    group: 'epistemic',
    mode: 'write',
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
    // Authority-tightening fix (review job 652a4abc, lane3 P1-5): `minRole` here is only the
    // ordinary "authenticated principal" floor `roleSatisfiesMinRole` gives every role including
    // `auditor` — it is deliberately *not* the real gate. A non-owner human caller (this
    // capability's channel is `handle`, but §9.3 "human 通道调用同样允许" — see authorize.ts's own
    // module doc comment) must additionally hold an active `capability='gatekeeper'` Grant for
    // the target Gatekeeper, checked by `request-action-handler.ts`'s
    // `assertHumanGatekeeperAccess`, which excludes `auditor` outright regardless of any grant —
    // a role-hierarchy `minRole` cannot express either rule (I14 is resource-scoped, and
    // `roleSatisfiesMinRole('auditor', 'member')` is `true` by design, see authorize.ts). Added
    // here mainly so this capability's own declaration is not silently missing one, matching
    // `observe_operation` right below it.
    minRole: 'member',
    paramsSchema: z
      .object({
        gatekeeperId: id,
        operation: z.string(),
        params: jsonRecord,
        // P1-1 fix (review job 652a4abc): scoped to (workspace, on_behalf_of, sid, key) by the
        // handler before it reaches the DB's (workspace_id, idempotency_key) unique index — a
        // repeat call with the same key returns the existing ActionRequest instead of creating a
        // second one. Omitted, a default is derived from (sid|principal, gatekeeperId, operation,
        // stable params hash) so an unmarked retry still collapses onto the same row.
        idempotencyKey: z.string().min(1).optional(),
      })
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
    paramsSchema: z.object({ actionKindTag: z.string() }).strict(),
    description:
      '"Always allow this kind" — writes a workspace auto-approval rule for an ActionKind.',
  },
  {
    // 2026-09-08 wire-contract-conventions §1(c): a Grant points at a resource (`resourceType` +
    // optional `resourceId`), not a "capability" — that word is reserved for the registry name of
    // *this* row's own `name` field. Current callers pass `resourceType: 'gatekeeper'` with the
    // gatekeeper id as `resourceId` (was `capability: 'gatekeeper'` with the id inside `scope`);
    // future resource types (`worker_definition`, `skill`) follow the same shape. `resourceId` is
    // optional — a workspace-wide grant (e.g. an approval-queue `action_kind` grant, which has no
    // single resource instance) omits it, matching the DB's own nullable `resource_id` column
    // (migrations/governance/00NN_capability_grants_resource_type.sql). `scope` keeps only genuine
    // additional qualifiers now that the id has its own first-class field.
    name: 'grant_capability',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        principalId: id,
        resourceType: z.string(),
        resourceId: id.optional(),
        scope: jsonRecord.optional(),
      })
      .strict(),
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
  // -----------------------------------------------------------------------------------------
  // S3.11 read-side additions (docs/development-tasks.md, 2026-09-08 "中台控制面" decision):
  // list views over the governance state this group already writes (`grant_capability`/
  // `revoke_capability`/`set_policy`/`set_quota` above) — the console's "系统接入" / "模型与配额"
  // pages need to *see* what those write capabilities produced. `minRole: 'operator'` per the
  // task's own role table ("配额查看 = operator").
  // -----------------------------------------------------------------------------------------
  {
    name: 'list_grants',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ principalId: id.optional() }).strict(),
    description: 'List CapabilityGrants, optionally filtered to one Principal.',
  },
  {
    name: 'list_policies',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: noParams,
    description: 'List every Policy row in the workspace.',
  },
  {
    name: 'list_quotas',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: noParams,
    description:
      'List the workspace’s I18 quota values (overrides merged over compiled-in defaults).',
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

/**
 * Ceiling (seconds) on `invoke_worker`'s `wait:true` wait window — design doc §8.2 "默认 90 秒".
 * Neither the design doc nor the kernel's own code defines a larger ceiling anywhere, so this
 * constant doubles as both the kernel's default wait timeout (`application/task/invoke.ts`'s
 * `DEFAULT_WAIT_TIMEOUT_SECONDS`, sourced from here) and the hard max a caller's own `timeout`
 * param may request (enforced below via `.max()`, mirroring `application/task/quotas.ts`'s
 * `HARD_MAX_DEPTH` "schema rejects above the ceiling, resolve-time code also clamps defensively"
 * two-layer convention). Exported so `@nexttime/platform-extension`'s `KernelClient` can size its
 * own per-call HTTP timeout to always outlast the kernel's own wait, rather than duplicating this
 * number in two packages (fix/invoke-worker-wait-and-outbox-prune).
 */
export const INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS = 90;

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
    mode: 'write',
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
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ input: z.unknown() }).strict(),
    description: 'Create a Task.',
  },
  {
    name: 'invoke_worker',
    group: 'task',
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        definitionId: id,
        version: z.number().int().positive(),
        input: z.unknown(),
        wait: z.boolean().optional(),
        // Seconds, not ms — matches the design doc's own prose ("默认 90 秒", §8.2). Clamped to
        // INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS (fix/invoke-worker-wait-and-outbox-prune) — a
        // caller asking for more than the kernel will ever wait gets a 400 here rather than a
        // silently-truncated wait.
        timeout: z.number().int().positive().max(INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS).optional(),
        // S2.7 addition: narrows which of the WorkerDefinition's own declared `gates` this
        // particular invocation actually needs (§8.5 "衰减出只含所需门的 Handle"); omitted defaults
        // to every gate the definition declares. Never lets a caller ask for a gate the
        // definition itself does not declare — see application/task/invoke.ts's
        // `computeChildHandleScope`.
        gates: z.array(id).optional(),
      })
      .strict(),
    description:
      'invoke_worker(definition@version, input, wait, timeout, gates?) — §8.2; wait defaults to ' +
      'false — returns { taskId, status } immediately and the caller polls get_task for the ' +
      'result; wait:true blocks (up to timeout seconds, default/max 90) for a terminal result ' +
      'instead. A decayed child Handle inherits on_behalf_of.',
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
    // S2.9 addition (task brief: "add a small kernel capability/endpoint if none exists — e.g.
    // list_allowed_operations returning the published Operations of the Gatekeepers in the
    // Handle's resources.gatekeeper scope"). Deliberately not gated by anything beyond the calling
    // Handle's own scope — the returned list is already exactly what `resources.gatekeeper` (plus
    // `<gate>.<op>`/`<gate>.<op>:execute` presence) permits the caller to act on via
    // `request_action`; this capability only ever *describes* that existing grant, never widens it.
    // Worker-mode "infrastructure" capability (governance/capability/handles.ts
    // `WORKER_INFRASTRUCTURE_CAPABILITY_NAMES`) — see that file's own doc comment for why it is
    // unconditionally reachable by any WorkerRun Handle regardless of what its WorkerDefinition
    // declares.
    name: 'list_allowed_operations',
    group: 'task',
    mode: 'observe',
    channel: 'handle',
    paramsSchema: noParams,
    description:
      'List the published Operations of every Gatekeeper in the calling Handle’s own ' +
      'resources.gatekeeper scope (§7.4 worker-mode tool registration) — one entry per ' +
      '`<gate>.<op>`, with `mode`/`params_schema`/`blast_radius`.',
  },
  {
    // S2.9 addition (task brief: "report_task_result (Handle channel)"). Handler-side identity
    // check (application/gateway/worker-result-handler.ts): the calling Handle's `claims.sid` must
    // match the Task's own WorkerRun `session_id`, or 403 — never the request body's own
    // `taskId`/`workerRunId` fields (I13-style: identity from the Handle, not the caller-supplied
    // body). See worker-result.ts for the full contract shape. Same "infrastructure capability"
    // note as `list_allowed_operations` above.
    name: 'report_task_result',
    group: 'task',
    mode: 'write',
    channel: 'handle',
    paramsSchema: WorkerResultCapabilityParamsSchema,
    description:
      'Post a Worker’s result contract ({summary, findings?, factsToAssert?, evidence?, ' +
      'artifacts?, proposedSkill?, proposedOperations?}) back to the kernel; completes the Task ' +
      '(§7.3 结果契约).',
  },
  {
    // S2.10 addition (docs/development-tasks.md S2.10 deliverable 4): §9.3 never defined a list
    // capability for Task (only `get_task`, one at a time) — the web Tasks & Workers view needs
    // one, so this task adds it, mirroring `get_task`'s shape exactly except for the missing
    // `taskId` param and the return being an array. `channel: 'human'` (not `'handle'`, unlike
    // `get_task`): this is a web-only "browse my own Tasks" facility, not something a Worker/entry
    // Handle has a use for (an entry Handle already gets its own summary via `get_entry_context`).
    name: 'list_tasks',
    group: 'task',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: noParams,
    description: "List the caller's own Tasks (newest first), each with its WorkerRuns.",
  },
  {
    name: 'cancel_task',
    group: 'task',
    mode: 'write',
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
    // S2.6 extension (see PR body "改动"): the original shape (`{definition: jsonRecord}` alone)
    // had no way to address which WorkerDefinition family a proposal belongs to, or to declare
    // `kind` — both required by `worker_definitions`' own schema (migrations/worker/
    // 0001_worker_definitions.sql: `kind`/`id` are columns, never derived from inside the opaque
    // `definition` jsonb). `definitionId` omitted starts a new family (a fresh `id`, version 1);
    // given, proposes the next version under that existing `id`. `kind` is immutable per `id`
    // across versions (enforced by application/worker/definitions.ts, not by this schema alone —
    // a Zod shape has no way to see prior versions).
    paramsSchema: z
      .object({
        definitionId: id.optional(),
        kind: WorkerDefinitionKindSchema,
        definition: jsonRecord,
      })
      .strict(),
    description:
      'Propose a private draft WorkerDefinition version (definitionId omitted starts a new family).',
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
    mode: 'write',
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
    mode: 'write',
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

// -------------------------------------------------------------------------------------------
// members (S3.11, docs/development-tasks.md 2026-09-08 "中台控制面" decision): Principal CRUD
// (who can get in — kind/role/API key) plus the two workspace-summary/config reads with no other
// natural group (`get_workspace`, `list_models`). All `channel: 'human'` — a Principal's own
// membership/credentials are never a Handle-scope concern (I13: a Handle only ever narrows what
// its *own* on_behalf_of principal may already do; it never manages *other* principals).
//
// `mode` (docs/wire-contract-conventions.md §1, MANDATORY): every write here is an immediate,
// in-platform, audited state change with no policy-gated external Gatekeeper call — `write`, not
// `execute` (`execute` is reserved for "acts through a Gatekeeper on an external system, policy-
// approved" per that doc's own vocabulary table). This intentionally does not retag the
// pre-existing `grant_capability`/`revoke_capability`/`set_policy`/`set_quota`/`issue_handle`
// rows above (still `mode: 'execute'`) — those predate the 2026-09-08 mode decision and are out
// of this task's scope (S3.7 is where the registry-wide retag lands).
// -------------------------------------------------------------------------------------------

const membersCapabilities: readonly Capability[] = [
  {
    name: 'list_principals',
    group: 'members',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: noParams,
    description:
      'List every Principal in the workspace (kind/role/hasApiKey/disabledAt — never the key hash).',
  },
  {
    name: 'create_principal',
    group: 'members',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ role: RoleSchema, displayName: z.string().min(1) }).strict(),
    description:
      'Create a kind=human Principal and its API key; the plaintext key is returned once and never stored or readable again.',
  },
  {
    name: 'set_principal_role',
    group: 'members',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ principalId: id, role: RoleSchema }).strict(),
    description:
      'Change a Principal’s role. Refuses to demote the last remaining owner and refuses any non-human (agent/service) Principal.',
  },
  {
    name: 'rotate_api_key',
    group: 'members',
    // minRole:'member' is the registry-level floor only (every principal may rotate their own
    // key); the handler additionally enforces "owner, or the caller’s own principalId" — the same
    // "minRole gates entry, the handler narrows further" shape `set_auto_approved_action_kind`
    // already established (packages/shared/src/capabilities.ts governance group, above).
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ principalId: id }).strict(),
    description:
      'Rotate a Principal’s API key — the old key stops working immediately; the new plaintext key is returned once.',
  },
  {
    name: 'disable_principal',
    group: 'members',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ principalId: id }).strict(),
    description:
      'Disable a Principal: its API key and entry-session Handles stop working immediately. Refuses the last remaining owner and refuses disabling oneself.',
  },
  {
    name: 'get_workspace',
    group: 'members',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: noParams,
    description:
      'The calling workspace’s identity and summary counts (principals, gatekeepers), plus the resolved calling Principal’s own identity and role (caller).',
  },
  {
    name: 'list_models',
    group: 'members',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: noParams,
    description:
      'The llm-proxy model whitelist, read from the kernel’s read-only models.json mount (never provider keys).',
  },
];

// -------------------------------------------------------------------------------------------
// agent_profile (S3.13, docs/development-tasks.md "每用户智能体配置：AgentProfile / AgentPolicy"):
// per-(workspace,principal) AgentProfile — a never-widening subset projection of the principal's
// Grant, resolved against the workspace's own AgentPolicy defaults — plus the AgentPolicy itself.
// All `channel: 'human'`: a principal's own agent configuration (and the workspace policy
// governing it) is never a Handle-scope concern (I13, same reasoning `membersCapabilities`'s own
// doc comment already gives for Principal CRUD — a Handle only ever narrows what its own
// on_behalf_of principal may already do, it never manages configuration of any principal at all).
//
// `mode` (docs/wire-contract-conventions.md §1, MANDATORY): both `get_*` reads are `observe`; both
// `set_*` writes are immediate, in-platform, audited state changes with no policy-gated external
// Gatekeeper call — `write`, never `execute` (S3.13's own spec: "变更是即时的、不走 propose/approve").
// -------------------------------------------------------------------------------------------

const agentProfileCapabilities: readonly Capability[] = [
  {
    name: 'get_agent_profile',
    group: 'agent_profile',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ principalId: id.optional() }).strict(),
    description:
      'Read one Principal’s AgentProfile — raw fields (null = inherit) plus the resolved `effective` values after applying the workspace AgentPolicy and the principal’s Grants. Omit principalId for the caller’s own; naming another principal requires owner.',
  },
  {
    name: 'set_agent_profile',
    group: 'agent_profile',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        principalId: id.optional(),
        // Every field is independently optional (a partial update — an omitted field is left
        // unchanged) and, where present, `nullable` (an explicit `null` resets that field to
        // "inherit the workspace AgentPolicy default") — distinguishable because zod leaves an
        // omitted key as `undefined` while a present-but-null key parses to `null`.
        model: z.string().min(1).nullable().optional(),
        enabledSkills: z.array(z.string().min(1)).nullable().optional(),
        enabledGatekeepers: z.array(id).nullable().optional(),
        enabledWorkerDefinitions: z.array(id).nullable().optional(),
        promptAddendum: z.string().nullable().optional(),
        autoApproveLow: z.boolean().nullable().optional(),
      })
      .strict(),
    description:
      'Update one Principal’s AgentProfile (never widens past the principal’s own Grants or the workspace AgentPolicy — 400 invalid_params on a model outside the whitelist, a Skill that is not published, a Gatekeeper the principal holds no Grant for, an addendum over the policy’s length cap, or auto-approve-low when the policy forbids it). A member may edit only their own profile, and only when AgentPolicy.memberCanEditProfile is true; an owner may edit anyone’s. Immediate and audited; revokes the target principal’s entry-session Handles so the next turn re-mints under the new scope.',
  },
  {
    name: 'get_agent_policy',
    group: 'agent_profile',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: noParams,
    description:
      'Read the workspace’s AgentPolicy (compiled-in defaults projected when no row has ever been written).',
  },
  {
    name: 'set_agent_policy',
    group: 'agent_profile',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        allowedModels: z.array(z.string().min(1)).optional(),
        defaultModel: z.string().min(1).nullable().optional(),
        memberCanEditProfile: z.boolean().optional(),
        maxPromptAddendumChars: z.number().int().positive().optional(),
        allowedSkills: z.array(z.string().min(1)).optional(),
        allowedGatekeepers: z.array(id).optional(),
        allowMemberAutoApproveLow: z.boolean().optional(),
      })
      .strict(),
    description:
      'Update the workspace’s AgentPolicy — a partial update, omitted fields are left unchanged. Owner only.',
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
  ...membersCapabilities,
  ...agentProfileCapabilities,
];

/** Capability names that must always be on the human channel (I16/I17/§9.3), never handle. */
const HUMAN_ONLY_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  'publish_ontology_version',
  'create_connection',
  'publish_manifest',
  'connect_gatekeeper',
  'list_connection_requests',
  'publish_skill',
  'publish_procedure',
  'deprecate_skill',
  'deprecate_procedure',
  'publish_operation',
  'deprecate_operation',
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
  // S3.11 (docs/development-tasks.md, 2026-09-08 "中台控制面" decision): member/governance
  // management and its read-side directory — never a legitimate Handle-scope member (see this
  // task's own CI guard, scripts/check-membership-capabilities-not-in-handle-scope.sh, for the
  // second, independent enforcement of the same rule against governance/capability/handles.ts).
  'list_principals',
  'create_principal',
  'set_principal_role',
  'rotate_api_key',
  'disable_principal',
  'list_grants',
  'list_policies',
  'list_quotas',
  'list_gatekeepers',
  'get_gatekeeper',
  'list_operations',
  'get_operation_stats',
  'get_workspace',
  'list_models',
  // S3.13 (docs/development-tasks.md "每用户智能体配置") — AgentProfile/AgentPolicy management and
  // its read side: a principal's own agent configuration, never a legitimate Handle-scope member
  // (same reasoning as the S3.11 membership names right above).
  'get_agent_profile',
  'set_agent_profile',
  'get_agent_policy',
  'set_agent_policy',
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
