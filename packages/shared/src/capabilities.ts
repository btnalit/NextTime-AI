import { z } from 'zod';
import {
  ConflictStatusSchema,
  ConnectionRequestStatusSchema,
  RoleSchema,
  WorkerDefinitionKindSchema,
} from './enums.js';
import { ActionRequestStatusSchema } from './enums.js';
import type { CapabilityChannel, Role } from './enums.js';
import { listEnvelope } from './envelope.js';
import { CapabilityScopeSchema } from './handle-token.js';
import { OntologyDefinitionSchema } from './ontology-definition.js';
import * as wire from './wire/index.js';
import { WorkerResultCapabilityParamsSchema } from './worker-result.js';

/**
 * `resultSchema` reuse note (docs/wire-contract-conventions.md §5, S3.7): every schema below that
 * projects a first-class platform resource (Task, ActionRequest, Principal, ...) imports it from
 * `./wire/*.ts` (aliased `wire` here) rather than redefining an equivalent shape inline — see that
 * directory's own `index.ts` doc comment. A handful of capabilities have no wired handler yet
 * (`docs/development-tasks.md`'s own "registered but unhandled" list, this PR body's own table) —
 * their `resultSchema` is a permissive, documented placeholder (reusing `jsonRecord`, defined
 * below, or `listEnvelope(jsonRecord)` for a `list_*`/`find_*`/`query_*` name) rather than a guess
 * at a shape no handler has ever produced.
 */

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
  // P-A1 (docs/platform-admin-design.md §5): the platform-management plane — users, platform
  // settings, overview, platform audit. Every member is `scope: 'platform'` (see `Capability.scope`).
  'platform',
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
 *     (`assert_fact`, `invoke_worker`, `report_task_result`, `cancel_task`,
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

/**
 * P-A1 (docs/platform-admin-design.md §7; design doc §7.11 "`scope:'platform'`"): which plane a
 * capability lives on. `workspace` (the default, every pre-existing row) runs inside one
 * workspace's RLS context as a Principal. `platform` has no workspace: the gateway admits it only
 * for a console-session caller whose user is `platform_role = 'admin'` (never a Principal, never a
 * Handle), runs it under `app.platform = on`, and audits it with `workspace_id is null` +
 * `actor_user_id`. Distinct from `CapabilityScope` (handle-token.ts), which is a Handle's
 * capability *set*.
 */
export const CAPABILITY_SCOPE_KIND_VALUES = ['workspace', 'platform'] as const;
export type CapabilityScopeKind = (typeof CAPABILITY_SCOPE_KIND_VALUES)[number];

export interface Capability {
  readonly name: string;
  readonly group: CapabilityGroup;
  readonly mode: CapabilityMode;
  readonly channel: CapabilityChannel;
  /** See `CapabilityScopeKind`; absent = `'workspace'`. */
  readonly scope?: CapabilityScopeKind;
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
/** P-B1 `issue_service_handle`: one year, the CLI's own default and ceiling. */
const SERVICE_HANDLE_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

/** The shape `application/gateway/request-action-handler.ts`'s `runObserve` produces —
 *  `observe_operation`'s own result, and (fixed after this task's first CI run caught the
 *  mismatch — real Postgres, not reproducible locally) also one of `request_action`'s three
 *  possible result shapes, taken whenever the resolved Operation is `mode: 'observe'` (see that
 *  entry's own resultSchema doc comment below). Defined once, reused by both. */
const gateObserveResultSchema = z
  .object({
    status: z.literal('ok'),
    data: z.unknown(),
    observedFactCount: z.number().int().nonnegative(),
  })
  .strict();

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
    resultSchema: listEnvelope(wire.ChatWireSchema),
    description: 'List the chats owned by the calling principal.',
  },
  {
    name: 'new_chat',
    group: 'chat',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ title: z.string().optional() }).strict(),
    resultSchema: wire.ChatWireSchema,
    description: 'Create a new private Chat for the calling principal.',
  },
  {
    name: 'send_chat_message',
    group: 'chat',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ chatId: id, text: z.string().min(1) }).strict(),
    resultSchema: z.object({ messageId: id, sequence: z.number(), turnId: z.string() }).strict(),
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
    resultSchema: z.object({ stopped: z.boolean() }).strict(),
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
    resultSchema: listEnvelope(wire.ChatMessageWireSchema),
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
    resultSchema: z.object({ subscribed: z.boolean() }).strict(),
    description:
      'Subscribe to a Chat’s push events before paging history, so no event is missed (§9.4).',
  },
];

// -------------------------------------------------------------------------------------------
// ontology
// -------------------------------------------------------------------------------------------

const ontologyCapabilities: readonly Capability[] = [
  {
    // S3.1: handled by `application/gateway/ontology-handlers.ts`'s `publishOntologyVersionHandler`
    // (`substrate/ontology/registry.ts`'s `publishOntologyDraft`). `id`/`version` together address
    // one exact `ontology_versions` row (its primary key, `migrations/core/0002_substrate.sql`) —
    // no separate synthetic id exists to name a row with one field.
    name: 'publish_ontology_version',
    group: 'ontology',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ id: id, version: z.number().int().positive() }).strict(),
    resultSchema: wire.OntologyPublishResultWireSchema,
    description: 'Publish a draft OntologyVersion (I16). Human channel only.',
  },
  {
    // S3.1: handled by `proposeOntologyChangeHandler` (`registry.ts`'s `proposeOntologyChange`).
    // `id` omitted starts a brand-new ontology family (fresh id, version 1); given, proposes the
    // next version under that existing family. `change` is validated against the real
    // `OntologyDefinitionSchema` here (not a permissive placeholder) so a structurally invalid
    // proposal 400s at the params-validation step (`dispatchCapability`), never reaching the
    // handler as an unmapped 500 — see `ontology-definition.ts`'s own doc comment on why this
    // schema lives in `packages/shared` rather than kernel.
    name: 'propose_ontology_change',
    group: 'ontology',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    paramsSchema: z.object({ id: id.optional(), change: OntologyDefinitionSchema }).strict(),
    resultSchema: wire.OntologyProposeResultWireSchema,
    description:
      'Propose a private draft ontology change (I16); visible only to the proposer until published.',
  },
  {
    // S3.1: handled by `getTypeHandler` (`registry.ts`'s `getType`) — looks up `typeName` across
    // every OntologyVersion currently visible to the caller (every published family's latest
    // version, plus the caller's own pending drafts; `loadVisibleOntology`'s own doc comment).
    name: 'get_type',
    group: 'ontology',
    mode: 'observe',
    channel: 'handle',
    paramsSchema: z.object({ typeName: z.string() }).strict(),
    resultSchema: wire.OntologyTypeWireSchema.nullable(),
    description: 'Read one ObjectType/LinkType/ActionType definition.',
  },
  {
    // S3.1: handled by `listTypesHandler` (`registry.ts`'s `listTypes`). Name starts with `list_`
    // (vocabulary guard rule (e)) — wrapped in `listEnvelope`.
    name: 'list_types',
    group: 'ontology',
    mode: 'observe',
    channel: 'handle',
    paramsSchema: z.object({ kind: z.enum(['object', 'link', 'action']).optional() }).strict(),
    resultSchema: listEnvelope(wire.OntologyTypeWireSchema),
    description: 'List type definitions in the published OntologyVersion.',
  },
  {
    // S3.1: handled by `validateHandler` (`registry.ts`'s `validateLink`) — domain/range check
    // (I2), not generic JSON-Schema payload validation (the placeholder this capability carried
    // before a handler existed); "validate_link" in docs/development-tasks.md S3.1 names this
    // exact semantics, there is no separately-registered `validate_link` capability.
    name: 'validate',
    group: 'ontology',
    mode: 'observe',
    channel: 'handle',
    paramsSchema: z
      .object({
        link: z
          .object({
            linkType: z.string().min(1),
            sourceType: z.string().min(1),
            targetType: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    resultSchema: wire.OntologyValidateLinkResultWireSchema,
    description:
      'Validate a candidate Link’s linkType/sourceType/targetType against every visible LinkType signature’s domain/range (I2).',
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
    resultSchema: wire.ObjectWireSchema.nullable(),
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
    resultSchema: z
      .object({
        nodes: z.array(z.string()),
        edges: z.array(
          z
            .object({
              linkId: z.string(),
              linkType: z.string(),
              sourceObjectId: z.string(),
              targetObjectId: z.string(),
              depth: z.number().int().positive(),
            })
            .strict(),
        ),
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
    // W5 (docs/STATUS.md 遗留 2): `limit` / `cursor` per docs/wire-contract-conventions.md §3 — a
    // `limit` above the kernel's `MAX_SEARCH_LIMIT` is clamped and the result carries
    // `truncated: true`; `cursor` is the previous page's opaque `nextCursor`.
    paramsSchema: z
      .object({
        query: z.string(),
        objectType: z.string().optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    // S3.7 wire fix (see PR body): previously a bare `GraphObject[]` — §3 "不返回裸数组". Now
    // `{items}`, same envelope shape as every `list_*`/`find_*` capability even though this name
    // does not match that prefix pattern (the vocabulary guard's rule (e) does not require it —
    // fixed anyway, since a bare array is the one thing §3 unconditionally forbids).
    resultSchema: listEnvelope(wire.ObjectWireSchema),
    description:
      'Search Objects by substring over properties/identity, optionally filtered by objectType; ' +
      'keyset-paginated (limit, cursor → nextCursor).',
  },
  {
    name: 'state_at',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ objectId: id, at: z.string() }).strict(),
    resultSchema: wire.ObjectFactsWireSchema,
    description: 'Bitemporal read: the Object’s state as of a given instant.',
  },
  {
    name: 'find_operations',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ need: z.string() }).strict(),
    resultSchema: listEnvelope(wire.ObjectWireSchema),
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
    resultSchema: listEnvelope(
      z
        .object({
          definitionId: id,
          version: z.number().int().positive(),
          kind: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
        })
        .strict(),
    ),
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
    resultSchema: listEnvelope(
      z
        .object({
          procedureId: id,
          version: z.number().int().positive(),
          name: z.string().optional(),
          description: z.string().optional(),
        })
        .strict(),
    ),
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
    resultSchema: gateObserveResultSchema,
    description:
      'Run one published observe-class Operation on a Gatekeeper and return its data (the capability behind every <gate>.<op> observe tool); execute-class Operations are refused.',
  },
  {
    // Placeholder pattern (this group's own module doc comment: "not dispatchable — the real
    // dynamic names are generated at runtime"). Permissive, documented `resultSchema` (S3.7 task
    // brief): the real result is whatever the underlying Gatekeeper Operation's own
    // `result_mapping` produces, which this static registry row cannot know ahead of time.
    name: '<gate>.<op>',
    group: 'gate',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: jsonRecord,
    resultSchema: jsonRecord,
    description:
      'Observe-class Operation projected from a Gatekeeper’s interface manifest as a tool (placeholder pattern, not dispatchable — the tool calls `observe_operation`); params validated against that Operation’s own params_schema at runtime. Available to entry and Worker Handles.',
  },
  {
    // Placeholder pattern — see `<gate>.<op>`'s neighboring comment above. Never actually dispatched
    // as itself either (intercepted client-side and turned into `request_action`, whose own
    // `resultSchema` documents the real result shape).
    name: '<gate>.<op>:execute',
    group: 'gate',
    mode: 'execute',
    channel: 'handle',
    paramsSchema: jsonRecord,
    resultSchema: jsonRecord,
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
    resultSchema: wire.ConnectionRequestCreatedWireSchema,
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
    resultSchema: wire.CreateConnectionResultWireSchema,
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
    resultSchema: wire.PublishManifestResultWireSchema,
    description: 'Publish every draft Operation in a Gatekeeper’s interface manifest (I16/I17).',
  },
  {
    name: 'connect_gatekeeper',
    group: 'connection',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ gatekeeperId: id, principalId: id }).strict(),
    resultSchema: wire.CapabilityGrantWireSchema,
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
    resultSchema: listEnvelope(wire.ConnectionRequestWireSchema),
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
    resultSchema: listEnvelope(wire.GatekeeperSummaryWireSchema),
    description:
      'List every registered Gatekeeper instance (health/manifest not included — see get_gatekeeper).',
  },
  {
    name: 'issue_service_handle',
    group: 'connection',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        /** An existing `kind:'service'` Principal of this workspace (create one with `create_principal`). */
        principalId: z.string().min(1),
        /** Capability names the Handle may call — never a `channel:'human'` capability (refused at issuance). */
        scope: z.array(z.string().min(1)).min(1).max(100),
        /** Default one year; the CLI’s `issue-service-handle` default, now on the page. */
        ttlSeconds: z.number().int().positive().max(SERVICE_HANDLE_MAX_TTL_SECONDS).optional(),
      })
      .strict(),
    resultSchema: z
      .object({
        handle: z.string(),
        principalId: z.string(),
        sessionId: z.string(),
        expiresAt: z.string(),
        scope: CapabilityScopeSchema,
      })
      .strict(),
    redactedParamKeys: [],
    description:
      'P-B1 (design §6.3 "外部运行时"): issue a long-lived CapabilityHandle for a service Principal — an external runtime such as Claude Code, a local pi over /mcp or a collector — from the 访问 page instead of the `issue-service-handle` CLI. The token is returned exactly once; the session shows up in the platform’s external-runtime inventory and can be revoked there.',
  },
  {
    name: 'list_available_gate_instances',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    // P-B2a: member, not owner — a member needs the linked rows to enter their own credential
    // (`issue_gate_credential_token`); the list is catalog metadata, enabling stays owner-only.
    minRole: 'member',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.AvailableGateInstanceWireSchema),
    description:
      'P-B1: the platform’s enabled gate instances whose connector is in platform-preset mode, with whether this workspace already enabled each (its Gatekeeper id).',
  },
  {
    name: 'enable_gate_instance',
    group: 'connection',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ gateId: z.string().min(1) }).strict(),
    resultSchema: wire.EnableGateInstanceResultWireSchema,
    description:
      'P-B1: enable a platform gate instance in this workspace — registers its Gatekeeper, imports and publishes its announced Operations (origin import), and links the workspace to the instance so trust and disabled Operations are read live. Idempotent per (workspace, gate).',
  },
  {
    name: 'issue_gate_credential_token',
    group: 'connection',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ gateId: z.string().min(1) }).strict(),
    resultSchema: wire.GateHostTokenWireSchema,
    description:
      'P-B2a (决定 ⑩): a 5-minute token that lets this browser post the caller’s own credential straight to the gate host for a platform-hosted `connected_account` instance this workspace enabled. The kernel never sees the credential.',
  },
  {
    name: 'get_gatekeeper',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ gatekeeperId: id }).strict(),
    resultSchema: wire.GatekeeperDetailWireSchema,
    description: 'One Gatekeeper instance with its Operations and a live health probe.',
  },
  {
    name: 'list_operations',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ gatekeeperId: id.optional() }).strict(),
    resultSchema: listEnvelope(wire.OperationSummaryWireSchema),
    description:
      'Human-facing Operation directory across Gatekeepers (any status), optionally filtered to one gate.',
  },
  {
    // S3.12 catalog-usage follow-up (docs/development-tasks.md S3.12, 2026-09-08+): the catalog's
    // per-Operation "调用/批准/拒绝/最近" (calls/approved/rejected/last-called) usage widget —
    // `list_operations` joins this by `{gatekeeperId, operationName}`.
    //
    // Source and semantics (`governance/approval/reads.ts`'s `getOperationStats` owns the query):
    // execute-class Operations — `approved`/`rejected`/`autoApproved`/`failed` are counts of
    // `action_requests` rows for that `{gatekeeperId, action_kind}` within the trailing `days`
    // window, grouped by the row's **current** `status` column (governance/approval's own
    // 13-state machine, `@nexttime/shared`'s `transitions.ts` `ACTION_REQUEST_TRANSITIONS`):
    // `approved`/`auto_approved`(→`autoApproved`)/`rejected`/`failed` count rows *currently sitting
    // in* that status — not a cumulative "ever passed through" history, so a request that was
    // `approved` and has since finished executing (`executing`/`executed`/`verified`) is counted
    // under `calls` only, since `executing` does not itself distinguish the `approved` vs.
    // `auto_approved` path it arrived from.
    //
    // S3.8 (docs/development-tasks.md S3.8, 2026-09-09+) closed the observe-class gap this entry
    // used to document as out of scope: `substrate/audit`'s `queryAuditActionOperationStats`
    // (a date-range, payload-grouped read added specifically for this) now supplies `observeCalls`
    // — a count of `observe_operation` AuditRecords (the capability behind every `<gate>.<op>`
    // observe tool call, §11 "观察免审" — these never create an `action_requests` row) grouped by
    // the `gatekeeperId`/`operation` carried in the audit payload's own `params`. `calls` now
    // includes both sources summed; `observeCalls` is the observe-only subset (always `0` for a
    // purely execute-class row, and `approved`/`rejected`/`autoApproved`/`failed` stay `0` for a
    // purely observe-class row — see `governance/approval/reads.ts`'s `OperationStatsRow` doc
    // comment for the full merge rule and the one remaining, still-documented gap: a Worker's
    // `request_action` call that happens to resolve to an observe-mode Operation audits under
    // `action = 'request_action'`, not `'observe_operation'`, and is not attributed here).
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
          observeCalls: z.number().int().nonnegative(),
          lastCalledAt: z.string(),
        })
        .strict(),
    ),
    description:
      'Per-Operation call/approve/reject counters over the trailing `days` window (default 30, max 90) — execute-class counters (approved/rejected/autoApproved/failed) aggregated from action_requests.status ("current status, not decision history"); observe-class calls (<gate>.<op> / observe_operation, never an ActionRequest) counted separately in `observeCalls` and folded into `calls` — see this entry’s own doc comment for the merge rule and remaining known gap.',
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
    resultSchema: wire.OperationProposeResultWireSchema,
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
    resultSchema: wire.OperationPublishResultWireSchema,
    description: 'Publish a draft Operation (I16).',
  },
  {
    name: 'deprecate_operation',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ gatekeeperId: id, name: z.string().min(1) }).strict(),
    resultSchema: wire.OperationDeprecateResultWireSchema,
    description: 'Deprecate a published Operation.',
  },
  {
    name: 'propose_skill',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    paramsSchema: z.object({ skill: jsonRecord }).strict(),
    resultSchema: wire.SkillProposeResultWireSchema,
    description: 'Propose a private draft Skill, typically at the end of a successful WorkerRun.',
  },
  {
    name: 'propose_procedure',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    paramsSchema: z.object({ procedure: jsonRecord }).strict(),
    resultSchema: wire.ProcedureProposeResultWireSchema,
    description: 'Propose a private draft Procedure distilled from a successful Task.',
  },
  {
    name: 'publish_skill',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ skillId: id }).strict(),
    resultSchema: wire.SkillPublishResultWireSchema,
    description: 'Publish a draft Skill (I16).',
  },
  {
    name: 'publish_procedure',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ procedureId: id }).strict(),
    resultSchema: wire.ProcedurePublishResultWireSchema,
    description: 'Publish a draft Procedure (I16).',
  },
  {
    name: 'deprecate_skill',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ skillId: id }).strict(),
    resultSchema: wire.SkillPublishResultWireSchema,
    description: 'Deprecate a published Skill.',
  },
  {
    name: 'deprecate_procedure',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ procedureId: id }).strict(),
    resultSchema: wire.ProcedurePublishResultWireSchema,
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
    resultSchema: listEnvelope(wire.SkillSummaryWireSchema),
    description: 'List published Skills plus the caller’s own draft Skills.',
  },
  {
    name: 'list_procedures',
    group: 'meta',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.ProcedureSummaryWireSchema),
    description: 'List published Procedures plus the caller’s own draft Procedures.',
  },
  {
    // S3.3: real handler (`application/gateway/fact-handlers.ts`'s `assertFactHandler`), replacing
    // the `AssertFactWriteNotImplementedError` stub. `paramsSchema` was previously
    // `{objectId, linkType, value, sourceId?}` — a shape that predated S2.6, never carried the
    // `sourceObjectId`/`targetObjectId`/`activityId` `substrate/graph/store.ts`'s `AssertFactInput`
    // actually requires (I3), and could never have backed a real write (see that stub's own doc
    // comment, removed by this task). Replaced with the real shape a single-Fact write needs;
    // `activityId` is optional — omitted, the handler starts and ends its own Activity around this
    // one call (I3 "every Fact must trace to an Activity"); given, the caller's own already-open
    // Activity is reused (its lifecycle stays the caller's to manage).
    name: 'assert_fact',
    group: 'meta',
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        sourceObjectId: id,
        targetObjectId: id,
        linkType: z.string().min(1),
        properties: jsonRecord.optional(),
        activityId: id.optional(),
        validFrom: z.string().optional(),
        validUntil: z.string().nullable().optional(),
        confidence: z.number().min(0).max(1).optional(),
      })
      .strict(),
    resultSchema: wire.FactWireSchema,
    description:
      'Assert a Fact; resulting epistemic_status depends on the caller’s principal kind (§5.5).',
  },
  {
    // S3.3: real handler (`supersedeFactHandler`) — same params-shape reasoning as `assert_fact`
    // above (this capability's old `{factId, value}` placeholder could never have backed a real
    // `substrate/graph/store.ts` `SupersedeFactInput` call either, which needs the replacement's
    // full `(linkType, sourceObjectId, targetObjectId)` to match the Fact it supersedes — I5, see
    // `SupersedeIdentityMismatchError`'s own doc comment in that module).
    name: 'supersede_fact',
    group: 'meta',
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        factId: id,
        sourceObjectId: id,
        targetObjectId: id,
        linkType: z.string().min(1),
        properties: jsonRecord.optional(),
        activityId: id.optional(),
        validFrom: z.string().optional(),
        validUntil: z.string().nullable().optional(),
        confidence: z.number().min(0).max(1).optional(),
      })
      .strict(),
    resultSchema: wire.FactWireSchema,
    description: 'Supersede a Fact from the same Source with a newer value.',
  },
  {
    // S3.3: real handler (`invalidateFactHandler`) — this capability's params/result shape was
    // already correct (well-defined regardless of a handler existing, per the pre-existing note on
    // this row); only the handler itself was missing.
    name: 'invalidate_fact',
    group: 'meta',
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ factId: id, reason: z.string().optional() }).strict(),
    resultSchema: wire.FactWireSchema,
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
    resultSchema: wire.ExplainResultWireSchema,
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
    resultSchema: z.object({ id, status: z.string(), turnId: z.string() }).strict(),
    description: 'Record a Decision (starts in `proposed`, see transitions.ts).',
  },
  {
    // S3.2: `substrate/epistemic/decisions.ts`'s `queryDecisions` — name starts with `query_`
    // (vocabulary guard rule (e)): `listEnvelope`.
    name: 'query_decisions',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        objectId: id.optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.DecisionWireSchema),
    description: 'Query recorded Decisions, optionally by related Object or since a timestamp.',
  },
  {
    // S3.2: `substrate/epistemic/decisions.ts`'s `findPrecedents` — name starts with `find_`
    // (vocabulary guard rule (e)): `listEnvelope`.
    name: 'find_precedents',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        objectId: id.optional(),
        actionKindTag: z.string().optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.DecisionWireSchema),
    description:
      'Prior Decisions on the same Object or ActionType, ordered by recency (Semantica precedent search).',
  },
  {
    // S3.2: `substrate/epistemic/decisions.ts`'s `causalChain`.
    name: 'causal_chain',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        factId: id.optional(),
        decisionId: id.optional(),
        depth: z.number().int().min(1).max(5).optional(),
      })
      .strict(),
    resultSchema: wire.CausalChainResultWireSchema,
    description:
      'Provenance chain leading to a Fact or Decision, bounded depth ≤5 (Semantica get_causal_chain).',
  },
  {
    // S3.2: `substrate/epistemic/decisions.ts`'s `decisionImpact`.
    name: 'decision_impact',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ decisionId: id }).strict(),
    resultSchema: wire.DecisionImpactResultWireSchema,
    description: 'Downstream impact of a Decision (Semantica analyze_decision_impact).',
  },
  {
    // S3.2: `substrate/epistemic/conflicts.ts`'s `listConflicts` — name starts with `list_`
    // (vocabulary guard rule (e)): `listEnvelope`.
    name: 'list_conflicts',
    group: 'epistemic',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        status: ConflictStatusSchema.optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.ConflictWireSchema),
    description:
      'List Conflicts visible to the caller (private-Source Conflicts are one-sided, §5.6).',
  },
  {
    // S3.2: `application/gateway/epistemic-handlers.ts`'s `resolveConflictHandler`. `channel:
    // 'human'` (deviation from the pre-S3.2 placeholder's `'handle'` — see PR body "假设"):
    // resolving a Conflict invalidates a Fact and records a Decision, a governed human judgment
    // call the S3.2 dispatch text itself marks "(human)" — not something a Worker's Handle should
    // reach on its own.
    name: 'resolve_conflict',
    group: 'epistemic',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        conflictId: id,
        resolution: z.enum(['keep_a', 'keep_b', 'invalidate_both']),
        reason: z.string(),
      })
      .strict(),
    resultSchema: wire.ConflictWireSchema,
    description: 'Resolve a Conflict — keep one Fact, or invalidate both (I4 lifecycle).',
  },
  {
    // S3.2: `application/gateway/epistemic-handlers.ts`'s `verifyFactHandler`. `channel: 'human'`
    // (same deviation/reasoning as `resolve_conflict` above — the S3.2 dispatch text marks this one
    // "(human)" too); `paramsSchema` narrowed from the placeholder's `{factId, evidenceIds}` to
    // just `{factId}` — Evidence is attached separately (the existing, unrelated `attach_evidence`
    // capability written path); `verify_fact` only checks Evidence already exists (I3.6) and
    // promotes, it does not itself attach any.
    name: 'verify_fact',
    group: 'epistemic',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ factId: id }).strict(),
    resultSchema: wire.FactWireSchema,
    description: 'Promote a Fact to epistemic_status=verified with Evidence (I3.6).',
  },
];

// -------------------------------------------------------------------------------------------
// governance
// -------------------------------------------------------------------------------------------

/**
 * Hard ceiling for `issue_handle`'s requested `ttlSeconds` — an interactive Handle is a
 * developer-facing external credential (Claude Code, `pi`), not the resident entry agent's own
 * session (`ENTRY_HANDLE_TTL_SECONDS` is kernel config, never a client-supplied override); a human
 * explicitly requests this ttl, so a generous but bounded ceiling (30 days) avoids an
 * unbounded-lifetime credential from a single mistaken parameter while comfortably outliving one
 * working session. No default is declared here — the handler's own default lives beside its
 * session-creation logic (`application/gateway/issue-handle-handler.ts`), not duplicated in this
 * domain-layer schema.
 */
const ISSUE_HANDLE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

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
    // request-action-handler.ts's `requestActionHandler`: a two-phase handler whose real result
    // (what `dispatchCapability` actually returns — see dispatch.ts's own doc comment: once an
    // `afterCommit` continuation is present, *its* resolved value replaces the phase-1 `result`)
    // is one of three shapes:
    //   - the resolved Operation is `mode: 'observe'` → the handler returns `runObserve`'s result
    //     directly (no ActionRequest is ever created for an observe-class Operation, §11
    //     "观察免审") — the same shape `observe_operation` returns (`gateObserveResultSchema`
    //     above; found missing from this union entirely by this task's own first CI run — real
    //     Postgres, not reproducible locally, `KERNEL_VALIDATE_RESULTS=1`).
    //   - `mode: 'execute'`, `runGovernedRequest` resolves with no `afterCommit` (a terminal/no-op
    //     status, or `pending_approval && !awaitDecision`) → the full ActionRequest wire
    //     projection, optionally with a `simulate` field.
    //   - `mode: 'execute'`, `afterCommit` present (auto_approved/approved/executing/executed/
    //     verified/failed, or `pending_approval && awaitDecision`) → the narrower `{id, status,
    //     data?, reason?}` execution-outcome shape those continuations (`tryExecuteInline`/
    //     `awaitConcurrentExecution`/`pollAndExecute`/`readTerminalOutcome`) resolve to.
    // Modeled as a union rather than "fixed" into one shape — unifying them is a real, larger
    // behavior change to a heavily fought-over handler (see that file's own module doc comment),
    // out of this task's "no runtime behaviour change" scope.
    resultSchema: z.union([
      gateObserveResultSchema,
      wire.ActionRequestWireSchema.extend({ simulate: z.unknown().optional() }),
      z
        .object({
          id: z.string(),
          status: ActionRequestStatusSchema,
          data: z.unknown().optional(),
          reason: z.string().optional(),
        })
        .strict(),
    ]),
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
    resultSchema: wire.ActionRequestWireSchema,
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
    resultSchema: wire.ActionRequestWireSchema,
    description: 'Reject a pending ActionRequest.',
  },
  {
    name: 'list_pending',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({}).strict(),
    resultSchema: listEnvelope(wire.ActionRequestWireSchema),
    description: 'List ActionRequests pending the caller’s approval.',
  },
  {
    name: 'get_action',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ actionRequestId: id }).strict(),
    resultSchema: wire.ActionRequestWireSchema,
    description: 'Read one ActionRequest.',
  },
  {
    name: 'set_auto_approved_action_kind',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ actionKindTag: z.string() }).strict(),
    resultSchema: wire.PolicyWireSchema,
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
    resultSchema: wire.CapabilityGrantWireSchema,
    description: 'Grant a Capability to a Principal.',
  },
  {
    name: 'revoke_capability',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ grantId: id }).strict(),
    resultSchema: wire.CapabilityGrantWireSchema,
    description: 'Revoke a CapabilityGrant.',
  },
  {
    name: 'set_policy',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ policy: jsonRecord }).strict(),
    resultSchema: wire.PolicyWireSchema,
    description: 'Write a Policy rule (allow/require_approval/deny).',
  },
  {
    name: 'set_quota',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ key: z.string(), value: z.unknown() }).strict(),
    resultSchema: wire.QuotaWireSchema,
    description: 'Set an I18 quota (invoke_worker depth, concurrency, token/time, daily cost).',
  },
  {
    // S3.6 registry-entry fix (docs/development-tasks.md W2-B): previously `{sessionId,
    // scope: jsonRecord}` — a best-effort placeholder guessing at a shape no handler had ever
    // produced (this file's own "resultSchema reuse note" above). The real handler
    // (packages/kernel/src/application/gateway/issue-handle-handler.ts) issues a Handle for a
    // *new* `kind='mcp_session'` session (design doc §9.2 "mcp_session（外部运行时）" — the design's
    // own term for exactly this: an `interactive`-mode client running outside the platform, e.g.
    // Claude Code or a developer's local `pi`) on behalf of the *calling* human Principal — never
    // a caller-supplied existing sessionId (I13: identity is never accepted as an input).
    // `sessionKind` is the domain-facing param name the task brief uses ('interactive', the only
    // value this handler creates today — a literal union of one, not a free string, so a typo
    // fails fast at this schema layer rather than deep inside the handler); it names *what kind of
    // external client* is asking, not `sessions.kind` (`@nexttime/shared`'s `SessionKind`) itself —
    // the handler maps it onto `mcp_session`.
    name: 'issue_handle',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        sessionKind: z.literal('interactive'),
        ttlSeconds: z.number().int().positive().max(ISSUE_HANDLE_MAX_TTL_SECONDS).optional(),
        // A *requested* scope, intersected against the caller's own entry ceiling ∩ Grants — never
        // the full CapabilityScopeSchema shape (both fields required there): omitting `scope`
        // entirely, or either field within it, means "everything the ceiling/Grants already allow
        // on that axis", not "nothing". See the handler's own `intersectScope` for the exact rule.
        scope: z
          .object({
            capabilities: z.array(z.string().min(1)).optional(),
            resources: z.record(z.string(), z.array(z.string())).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    resultSchema: z
      .object({
        handle: z.string(),
        sessionId: id,
        onBehalfOf: id,
        expiresAt: z.string(),
        scope: CapabilityScopeSchema,
      })
      .strict(),
    description:
      'Issue a CapabilityHandle for a new interactive-mode session (a pi/Claude-Code-like ' +
      'client running outside the platform, §7.4 "interactive"), scoped to the intersection of ' +
      'the request, the entry-agent ceiling, and the caller’s own Grants — never wider than an ' +
      'entry Handle. The token is returned once and never stored in plaintext.',
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
    resultSchema: listEnvelope(wire.CapabilityGrantWireSchema),
    description: 'List CapabilityGrants, optionally filtered to one Principal.',
  },
  {
    name: 'list_policies',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.PolicyWireSchema),
    description: 'List every Policy row in the workspace.',
  },
  {
    name: 'list_quotas',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.QuotaListEntryWireSchema),
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
    resultSchema: z
      .object({
        // `application/linkage`'s own undelivered-item payloads — opaque per-kind JSON, not one
        // fixed shape (`DrainedContextItems`, application/linkage/store.ts).
        pendingApprovals: z.array(jsonRecord),
        tasks: z.array(jsonRecord),
        facts: z.array(wire.FactWireSchema),
        precedents: z.array(z.unknown()),
      })
      .strict(),
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
    resultSchema: z.object({ turnId: id, status: z.string() }).strict(),
    description:
      'Report a completed Turn’s outcome back to the kernel (§7.2 "每轮回传 Turn 与决策"); called ' +
      'from the entry agent’s pi `agent_end` handler.',
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
    resultSchema: wire.InvokeWorkerResultWireSchema,
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
    resultSchema: wire.TaskWireSchema,
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
    resultSchema: listEnvelope(
      z
        .object({
          gatekeeperId: id,
          gateName: z.string(),
          name: z.string(),
          // The Operation's own manifest shape (`OperationSchema`, action-description.ts) —
          // `unknown` here rather than that schema itself: `worker-result-handler.ts`'s
          // `toWireOperation` passes `record.operation` straight through untyped
          // (`listPublishedOperationsForGatekeepers`'s own row shape), so this is honestly what
          // the handler returns today, not a guaranteed-valid `Operation`.
          operation: z.unknown(),
        })
        .strict(),
    ),
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
    resultSchema: wire.ReportTaskResultWireSchema,
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
    resultSchema: listEnvelope(wire.TaskWireSchema),
    description: "List the caller's own Tasks (newest first), each with its WorkerRuns.",
  },
  {
    name: 'cancel_task',
    group: 'task',
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ taskId: id }).strict(),
    resultSchema: wire.CancelTaskResultWireSchema,
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
    resultSchema: wire.WorkerDefinitionWireSchema,
    description:
      'Propose a private draft WorkerDefinition version (definitionId omitted starts a new family).',
  },
  {
    name: 'publish_worker_definition',
    group: 'worker',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ definitionId: id, version: z.number().int().positive() }).strict(),
    resultSchema: wire.WorkerDefinitionWireSchema,
    description: 'Publish a draft WorkerDefinition (I12: immutable once published).',
  },
  {
    name: 'deprecate_worker_definition',
    group: 'worker',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z.object({ definitionId: id, version: z.number().int().positive() }).strict(),
    resultSchema: wire.WorkerDefinitionWireSchema,
    description: 'Deprecate a published WorkerDefinition version.',
  },
  {
    name: 'list_worker_definitions',
    group: 'worker',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ kind: z.enum(['entry', 'worker']).optional() }).strict(),
    resultSchema: listEnvelope(wire.WorkerDefinitionWireSchema),
    description: 'List published WorkerDefinitions.',
  },
];

// -------------------------------------------------------------------------------------------
// ingest — service principals (collectors, §7.8; docs/development-tasks.md S3.3)
// -------------------------------------------------------------------------------------------

/** One `submit_observations` link — the observed Object's own `{objectType, identity}` (§16
 *  identity keys) plus the Fact's own `properties`. `target` never carries an `id` — a collector
 *  observes structural facts by identity, never by an already-known graph id (that would require
 *  the collector to have looked the target object up first, defeating the point of upsert-by-
 *  identity). */
const ingestLinkTargetSchema = z
  .object({ objectType: z.string().min(1), identity: jsonRecord })
  .strict();
const ingestLinkSchema = z
  .object({
    linkType: z.string().min(1),
    target: ingestLinkTargetSchema,
    properties: jsonRecord.optional(),
  })
  .strict();
/** One `submit_observations` observation — design doc §5.1.3 "Observation：a single observed
 *  input" — an Object identity/properties plus zero or more outgoing Links from it. */
const ingestObservationSchema = z
  .object({
    objectType: z.string().min(1),
    identity: jsonRecord,
    properties: jsonRecord.optional(),
    links: z.array(ingestLinkSchema).optional(),
  })
  .strict();

const ingestCapabilities: readonly Capability[] = [
  {
    // S3.3: real handler (`application/gateway/ingest-handlers.ts`'s `registerSourceHandler`).
    // `ownerPrincipalId` is deliberately not a caller-supplied param (the pre-existing placeholder
    // shape had one) — a Source's owner is always the calling principal (I13's own "on_behalf_of
    // only from the Handle, never the request body" discipline applied to this table's equivalent
    // field), never a value the caller names.
    name: 'register_source',
    group: 'ingest',
    mode: 'write',
    channel: 'handle',
    paramsSchema: z
      .object({
        kind: z.string().min(1),
        name: z.string().min(1),
        visibility: z.enum(['workspace', 'private']),
        uri: z.string().optional(),
        metadata: jsonRecord.optional(),
      })
      .strict(),
    resultSchema: wire.SourceWireSchema,
    description: 'Register a Source (document/DB/API/person/agent session).',
  },
  {
    // S3.3: real handler (`submitObservationsHandler`). `activityId` optional — see this file's
    // own `assert_fact` doc comment for the same omitted/given convention; here the default (no
    // `activityId`) is what "one Activity per submission" (docs/development-tasks.md S3.3, a
    // collector's own per-run acceptance criterion) actually means in practice, since a collector
    // never has a pre-existing Activity to hand in.
    name: 'submit_observations',
    group: 'ingest',
    mode: 'write',
    channel: 'handle',
    paramsSchema: z
      .object({
        sourceId: id,
        activityId: id.optional(),
        observations: z.array(ingestObservationSchema).min(1),
      })
      .strict(),
    resultSchema: wire.SubmitObservationsResultWireSchema,
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
    // S3.7 wire fix (see PR body): previously a bare `AuditRecordRow[]` — §3 "不返回裸数组". This
    // name does not match `list_*`/`find_*` either, same reasoning as `search` (graph group)
    // above — fixed anyway.
    resultSchema: listEnvelope(wire.AuditRecordWireSchema),
    description: 'Query AuditRecords.',
  },
  {
    name: 'reconstruct',
    group: 'audit',
    mode: 'observe',
    channel: 'human',
    minRole: 'auditor',
    paramsSchema: z.object({ entityId: id }).strict(),
    resultSchema: z
      .object({
        object: wire.ObjectWireSchema.nullable(),
        facts: z.array(wire.FactWireSchema),
        auditRecords: z.array(wire.AuditRecordWireSchema),
      })
      .strict(),
    description: 'Reconstruct an entity’s history from AuditRecords.',
  },
  {
    // S3.5 (docs/development-tasks.md §S3.5, design doc §9.5's Lineage mapping): PROV-JSON-style
    // export of the provenance around one Fact/Decision/Activity, built from `explain`'s own data
    // (`application/gateway/provenance-graph.ts`'s `buildProvJsonDocument`, reused by
    // `export-prov-handler.ts`). Exactly one of `factId`/`decisionId`/`activityId` is required —
    // this file's existing convention (decisions.ts's own module doc comment: "no `.refine()` in
    // paramsSchema") leaves that "exactly one" check to the handler, same as `causal_chain` above
    // does for its own `factId`/`decisionId` pair. `depth` only affects a `factId`/`decisionId`
    // root (walked the same way `causal_chain` does); ignored for an `activityId` root, which has
    // no further "chain" to walk beyond itself — see the handler's own doc comment.
    name: 'export_prov',
    group: 'audit',
    mode: 'observe',
    channel: 'human',
    minRole: 'auditor',
    paramsSchema: z
      .object({
        factId: id.optional(),
        decisionId: id.optional(),
        activityId: id.optional(),
        depth: z.number().int().min(1).max(5).optional(),
      })
      .strict(),
    resultSchema: wire.ExportProvResultSchema,
    description:
      'Export a PROV-JSON-style provenance graph around a Fact, Decision, or Activity, built from explain().',
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
    resultSchema: listEnvelope(wire.PrincipalWireSchema),
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
    resultSchema: wire.CreatePrincipalResultWireSchema,
    description:
      'Create a kind=service Principal (an automation credential — scripts, acceptance harnesses) and its API key; the plaintext key is returned once and never stored or readable again. People join a workspace through add_member / add_membership (P-A1), never through this.',
  },
  {
    name: 'add_member',
    group: 'members',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ login: z.string().min(1), role: RoleSchema }).strict(),
    resultSchema: wire.PrincipalWireSchema,
    description:
      'Add an existing platform user to this workspace by login with a role (P-A1) — creates the membership Principal (no API key). 404 user_not_found for an unknown or disabled login, 409 already_member if they already belong here.',
  },
  {
    name: 'set_principal_role',
    group: 'members',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ principalId: id, role: RoleSchema }).strict(),
    resultSchema: wire.PrincipalWireSchema,
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
    resultSchema: wire.RotateApiKeyResultWireSchema,
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
    resultSchema: wire.PrincipalWireSchema,
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
    resultSchema: wire.WorkspaceWireSchema,
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
    resultSchema: listEnvelope(wire.ModelCatalogEntryWireSchema),
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
    resultSchema: wire.AgentProfileWireSchema,
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
    resultSchema: wire.AgentProfileWireSchema,
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
    resultSchema: wire.AgentPolicyWireSchema,
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
    resultSchema: wire.AgentPolicyWireSchema,
    description:
      'Update the workspace’s AgentPolicy — a partial update, omitted fields are left unchanged. Owner only.',
  },
];

// -------------------------------------------------------------------------------------------
// platform — P-A1 (docs/platform-admin-design.md §5/§6.1/§6.6/§6.7). All `scope: 'platform'`,
// human channel, no `minRole`: authorization is `platform_role = 'admin'` on the console user,
// enforced by the gateway (application/gateway/authorize.ts), not by workspace role. Every write
// is audited as a platform row (`workspace_id is null`, `actor_user_id`).
// -------------------------------------------------------------------------------------------

const platformUserId = z.string().min(1);
const platformCursorParams = {
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

const platformCapabilities: readonly Capability[] = [
  {
    name: 'platform_overview',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: wire.PlatformOverviewWireSchema,
    description:
      'The administrator landing page in one read: kernel version and applied migrations, user / workspace / gatekeeper counts, a service-health summary, the first-run checklist (live state of each page, never a wizard), and the most recent platform audit rows.',
  },
  {
    name: 'list_users',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        status: wire.UserStatusWireSchema.optional(),
        /** Case-insensitive substring over login and display name. */
        query: z.string().min(1).max(100).optional(),
        ...platformCursorParams,
      })
      .strict(),
    resultSchema: listEnvelope(wire.UserWireSchema),
    description:
      'The platform user directory with each user’s memberships. `hasPassword: false` marks a user awaiting activation (backfilled from a pre-S4.1 Principal, or created without a password).',
  },
  {
    name: 'create_user',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        login: z.string().min(3).max(64),
        displayName: z.string().min(1).max(200),
        platformRole: wire.PlatformRoleWireSchema.optional(),
        /** Omit to have a temporary password generated. Either way it is returned once and must be changed on first login. */
        password: z.string().min(1).optional(),
        /** Membership to create alongside the user. Omit `workspaceId` to use the platform default workspace; `null` for none. */
        workspaceId: z.string().min(1).nullable().optional(),
        role: RoleSchema.optional(),
      })
      .strict(),
    resultSchema: wire.CreateUserResultWireSchema,
    redactedParamKeys: ['password'],
    description:
      'Create a platform user with a temporary password (returned exactly once) and, by default, a `member` membership in the platform default workspace so they land in a conversation on first login. Audited; the password never reaches the audit row.',
  },
  {
    name: 'update_user',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        userId: platformUserId,
        displayName: z.string().min(1).max(200).optional(),
        platformRole: wire.PlatformRoleWireSchema.optional(),
      })
      .strict(),
    resultSchema: wire.UserWireSchema,
    description:
      'Change a user’s display name and/or platform role. Demoting the last active administrator, or an account listed in NEXTTIME_PLATFORM_ADMINS, is refused (409 last_admin).',
  },
  {
    name: 'set_user_status',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ userId: platformUserId, status: wire.UserStatusWireSchema }).strict(),
    resultSchema: wire.UserWireSchema,
    description:
      'Disable or re-enable a user. Disabling revokes every console session and every workspace session of the user’s Principals immediately; the row, its memberships and its conversations are kept (audit only grows). The last active administrator cannot be disabled.',
  },
  {
    name: 'reset_user_password',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        userId: platformUserId,
        /** Omit to generate one. */
        password: z.string().min(1).optional(),
      })
      .strict(),
    resultSchema: wire.ResetUserPasswordResultWireSchema,
    redactedParamKeys: ['password'],
    description:
      'Set a temporary password (returned exactly once, must be changed on first login) and clear any login lock. Also the activation path for a user without a password. Revokes the user’s console sessions.',
  },
  {
    name: 'list_user_memberships',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ userId: platformUserId }).strict(),
    resultSchema: listEnvelope(wire.UserMembershipWireSchema),
    description: 'Every workspace membership (Principal) of one user, including disabled ones.',
  },
  {
    name: 'add_membership',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({ userId: platformUserId, workspaceId: z.string().min(1), role: RoleSchema })
      .strict(),
    resultSchema: wire.UserMembershipWireSchema,
    description:
      'Add a user to a workspace with a role — creates the human Principal (no API key); the AgentProfile inherits the workspace default model until the user changes it. 409 already_member if the user already has a membership there.',
  },
  {
    name: 'set_membership_role',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({ userId: platformUserId, workspaceId: z.string().min(1), role: RoleSchema })
      .strict(),
    resultSchema: wire.UserMembershipWireSchema,
    description:
      'Change a user’s role in one workspace. Takes effect immediately; the entry Handle is re-minted on the next turn (S3.11).',
  },
  {
    name: 'remove_membership',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ userId: platformUserId, workspaceId: z.string().min(1) }).strict(),
    resultSchema: wire.RemoveMembershipResultWireSchema,
    description:
      'Remove a user from a workspace: disables the membership Principal and revokes its sessions. The Principal row stays for audit lineage. Refused for the workspace’s last active owner (409 last_owner).',
  },
  {
    name: 'merge_user',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ sourceUserId: platformUserId, targetUserId: platformUserId }).strict(),
    resultSchema: wire.UserWireSchema,
    description:
      'Fold a user awaiting activation (no password) into an existing account: every membership Principal is re-pointed to the target user and the empty source row is deleted. Refused when the source has a password (an API key must never take over a password-protected account) or when both hold a membership in the same workspace.',
  },
  {
    name: 'set_user_budget',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        userId: platformUserId,
        dailyCallLimit: z.number().int().nonnegative().nullable().optional(),
        monthlyTokenBudget: z.number().int().nonnegative().nullable().optional(),
      })
      .strict(),
    resultSchema: wire.UserWireSchema,
    description:
      'Set a user’s daily LLM call limit and/or monthly token budget (`null` = inherit the platform default). Stored and shown from P-A1; enforcement in llm-proxy lands with P-D.',
  },
  {
    name: 'get_platform_settings',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: wire.PlatformSettingsWireSchema,
    description:
      'The platform settings row (compiled-in defaults projected when none has been written).',
  },
  {
    name: 'update_platform_settings',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        siteName: z.string().min(1).max(80).optional(),
        announcement: z.string().max(2000).optional(),
        instanceInstructions: z.string().max(8000).optional(),
        defaultWorkspaceId: z.string().min(1).nullable().optional(),
        defaultEntryModel: z.string().min(1).nullable().optional(),
        defaultDailyCallLimit: z.number().int().nonnegative().nullable().optional(),
        defaultMonthlyTokenBudget: z.number().int().nonnegative().nullable().optional(),
        defaultPlatformRole: wire.PlatformRoleWireSchema.optional(),
        passwordMinLength: z.number().int().min(8).max(128).optional(),
      })
      .strict(),
    resultSchema: wire.PlatformSettingsWireSchema,
    description:
      'Partial update of the platform settings — omitted fields are left unchanged. Every write is audited and bumps `version`; the previous row is kept for rollback.',
  },
  {
    name: 'platform_audit_query',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        actorUserId: platformUserId.optional(),
        action: z.string().min(1).optional(),
        targetUserId: platformUserId.optional(),
        targetWorkspaceId: z.string().min(1).optional(),
        ...platformCursorParams,
      })
      .strict(),
    resultSchema: listEnvelope(wire.PlatformAuditRecordWireSchema),
    description:
      'The platform audit stream (`workspace_id is null`): who changed what on the platform itself, newest first, filterable by actor, action, target user or target workspace.',
  },
  // P-A2 (docs/platform-admin-design.md §2 / §5 "工作区配置", development-tasks P-A2 deliverable 1):
  // workspaces as platform objects. Deeper per-workspace configuration (members, gates, catalog,
  // quotas) stays on the `scope:'workspace'` capabilities the owner pages already use.
  {
    name: 'list_workspaces',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ status: wire.WorkspaceStatusWireSchema.optional() }).strict(),
    resultSchema: listEnvelope(wire.PlatformWorkspaceWireSchema),
    description:
      'Every workspace with its status, entry model, allowed-model list, owners and active member count, oldest first. Disabled workspaces are included (filter with `status`).',
  },
  {
    name: 'list_platform_models',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.ModelCatalogEntryWireSchema),
    description:
      'The llm-proxy model catalog (`<provider>/<id>`) as the platform plane reads it — the same list `list_models` gives a workspace member, for the administrator who is configuring a workspace they are not a member of.',
  },
  {
    name: 'create_workspace',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        name: z.string().min(1).max(120),
        /** The existing platform user who becomes the first `owner`. */
        ownerUserId: platformUserId,
        /** `<provider>/<id>`; must be in the catalog. Omit for pi's own default. */
        entryModel: z.string().min(1).optional(),
        /** `[]` (default) = every catalog model. When non-empty it must contain `entryModel`. */
        allowedModels: z.array(z.string().min(1)).max(100).optional(),
      })
      .strict(),
    resultSchema: wire.PlatformWorkspaceWireSchema,
    description:
      'Create a workspace — a second shared graph for a department that needs isolation — with its first owner, the platform meta-ontology and the v1 entry WorkerDefinition, then delegate: the owner sees only this workspace under 管理 → 工作区配置. Deleting a workspace stays CLI-only.',
  },
  {
    name: 'update_workspace',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        workspaceId: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        /** Must be in the catalog and, when a non-empty allowed list exists, in that list. Cannot be cleared: the entry WorkerDefinition keeps the model it was created with. */
        entryModel: z.string().min(1).optional(),
      })
      .strict(),
    resultSchema: wire.PlatformWorkspaceWireSchema,
    description:
      'Rename a workspace and/or set its entry model — the model every member’s entry agent uses until they pick their own in 我的智能体. Takes effect on containers started afterwards.',
  },
  {
    name: 'set_workspace_status',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({ workspaceId: z.string().min(1), status: wire.WorkspaceStatusWireSchema })
      .strict(),
    resultSchema: wire.PlatformWorkspaceWireSchema,
    description:
      'Disable or re-enable a workspace. Disabling revokes every session in it (entry, Worker, service Handles), stops its members’ entry containers, and hides it from every login; data is kept. The platform default workspace cannot be disabled.',
  },
  {
    name: 'set_allowed_models',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        workspaceId: z.string().min(1),
        /** `[]` = every catalog model. Every entry must be in the catalog; a non-empty list must contain the workspace’s entry model. */
        allowedModels: z.array(z.string().min(1)).max(100),
      })
      .strict(),
    resultSchema: wire.PlatformWorkspaceWireSchema,
    description:
      'Set the models a workspace’s members may pick in 我的智能体 (the AgentPolicy allow-list). A member whose current choice falls outside the list is served the entry model from their next Turn.',
  }, // P-B1 (docs/platform-admin-design.md §6.3 集成; development-tasks P-B "拆分与决定"): connectors,
  // gate instances and external runtimes as platform objects. Enabling an instance *in* a workspace
  // stays on the workspace plane (`enable_gate_instance`, connection group) — it needs a Principal.
  {
    name: 'list_connectors',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.ConnectorWireSchema),
    description:
      'The integration catalog: every connector this deployment knows (packaged gates that announced themselves, plus the generic http / mcp / cli / ssh kinds) with its three-state mode, disabled Operations and instance count.',
  },
  {
    name: 'set_connector_mode',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        name: z.string().min(1).max(64),
        mode: wire.ConnectorModeWireSchema.optional(),
        /** Operation names every instance of this connector refuses from the next call on. */
        disabledOperations: z.array(z.string().min(1)).max(500).optional(),
      })
      .strict(),
    resultSchema: wire.ConnectorWireSchema,
    description:
      'Set a connector’s mode (disabled / self-serve / platform preset) and/or the Operations it may never run. A mode change never tears down existing workspace links; a disabled Operation is refused on its next call everywhere.',
  },
  {
    name: 'list_gate_instances',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        status: wire.GateInstanceStatusWireSchema.optional(),
        connector: z.string().min(1).optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.GateInstanceWireSchema),
    description:
      'Every gate instance that announced itself (`POST /internal/gates/announce`) with status, trust, last heartbeat, Operation count and how many workspaces enabled it.',
  },
  {
    name: 'get_gate_instance',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ gateId: z.string().min(1) }).strict(),
    resultSchema: wire.GateInstanceWireSchema,
    description: 'One gate instance with its announced Operations.',
  },
  {
    name: 'update_gate_instance',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        gateId: z.string().min(1),
        displayName: z.string().min(1).max(120).optional(),
        /** `enabled` lets workspaces enable it; `disabled` hides it from the workspace catalog (existing links keep working until their Operations are disabled). */
        status: z.enum(['enabled', 'disabled']).optional(),
        trust: wire.GateTrustWireSchema.optional(),
      })
      .strict(),
    resultSchema: wire.GateInstanceWireSchema,
    description:
      'Name, enable / disable, or mark a gate instance `vetted` (MCP: allows auto-approval of non-destructive idempotent tools; read at every decision, revocable any time).',
  },
  {
    name: 'create_gate_instance',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        /** Stable id, becomes the instance’s `GATE_ID` and its path on the gate host (`/i/<gateId>`). */
        gateId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
        displayName: z.string().min(1).max(120).optional(),
        transportKind: z.enum(['http', 'mcp']),
        target: z.string().url().max(2000),
        credentialMode: z.enum(['shared', 'connected_account']),
        /** http: the OpenAPI document URL the host imports Operations from (required — without it the instance would have no Operations). mcp: omitted, tools are listed on the target. */
        manifestSource: z.string().url().max(2000).nullable().optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.transportKind === 'http' && !value.manifestSource) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['manifestSource'],
            message:
              'an http instance needs the OpenAPI document URL to import its Operations from',
          });
        }
      }),
    resultSchema: wire.GateInstanceWireSchema,
    description:
      'P-B2a: create a generic http / mcp gate instance for the platform gate host to serve. Lands `discovered` with no heartbeat; the host pulls the definition, imports the Operations and announces it, then the administrator enables it exactly like a packaged gate. Never takes a credential — enter that via `issue_gate_host_token`.',
  },
  {
    name: 'delete_gate_instance',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ gateId: z.string().min(1) }).strict(),
    resultSchema: wire.DeleteGateInstanceResultWireSchema,
    description:
      'P-B2a: remove a gate-host instance no workspace has enabled (409 `gate_in_use` otherwise — disable it instead). Packaged gates cannot be deleted here.',
  },
  {
    name: 'issue_gate_host_token',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ gateId: z.string().min(1) }).strict(),
    resultSchema: wire.GateHostTokenWireSchema,
    description:
      'P-B2a (决定 ⑩): a 5-minute token that lets the administrator’s browser post the instance-wide (`shared`) credential straight to the gate host. The kernel signs the token and never sees the credential.',
  },
  {
    name: 'test_gate_instance',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ gateId: z.string().min(1) }).strict(),
    resultSchema: wire.GateInstanceTestResultWireSchema,
    description:
      'Probe the instance’s health endpoint and ask it to describe its Operations now; records the check time, changes nothing else.',
  },
  {
    name: 'list_external_runtimes',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ workspaceId: z.string().min(1).optional() }).strict(),
    resultSchema: listEnvelope(wire.ExternalRuntimeWireSchema),
    description:
      'Every live session held by a `service` Principal across workspaces — external runtimes such as Claude Code, a local pi over /mcp, or a collector — for inventory and revocation.',
  },
  {
    name: 'revoke_external_runtime',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({ workspaceId: z.string().min(1), sessionId: z.string().min(1) })
      .strict(),
    resultSchema: wire.RevokeExternalRuntimeResultWireSchema,
    description:
      'Revoke one external runtime’s session (and every Handle issued under it) immediately.',
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
  ...platformCapabilities,
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
  'add_member',
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
  // P-A1: the platform plane — never a Handle-scope member, never callable by a Principal at all.
  ...[
    'platform_overview',
    'list_users',
    'create_user',
    'update_user',
    'set_user_status',
    'reset_user_password',
    'list_user_memberships',
    'add_membership',
    'set_membership_role',
    'remove_membership',
    'merge_user',
    'set_user_budget',
    'get_platform_settings',
    'update_platform_settings',
    'platform_audit_query',
    'list_workspaces',
    'list_platform_models',
    'create_workspace',
    'update_workspace',
    'set_workspace_status',
    'set_allowed_models',
    'list_connectors',
    'set_connector_mode',
    'list_gate_instances',
    'get_gate_instance',
    'update_gate_instance',
    'test_gate_instance',
    'list_external_runtimes',
    'revoke_external_runtime',
    'list_available_gate_instances',
    'enable_gate_instance',
    'issue_service_handle',
    'create_gate_instance',
    'delete_gate_instance',
    'issue_gate_host_token',
    'issue_gate_credential_token',
  ],
]);

/** Every `scope: 'platform'` capability name (P-A1) — for the gateway and the CI guard. */
export function listPlatformCapabilities(): readonly Capability[] {
  return CAPABILITY_REGISTRY.filter((capability) => capability.scope === 'platform');
}

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

    // P-A1: a platform-scope capability is authorized by the console user's platform_role, so it
    // must be human-channel and must not also carry a workspace minRole (there is no workspace).
    if (capability.scope === 'platform') {
      if (capability.channel !== 'human') {
        throw new Error(
          `capability registry: "${capability.name}" is scope:platform but not human-channel`,
        );
      }
      if (capability.minRole !== undefined) {
        throw new Error(
          `capability registry: "${capability.name}" is scope:platform but has a minRole`,
        );
      }
      if (capability.group !== 'platform') {
        throw new Error(
          `capability registry: "${capability.name}" is scope:platform but not in group "platform"`,
        );
      }
    } else if (capability.group === 'platform') {
      throw new Error(
        `capability registry: "${capability.name}" is in group "platform" but not scope:platform`,
      );
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
