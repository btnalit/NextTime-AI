import { z } from 'zod';
import {
  ConflictStatusSchema,
  ConnectionRequestStatusSchema,
  DraftKindSchema,
  RoleSchema,
  WorkerDefinitionKindSchema,
} from './enums.js';
import { ActionRequestStatusSchema, ObjectiveOutcomeSchema } from './enums.js';
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
  // P-B2b (docs/platform-admin-design.md §6.4 模块; docs/development-tasks.md §5d S7-D): the
  // workspace-scope half of modules — `list_workspace_modules`/`install_module`/`upgrade_module`
  // (the owner's 能力目录 模块 tab). `assertRegistryConsistent` below requires every `scope:
  // 'platform'` capability to sit in group `'platform'` (and vice versa), so this group's own
  // `list_modules`/`set_default_modules` counterpart stays in `platformCapabilities` alongside
  // every other `scope:'platform'` capability — `connection` follows the identical split
  // (`list_connectors`/`set_connector_mode` are `group:'platform'`, `scope:'platform'`;
  // `enable_gate_instance` is `group:'connection'`, `scope:'workspace'` — two groups, not one
  // shared across both scopes, corrected from this group's own earlier draft comment).
  'modules',
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUP_VALUES)[number];
export const CapabilityGroupSchema = z.enum(CAPABILITY_GROUP_VALUES);

/**
 * Capability-registry governance category (docs/wire-contract-conventions.md §1 vocabulary table,
 * 2026-09-08 decision): four values, distinct from the gate-side `OperationMode`
 * (`observe`/`execute` only, enums.ts) even though the two share two literal tokens —
 * `CapabilityMode` and `OperationMode` are separate types, never structurally interchanged.
 *
 *   - `observe`  — a read as far as governance is concerned: no approval, no draft. Not a promise
 *     that nothing is written — a few observe capabilities record what they read; the explicit
 *     `Capability.sideEffects` flag (D-08, `capabilityHasSideEffects`) is the read-only test.
 *   - `write`    — an immediate, in-platform state change: audited, no human approval gate
 *     (`assert_fact`, `invoke_worker`, `report_task_result`, `cancel_task`,
 *     `register_source`, `submit_observations`, `record_decision`, `resolve_conflict`,
 *     `verify_fact`, `report_turn`, `supersede_fact`, `invalidate_fact` — the exact list the
 *     conventions doc names, previously mistagged `propose`).
 *   - `propose`  — produces a draft or request awaiting human publish/approval: `propose_*`,
 *     `request_connection`, `propose_ontology_change` only (never any other name).
 *   - `execute`  — a consequential effect a person deliberately triggers or a policy gates: acting
 *     through a Gatekeeper on an external system (policy-approved), or a human-channel action with
 *     lasting governance weight — publishing, granting, connecting, approving (D-08 widened this
 *     text to match the registry; the labels themselves are unchanged, several consumers key on
 *     them).
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
  /**
   * Review 2026-10-02 decision D-08: whether a call changes state anywhere — a write to the
   * platform's own tables, an audit-relevant record, or an effect through a Gatekeeper. `mode` is a
   * governance category, not a read-only test: a few `observe` capabilities write (they call a
   * gate and record what it returned, lease context items, record a probe), so they declare
   * `sideEffects: true` here explicitly. Absent means "what the mode says": `observe` has none,
   * every other mode has some — and a non-`observe` capability may never declare `false`
   * (`assertRegistryConsistent`). Read it through `capabilityHasSideEffects`, never through
   * `mode === 'observe'`: the auditor role check (kernel `governance/capability/roles.ts`, D-07)
   * and the console audit view's default "writes and decisions" filter both do.
   */
  readonly sideEffects?: boolean;
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
/** Every active Fact counted per `linkType`, ordered by `linkType` (`get_entry_context`,
 *  `graph_overview`). */
const factCountsByLinkTypeSchema = z.array(
  z.object({ linkType: z.string(), count: z.number().int().nonnegative() }).strict(),
);
/** P-B1 `issue_service_handle`: one year, the CLI's own default and ceiling. */
const SERVICE_HANDLE_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
/** STATUS leftover 89 `attest_fact`: bounds on the attestation's note and optional link — exported
 *  so the console's dialog enforces the same limits the kernel validates. */
export const ATTEST_FACT_NOTE_MAX_LENGTH = 2000;
export const ATTEST_FACT_LINK_MAX_LENGTH = 2048;

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
    // S6-A (docs/console-completion-plan.md §5.1): archived chats are hidden by default — the
    // console's "已归档" filter passes `includeArchived: true` to see them alongside active ones.
    paramsSchema: z.object({ includeArchived: z.boolean().optional() }).strict(),
    resultSchema: listEnvelope(wire.ChatWireSchema),
    description:
      'List the chats owned by the calling principal, newest first. Archived chats (archivedAt set) are omitted unless includeArchived is true.',
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
  // -----------------------------------------------------------------------------------------
  // S6-A chat lifecycle (docs/console-completion-plan.md §4 "Chat 生命周期", §5.1, §6 rows
  // `archive_chat` / `unarchive_chat` / `rename_chat`): `active ↔ archived` is a visibility-only
  // change (`chats.archived_at`, migrations/core/0031); the Chat's Turns/Decisions/Facts stay
  // fully resolvable (`explain`) either way. All three are `mode: 'write'` — an immediate,
  // audited, in-platform state change with no external system behind it (docs/wire-contract-
  // conventions.md §1). Ownership is enforced by the handler (application/gateway/handlers.ts):
  // the calling principal's own Chat, plus — for archive/unarchive only — any Chat the workspace
  // owner can already see (RLS `chats_visibility`, migrations/core/0003, never widened here).
  // Each writes its own domain audit row (`chat.archive` / `chat.unarchive` / `chat.rename`) in
  // addition to dispatch.ts's per-capability row, the same two-row discipline
  // `governance/approval`'s transition log follows.
  // -----------------------------------------------------------------------------------------
  {
    name: 'archive_chat',
    group: 'chat',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ chatId: id }).strict(),
    resultSchema: wire.ChatWireSchema,
    description:
      'Archive a Chat (sets archivedAt; hidden from list_chats unless includeArchived). Own Chat, or any visible Chat for the workspace owner; 403 otherwise. Idempotent on an already-archived Chat. Audit: chat.archive.',
  },
  {
    name: 'unarchive_chat',
    group: 'chat',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ chatId: id }).strict(),
    resultSchema: wire.ChatWireSchema,
    description:
      'Restore an archived Chat (clears archivedAt). Own Chat, or any visible Chat for the workspace owner; 403 otherwise. Idempotent on an active Chat. Audit: chat.unarchive.',
  },
  {
    name: 'rename_chat',
    group: 'chat',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    // At least one non-whitespace character; the handler trims and collapses inner whitespace to
    // one line before writing, so the stored title is never blank.
    paramsSchema: z.object({ chatId: id, title: z.string().min(1).max(200).regex(/\S/) }).strict(),
    resultSchema: wire.ChatWireSchema,
    description:
      'Set a Chat’s title (trimmed, single line, at most 200 characters). Own Chat only; 403 otherwise. A renamed title is never overwritten by the auto-title later messages would produce. Audit: chat.rename.',
  },
  // -----------------------------------------------------------------------------------------
  // S10 E1 结果归因 (docs/s10-evolution-plan-2026-10-04.md §3.4 / §5.3 / §5.6): the requester marks
  // whether a Turn achieved its goal — the objective outcome, apart from the Turn's execution
  // status. `list_chat_turns` is the per-Turn read the console shows it from (with the Procedure
  // the Turn's entry agent claimed to follow, `record_procedure_followed`).
  // -----------------------------------------------------------------------------------------
  {
    name: 'list_chat_turns',
    group: 'chat',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        chatId: id,
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.TurnAttributionWireSchema),
    description:
      'List a visible Chat’s Turns, newest first, each with its execution status, the Procedure ' +
      'its entry agent claimed to follow (agent-reported), and the requester’s objective outcome ' +
      '(null = unknown); keyset-paginated (limit, cursor → nextCursor).',
  },
  {
    name: 'mark_turn_outcome',
    group: 'chat',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ turnId: id, outcome: ObjectiveOutcomeSchema }).strict(),
    resultSchema: wire.TurnAttributionWireSchema,
    description:
      'Mark whether a finished Turn of your own achieved its goal (achieved / not_achieved). Only ' +
      'the person who sent the Turn’s message may mark it; they may correct it once afterwards ' +
      '(409 after that). Repeating the current value is a no-op. Independent of the Turn’s ' +
      'execution status.',
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
    // STATUS leftover 100 (2026-10-01, maintainer): `minRole: 'builder'`, the same bar as
    // `propose_ontology_change` — a published version is irreversible (status-lock trigger, no
    // unpublish) and changes the type namespace for the whole workspace. And only the draft's own
    // proposer may publish it (`publishOntologyDraft`'s `proposed_by` predicate): drafts are
    // visible to their proposer only (I16's read half), so nobody else could ever have reviewed
    // what they would be publishing.
    // R-60: a draft remembers the published version it was proposed against (its base); once the
    // family's published head has moved past it the publish refuses 409 `ontology_base_moved` —
    // every version is a full replacement, so publishing it would drop the newer version's types.
    // I-P1 (S10 P0): ObjectType / ActionType names are unique across a workspace's published
    // families — a same-named type in another family refuses 409 `ontology_namespace_conflict`
    // instead of one family silently overriding the other.
    name: 'publish_ontology_version',
    group: 'ontology',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z.object({ id: id, version: z.number().int().positive() }).strict(),
    resultSchema: wire.OntologyPublishResultWireSchema,
    description:
      'Publish your own draft OntologyVersion (I16). Human channel only; another principal’s draft reads as not found. A draft proposed against a published version that is no longer the family’s latest (someone published another version since) refuses 409 ontology_base_moved — propose the change again from the current version. An ObjectType or ActionType name another published ontology family already declares refuses 409 ontology_namespace_conflict (I-P1).',
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
      'Propose a private draft ontology change (I16); visible only to the proposer until published. change is the family’s complete new definition, not a delta; with id it is based on that family’s latest published version, and publishing it fails with ontology_base_moved if another version is published first.',
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
  {
    // Closing wave C5b (coverage gap G1 part 2 — the console-facing half of "review and publish an
    // agent's ontology proposal"): `publish_ontology_version` has existed since S3.1, but nothing
    // let a person find a draft's id/version to publish — `get_type`/`list_types` return the merged
    // *current-state* type view only (no id/version/proposedBy fields), scoped to published rows
    // plus only the caller's own drafts. Mirrors `list_worker_definitions`/`list_skills` (worker/
    // meta groups) exactly for visibility and channel — published rows + the caller's own drafts
    // (I16 read half), same `channel:'handle'`/`minRole:'member'` as those two siblings — rather
    // than inventing a new cross-principal visibility rule; `loadVisibleOntology` (the read path
    // `get_type`/`list_types`/`validate` already share) is untouched.
    name: 'list_ontology_versions',
    group: 'ontology',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({ limit: z.number().int().positive().optional(), cursor: z.string().optional() })
      .strict(),
    resultSchema: listEnvelope(wire.OntologyVersionListItemWireSchema),
    description:
      'List OntologyVersion drafts and published rows visible to the caller (published rows workspace-wide, plus the caller’s own drafts, I16); keyset-paginated (limit, cursor → nextCursor). Each item carries id/version/status/proposedBy/definition so a person can find a draft to review and publish; a draft also carries base — the published version of its own family it was proposed against, with that version’s definition (null: the family had nothing published) — so what the draft changes is the diff between the two.',
  },
];

// -------------------------------------------------------------------------------------------
// graph
// -------------------------------------------------------------------------------------------

/** One reached Object's own type and display name — `traverse` and `list_facts` return one per
 *  Object id they reference (`nodeDetails`), so a caller can name an endpoint without a
 *  `get_object` per id. `name` is the kernel's `objectDisplayName` heuristic, absent when nothing
 *  usable exists. */
const nodeDetailSchema = z
  .object({ id: z.string(), typeName: z.string(), name: z.string().optional() })
  .strict();

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
        // S8 W1-C (leftover 48): the store-level primitive (`substrate/graph/store.ts`
        // `TraverseDirection`) already supported `in`/`out`/`both` — only this wire layer never
        // exposed it. Default unchanged (`both`, `DEFAULT_TRAVERSE_DIRECTION`) — omitting the
        // param is exactly today's behavior.
        direction: z.enum(['in', 'out', 'both']).optional(),
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
        // S8 W1-C (leftover 48 "邻居名称 N × get_object"): one entry per `nodes[i]`, same order —
        // additive, `nodes`/`edges` unchanged, so an existing caller reading only those two fields
        // sees identical behavior. `name` is the same "name-like property, else identity key join"
        // heuristic the console's own `objectDisplayName` (packages/web/src/lib/graph-view.ts)
        // uses — `undefined` when nothing usable exists (the graph console already renders that as
        // the bare-id fallback).
        nodeDetails: z.array(nodeDetailSchema).optional(),
      })
      .strict(),
    description:
      'Walk Links outward from `fromId` in one `direction` (`in`/`out`/`both`, default `both`; ' +
      'or filtered to one `linkType`), up to `depth` hops (1–3, default 1). Returns `{nodes, ' +
      'edges, nodeDetails}`: the reached Object ids, each traversed Link (linkId, linkType, ' +
      'sourceObjectId, targetObjectId, depth), and each node’s own objectType/display name ' +
      '(nodeDetails, same order as nodes). Use it to see what an Object is connected to; use ' +
      '`get_object` for an Object’s own properties, `explain` for a Link’s provenance.',
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
    // Real-model round 4 (dependency_chat 0/10): "哪个服务依赖哪个" asks about one relationship
    // type across the whole graph. `traverse` needs a starting Object and `search` returns
    // Objects, so without this an agent could only answer from whatever Facts happened to be in
    // its injected context. Same graph-read rules as `traverse`: active Facts only, the caller's
    // viewer narrowing, keyset pagination per docs/wire-contract-conventions.md §3.
    name: 'list_facts',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        linkType: z.string().min(1),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.FactWireSchema).extend({
      nodeDetails: z.array(nodeDetailSchema),
    }),
    description:
      'List every currently-active Fact of one relationship type (`linkType`, e.g. `depends_on`, ' +
      '`runs_on`) across the whole workspace, newest first, with each endpoint Object’s ' +
      'objectType and display name in `nodeDetails`. Use it for questions about a relationship ' +
      'across the graph ("which service depends on which", "what runs where"); use `traverse` ' +
      'from one known Object instead. Keyset-paginated (limit up to 200, cursor → nextCursor): ' +
      'an answer that claims to be complete must follow `nextCursor` until it is absent. Empty ' +
      '`items` means the graph holds no such Fact — say so rather than guessing from Object ' +
      'properties. The link types that exist, with counts, are in `get_entry_context`’s ' +
      '`factCountsByLinkType`.',
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
    // S8 W4-A (ui-audit G1; STATUS leftover 70/62): real handler (`application/gateway/
    // graph-freshness-handler.ts`), a thin workspace-scoped restatement of `substrate/audit/
    // invariant-checks.ts`'s own `ops.collector_silent` sweep — see that handler's own doc
    // comment.
    name: 'graph_freshness',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: noParams,
    resultSchema: wire.GraphFreshnessWireSchema,
    description:
      'Per-Source observation freshness for this workspace — every Source owned by a service ' +
      'Principal (a collector, an external runtime), its newest observation, and whether that ' +
      'observation is older than the collector-silence threshold. Surfaces the same signal ' +
      '`ops.collector_silent` checks cross-workspace, scoped to the caller’s own workspace.',
  },
  {
    // Console audit P2 (browse the graph by relationship type): the relationship types that exist
    // and how many active Facts each has, without `get_entry_context`'s per-principal approvals
    // and Tasks — the console's entry point to `list_facts`.
    name: 'graph_overview',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: noParams,
    resultSchema: z.object({ factCountsByLinkType: factCountsByLinkTypeSchema }).strict(),
    description:
      'Every currently-active Fact counted per relationship type (`linkType`), ordered by ' +
      'linkType — the graph’s whole relationship shape, narrowed to what the caller may see. A ' +
      'link type that is not listed has no active Fact. Enumerate one with `list_facts`.',
  },
  {
    name: 'find_operations',
    group: 'graph',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ need: z.string() }).strict(),
    resultSchema: listEnvelope(wire.FindOperationItemWireSchema),
    description:
      'Find Operations whose name/description/kind (or Gatekeeper name) matches any keyword in ' +
      '`need` (space/punctuation-separated; a blank need lists every candidate), intersected with ' +
      'the caller’s Grant. For the entry agent each item carries `reachability`: `direct` (call ' +
      'its `<gate>.<op>` tool yourself), `via_worker` (delegate to a Worker find_workers returns), ' +
      'or `unreachable` with the first missing condition as `reason`.',
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
      'Find published WorkerDefinition@version whose name/description matches any keyword in ' +
      '`need` (space/punctuation-separated; a blank need lists every candidate).',
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
    description:
      'Find published Procedures whose name/description matches any keyword in `need` (space/' +
      'punctuation-separated; a blank need lists every candidate).',
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
    // D-08: calls a Gatekeeper and writes the observed Facts, Observations and an Activity.
    sideEffects: true,
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
    // D-08: same as observe_operation — writes the observed Facts and an Activity.
    sideEffects: true,
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
    // R-40 (maintainer decision D-19): refused (409 `connector_not_self_serve`) unless the platform
    // keeps the generic connector for `kind` in `self_serve` — an owner could never complete it.
    description:
      'Propose connecting a new system; produces a connection-request card for a human to fill in credentials. Refused (409 connector_not_self_serve) when the platform has not opened this kind for self-connection.',
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
    //   - `connectionSecret` (R-01, maintainer decision D-01): the gate's own secret from
    //     `mint_connection_secret`, already in the gate's `GATE_KERNEL_TOKEN_FILE` — the kernel
    //     never sends the platform gate token to an owner-supplied endpoint. Optional in the schema
    //     so a catalog address still gets its specific 400 `endpoint_is_platform_gate`; the handler
    //     requires it for everything else (400 `invalid_params`). Redacted from the audit row.
    //   `endpoint` and `manifestSource` are owner-supplied URLs the kernel fetches from inside the
    //   platform's networks: both must pass the outbound-target predicate (R-27,
    //   `outbound-target.ts`) — 400 `connection_target_refused` otherwise.
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
        connectionSecret: z.string().min(1).optional(),
        credentials: z.unknown().optional(),
        credentialKind: z.enum(['shared', 'connected_account']).optional(),
        onBehalfOf: id.optional(),
        manifestSource: z.string().optional(),
      })
      .strict(),
    resultSchema: wire.CreateConnectionResultWireSchema,
    description:
      'Register a Gatekeeper instance with address and credentials (credentials go straight to the gatekeeper, never persisted by the kernel); auto-imports a manifest draft for http/mcp. The endpoint must not be a platform-catalog gate instance (400 endpoint_is_platform_gate) — those are enabled with enable_gate_instance. Requires connectionSecret (from mint_connection_secret, already configured in the gate); endpoint and manifestSource must not point at platform services or networks (400 connection_target_refused). Refused (409 connector_not_self_serve) unless the platform keeps this kind’s connector in self-serve mode.',
    redactedParamKeys: ['credentials', 'connectionSecret'],
  },
  {
    // R-01 (maintainer decision D-01, 2026-10-02 review): a self-connected gate authenticates the
    // kernel with its own secret, never the platform gate token. This mints one for a gate about to
    // be connected — the gate needs it *before* `create_connection` first calls it, so it cannot be
    // minted by `create_connection` itself. Stores nothing (the secret carries its own non-secret
    // salt; `create_connection` records that salt); shown once — the result is never audited.
    // `mode: 'write'`: issuing a credential belongs in the default audit view, not with the reads.
    name: 'mint_connection_secret',
    group: 'connection',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({}).strict(),
    resultSchema: wire.MintConnectionSecretResultWireSchema,
    description:
      'Mint a connection secret for a gate about to be connected: put it in the gate’s GATE_KERNEL_TOKEN_FILE, then pass it to create_connection as connectionSecret. Shown once; nothing is stored until create_connection.',
  },
  {
    // R-01 / D-01: replaces a self-connected gate's secret — the old one stops working at once —
    // and is how a gate connected before per-connection secrets gets its first. 409 `conflict` for
    // a platform-catalog gate (it has no connection secret).
    name: 'rotate_connection_secret',
    group: 'connection',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ gatekeeperId: id }).strict(),
    resultSchema: wire.RotateConnectionSecretResultWireSchema,
    description:
      'Issue a new connection secret for a self-connected gate (the previous one stops working immediately); put it in the gate’s GATE_KERNEL_TOKEN_FILE. Shown once. 409 for a platform-catalog gate.',
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
  {
    // S6-A C26 (docs/console-completion-plan.md §5.6, §6; S2.13's own "known deviation", runbook
    // web-console.md 已知缺口 8): the `requested → cancelled` edge `CONNECTION_REQUEST_TRANSITIONS`
    // (transitions.ts) and migrations/governance/0005 have carried since S2.13, finally wired.
    // `mode: 'write'` — an immediate, audited, in-platform state change (docs/wire-contract-
    // conventions.md §1); the vocabulary guard reserves `propose` for `propose_*`/`request_*`
    // names. Ownership (own request; the workspace owner may cancel any) is the handler's check
    // (application/gateway/connection-handlers.ts). Audit: `connection.request_cancelled`.
    name: 'cancel_connection_request',
    group: 'connection',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ connectionRequestId: id }).strict(),
    resultSchema: wire.ConnectionRequestWireSchema,
    description:
      'Cancel a ConnectionRequest that is still `requested` (→ `cancelled`; any other status is 409 illegal_transition). The requester may cancel their own request; the workspace owner may cancel any. Audit: connection.request_cancelled.',
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
    // S8 W1-C (selector data source, F6 item 3): `q` — case-insensitive substring on `name` — for
    // the console's gate picker (grant/launcher flows, J6/SY2); omitted returns every Gatekeeper,
    // exactly today's behavior.
    paramsSchema: z.object({ q: z.string().min(1).optional() }).strict(),
    resultSchema: listEnvelope(wire.GatekeeperSummaryWireSchema),
    description:
      'List every registered Gatekeeper instance (health/manifest not included — see ' +
      'get_gatekeeper), optionally narrowed by q (case-insensitive substring on name).',
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
    // R-18 (D-18): `manifestDigest` is the `preview_gate_instance_enable` digest the owner looked
    // at; when given, the enable refuses `manifest_changed` if the manifest in effect moved since.
    paramsSchema: z
      .object({ gateId: z.string().min(1), manifestDigest: z.string().min(1).optional() })
      .strict(),
    resultSchema: wire.EnableGateInstanceResultWireSchema,
    description:
      'P-B1: enable a platform gate instance in this workspace — registers its Gatekeeper, imports and publishes its announced Operations (origin import), and links the workspace to the instance so trust and disabled Operations are read live. Idempotent per (workspace, gate). S8 W2-K2 (leftover 73): when an existing Gatekeeper in this workspace already has the same endpoint (a prior registration of the same gate process — e.g. the legacy register-gatekeeper CLI path), links it instead of registering a duplicate (result carries linkedExisting + drift); more than one match refuses 400 ambiguous_existing_gatekeeper rather than guess. L4-13: a single match already linked to a different gate instance refuses 409 gatekeeper_already_linked (one link per Gatekeeper). R-18: an optional manifestDigest (from preview_gate_instance_enable) makes it refuse 409 manifest_changed when the manifest in effect is no longer the previewed one.',
  },
  {
    // S8 W2-K2 (audit J3 "一键写入 ... 没有预览或确认"): the console ConfirmTier's read model for
    // the capability right above — same `scope`/`minRole`, `mode:'observe'` since it writes
    // nothing (gate-instance-handlers.ts's own doc comment has the full contract).
    name: 'preview_gate_instance_enable',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ gateId: z.string().min(1) }).strict(),
    resultSchema: wire.PreviewGateInstanceEnableResultWireSchema,
    description:
      'S8 W2-K2 (audit J3): read-only preview of what enable_gate_instance would do for this gate instance right now — whether it would link an existing Gatekeeper by endpoint (with any name/target/transportKind drift) or register a new one (or refuse as ambiguous_existing_gatekeeper, or 409 gatekeeper_already_linked when that Gatekeeper is already linked to another instance), and which announced Operations would be newly imported vs. are already published/deprecated (flagging drift from the announced manifest, audit CO2). Computed by the exact same lookup and manifest-parse functions enable_gate_instance uses; writes nothing.',
  },
  {
    // S8 W3-K1 (leftover 79, audit CO2): the write half of preview_gate_instance_enable's own
    // `differs` flag — owner-only (a governance-field change, unlike publish_operation/
    // deprecate_operation, which §9.3 names no role for) and `gatekeeperId`-scoped like
    // get_gatekeeper/list_operations right below, not gateId-scoped like the two capabilities
    // right above (this one targets an already-registered workspace Gatekeeper, not a platform
    // catalog entry).
    name: 'refresh_operation_governance',
    group: 'connection',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    // R-18 (D-18): `manifestDigest` (from `preview_gate_instance_enable`) binds the write to the
    // manifest the owner reviewed — required, so a re-announce between preview and confirm can
    // never apply values nobody saw.
    paramsSchema: z
      .object({
        gatekeeperId: id,
        operationNames: z.array(z.string().min(1)).optional(),
        manifestDigest: z.string().min(1),
      })
      .strict(),
    resultSchema: wire.RefreshOperationGovernanceResultWireSchema,
    description:
      'S8 W3-K1 (leftover 79, audit CO2): apply the gate’s currently-announced mode/blastRadius/autoApprovable to every selected, already-deployed Operation of this Gatekeeper whose fields disagree with it (in place — no new Operation version). operationNames narrows the selection; omitted refreshes every announced Operation. Refuses 400 no_announced_manifest when this Gatekeeper has no linked platform gate instance, and 409 manifest_changed when manifestDigest is not the digest of the manifest in effect (R-18: only the previewed values are ever applied). One AuditRecord per refreshed Operation with before/after and a loosened/tightened/mixed classification.',
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
    description:
      'One Gatekeeper instance with its Operations and a live health probe. A draft Operation ' +
      'is listed only to its proposer, a builder or the owner (D-26, I16).',
  },
  {
    name: 'list_operations',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    // S8 W1-C (selector data source, F6 item 3): `q` alongside the pre-existing `gatekeeperId`
    // filter — case-insensitive substring on `name`, for the Worker editor's Operation/gate picker
    // (J7) and any other Operation search; omitted returns every Operation, unchanged.
    paramsSchema: z
      .object({ gatekeeperId: id.optional(), q: z.string().min(1).optional() })
      .strict(),
    resultSchema: listEnvelope(wire.OperationSummaryWireSchema),
    description:
      'Human-facing Operation directory across Gatekeepers (any status), optionally filtered to ' +
      'one gate and/or narrowed by q (case-insensitive substring on name). A draft is listed ' +
      'only to its proposer, a builder or the owner (D-26, I16); published and deprecated ' +
      'Operations are listed to every member.',
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
    // links"). Distinct from the *connection flow*'s (S2.13) owner-scoped `publish_manifest`,
    // which publishes a whole newly-imported manifest at once (design doc §7.5 "owner 发布清单") —
    // this capability publishes one already-drafted Operation, the same granularity
    // `publish_skill` operates at.
    // D-24 (review 2026-10-02, the leftover 100 family): every meta-ontology `publish_*` /
    // `deprecate_*` is `minRole: 'builder'`, and only the row's proposer or the workspace owner may
    // act on it (kernel `governance/capability/publish-authority.ts`, checked on the locked row).
    name: 'publish_operation',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z.object({ gatekeeperId: id, name: z.string().min(1) }).strict(),
    resultSchema: wire.OperationPublishResultWireSchema,
    description:
      'Publish a draft Operation (I16). Builder floor; only the draft’s proposer or the workspace owner may publish it (403 not_proposer otherwise).',
  },
  {
    name: 'deprecate_operation',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder', // D-24 — see publish_operation above.
    paramsSchema: z.object({ gatekeeperId: id, name: z.string().min(1) }).strict(),
    resultSchema: wire.OperationDeprecateResultWireSchema,
    description:
      'Deprecate a published Operation. Builder floor; only its proposer or the workspace owner may deprecate it (403 not_proposer otherwise).',
  },
  {
    // S8 W3-K1 (leftover 81). `mode:'write'` (not `execute`, unlike publish/deprecate): an
    // immediate, audited in-platform change with no approval gate — editing documentation is not a
    // lifecycle transition. STATUS leftover 123: it still gets D-24's authority rule — an
    // Operation's description is injected into every agent's tool list, so editing it is a prompt
    // lever, not mere documentation. Builder floor; only the Operation's proposer or the workspace
    // owner may edit it (kernel `governance/capability/publish-authority.ts`).
    name: 'update_operation_description',
    group: 'meta',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z
      .object({
        gatekeeperId: id,
        name: z.string().min(1),
        description: z.string().min(1).max(2000),
      })
      .strict(),
    resultSchema: wire.UpdateOperationDescriptionResultWireSchema,
    description:
      'S8 W3-K1 (leftover 81): edit one Operation’s description in place (documentation only, not a governance field — no draft/publish step). Builder floor; only the Operation’s proposer or the workspace owner may edit it (403 not_proposer otherwise). description must be non-blank after trimming, at most 2000 characters. AuditRecord with before/after.',
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
    // D-24 — see publish_operation. The owner and builders see every draft (D-26 rule,
    // application/worker/draft-visibility.ts), so another builder's publish of someone else's
    // draft is 403 not_proposer, like a published version that is not the caller's; a draft the
    // caller cannot see is not found.
    name: 'publish_skill',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z.object({ skillId: id }).strict(),
    resultSchema: wire.SkillPublishResultWireSchema,
    description:
      'Publish your draft Skill (I16) — the latest version under skillId. Builder floor; the workspace owner may publish anyone’s draft (e.g. one a member’s Worker proposed); another builder’s draft is 403 not_proposer.',
  },
  {
    name: 'publish_procedure',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder', // D-24 — see publish_skill.
    paramsSchema: z.object({ procedureId: id }).strict(),
    resultSchema: wire.ProcedurePublishResultWireSchema,
    description:
      'Publish your draft Procedure (I16) — the latest version under procedureId. Builder floor; the workspace owner may publish anyone’s draft; another builder’s draft is 403 not_proposer.',
  },
  {
    name: 'deprecate_skill',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder', // D-24 — see publish_skill.
    paramsSchema: z.object({ skillId: id }).strict(),
    resultSchema: wire.SkillPublishResultWireSchema,
    description:
      'Deprecate a published Skill. Builder floor; only its proposer or the workspace owner may deprecate it (403 not_proposer otherwise).',
  },
  {
    name: 'deprecate_procedure',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder', // D-24 — see publish_skill.
    paramsSchema: z.object({ procedureId: id }).strict(),
    resultSchema: wire.ProcedurePublishResultWireSchema,
    description:
      'Deprecate a published Procedure. Builder floor; only its proposer or the workspace owner may deprecate it (403 not_proposer otherwise).',
  },
  {
    // S2.14 addition, same style as `list_worker_definitions` (worker group, below): observe,
    // handle channel, no minRole beyond authentication. Unlike `list_worker_definitions` ("List
    // published WorkerDefinitions" only), this also returns drafts the caller may see (I16 read-
    // privacy: a draft is visible to its proposer, and — D-26's reviewer rule — to the owner and
    // builders, so a member's Worker-proposed Skill can be reviewed and published; enforced by
    // `application/worker/skills.ts`'s `listSkills` query itself, not by this schema). On the
    // handle channel the caller is the Handle's obo with that principal's role.
    name: 'list_skills',
    group: 'meta',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    // S8 W1-C (leftover 48 pagination list): keyset-paginated, default/max match `search`
    // (docs/wire-contract-conventions.md §3) — see `application/worker/skills.ts`'s
    // `listSkills` own doc comment for the exact default chosen and why it is backward
    // compatible with today's no-`limit` callers.
    paramsSchema: z
      .object({ limit: z.number().int().positive().optional(), cursor: z.string().optional() })
      .strict(),
    resultSchema: listEnvelope(wire.SkillSummaryWireSchema),
    description:
      'List published Skills plus the draft Skills the caller may see — their own, or every ' +
      'draft for the owner and builders (D-26 rule, I16) — latest version per id, newest first, ' +
      'each with its proposedBy; keyset-paginated (limit, cursor → nextCursor).',
  },
  {
    // S8 W1-C (leftover 48 "list_skills 无 markdown / 无 get_skill" — Skill "编辑" needs the full
    // body to prefill; `list_skills` stays light on purpose, mirroring `list_operations`/
    // `get_gatekeeper`'s own summary-vs-detail split).
    name: 'get_skill',
    group: 'meta',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ skillId: id }).strict(),
    resultSchema: wire.SkillDetailWireSchema.nullable(),
    description:
      'Read one Skill (latest version) with its full markdown body — same read rule as ' +
      'list_skills (published, or a draft the caller may see); null for an unknown id or a ' +
      'draft the caller may not see.',
  },
  {
    name: 'list_procedures',
    group: 'meta',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    // S8 W1-C (leftover 48 pagination list): same shape as list_skills above.
    paramsSchema: z
      .object({ limit: z.number().int().positive().optional(), cursor: z.string().optional() })
      .strict(),
    resultSchema: listEnvelope(wire.ProcedureSummaryWireSchema),
    description:
      'List published Procedures plus the draft Procedures the caller may see — their own, or ' +
      'every draft for the owner and builders (D-26 rule, I16) — latest version per id, newest ' +
      'first, each with its proposedBy; keyset-paginated (limit, cursor → nextCursor).',
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
      'Assert a Fact; resulting epistemic_status depends on the caller’s principal kind (§5.5). linkType must be declared by the workspace’s published ontology and accept the two Objects’ types as domain -> range (I2), else 400 ontology_violation with the allowed signatures in details — see get_type / list_types.',
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
    description:
      'Supersede a Fact from the same Source with a newer value. Same identity (linkType, sourceObjectId, targetObjectId) as the Fact superseded, and the same published-ontology check as assert_fact (I2; 400 ontology_violation).',
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
      'Explain where a node came from. `nodeId` may be a Fact, Decision, or Activity id. Returns ' +
      'the producing Activity (kind, status, who started it and on whose behalf) with its ' +
      'Observations and their Sources — narrowed to just the Fact’s own Observation when it ' +
      'recorded one (e.g. `submit_observations`), otherwise every Observation the Activity ' +
      'recorded (a bulk collector run or an ad-hoc `assert_fact`/Worker result can mean hundreds ' +
      'of entries). For a Fact, `fact` also carries its two Objects (`sourceObjectId`, ' +
      '`targetObjectId`) and value (`properties`), and `fact.humanAttestations` lists every human attestation ' +
      '(kind `human_attestation`: a person’s own confirmation — who, when, note, link), which is ' +
      'a person’s word, not machine evidence.',
  },
  {
    name: 'record_decision',
    group: 'epistemic',
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    // R-62: Fact / Task ids are uuids, checked here — a stored non-uuid used to break every
    // `query_decisions` / `find_precedents` by objectId in the workspace (those reads now also
    // skip such values in rows written before this check).
    paramsSchema: z
      .object({
        summary: z.string(),
        relatedFactIds: z.array(z.string().uuid()).optional(),
        relatedTaskId: z.string().uuid().optional(),
      })
      .strict(),
    resultSchema: z.object({ id, status: z.string(), turnId: z.string() }).strict(),
    description:
      'Record a Decision the caller has made or is reporting: `summary` (what was decided and ' +
      'why), optional `relatedFactIds` (the ids of the Facts it rests on) and `relatedTaskId` — ' +
      'both uuids as returned by the graph and task tools, else 400 invalid_params. Automatically ' +
      'attributed to your own currently-running Turn — fails if none is running. Starts in ' +
      'status `proposed`; `explain`, `query_decisions`, and `find_precedents` can find it later. ' +
      'Not for routine observations — only for real choices worth tracing.',
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
        // S8 W1-C (leftover 48 "list_conflicts 无对象 / Fact 筛选"): narrows to Conflicts touching
        // one Object (either side's Fact starts or ends there) or naming one Fact directly
        // (factAId/factBId) — both optional, may be combined (AND), never required.
        objectId: id.optional(),
        factId: id.optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.ConflictWireSchema),
    description:
      'List Conflicts visible to the caller (private-Source Conflicts are one-sided, §5.6), ' +
      'optionally narrowed to one objectId (either side’s Fact touches it) or one factId ' +
      '(factAId/factBId); keyset-paginated (limit, cursor → nextCursor).',
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
    // just `{factId}` — Evidence is attached separately (a Worker result contract's `evidence[]`,
    // or a person's own `attest_fact` below); `verify_fact` only checks Evidence already exists
    // (I3.6) and promotes, it does not itself attach any.
    name: 'verify_fact',
    group: 'epistemic',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ factId: id }).strict(),
    resultSchema: wire.FactWireSchema,
    description:
      'Promote a Fact to epistemic_status=verified with Evidence (I3.6) — machine evidence or a human attestation (attest_fact) both count; a Fact with neither is refused (409).',
  },
  {
    // STATUS leftover 89 (maintainer decision 2026-09-27): a person attaches Evidence of the
    // reserved kind `human_attestation` (HUMAN_ATTESTATION_EVIDENCE_KIND) — who (the calling human
    // Principal, never a request field), when, a required note, an optional http(s) link.
    // Human-channel only (HUMAN_ONLY_CAPABILITY_NAMES below; `governance/capability/handles.ts`'s
    // `assertValidScope` keeps it out of every Handle scope) and the same `minRole` as
    // `verify_fact`, whose Evidence precondition it exists to satisfy. The handler additionally
    // refuses a non-human Principal (a service Principal's API key also reaches the human channel).
    name: 'attest_fact',
    group: 'epistemic',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        factId: id,
        note: z.string().trim().min(1).max(ATTEST_FACT_NOTE_MAX_LENGTH),
        link: z
          .string()
          .trim()
          .max(ATTEST_FACT_LINK_MAX_LENGTH)
          .regex(/^https?:\/\/\S+$/i, 'link must be an http(s) URL')
          .optional(),
      })
      .strict(),
    resultSchema: wire.HumanAttestationWireSchema,
    description:
      'Attach a human attestation to an active Fact: Evidence of kind "human_attestation" recorded as the calling person’s own confirmation (note required, optional http(s) link), under an epistemic.human_attestation Activity, audited. Shown apart from machine evidence by explain (fact.humanAttestations); counts as Evidence for verify_fact. Human channel only.',
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
        // second one, whatever its status. Omitted, a default is derived from (sid|principal,
        // gatekeeperId, operation, stable params hash) so an unmarked retry still collapses onto
        // the same row — but only while that row is in flight (2026-10-02 review R-53, D-12):
        // once it is terminal, an identical call is a new intent.
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
      'A Worker’s only execute-mode entry point onto a Gatekeeper; creates an ActionRequest. A Handle caller’s gates are re-checked at call time against what its member may act on now (Grants minus My Agent exclusions, capped by the AgentPolicy; an owner keeps the Handle’s gates minus the same exclusions) — a gate dropped since the Handle was minted is denied (R-37).',
  },
  {
    // S6-A C25 (docs/console-completion-plan.md §5.8 "确认态", §6, §12 item 6): `reason` is
    // symmetric with `reject`'s and *kernel-enforced* — `governance/approval/decide.ts` refuses
    // (400 `reason_required`) a `blastRadius === 'high'` ActionRequest approved without a
    // non-blank reason; low/medium keep it optional. Stored in the Approval Decision's rationale
    // and the `action_request.approve` audit row, read back as `decisionReason` on the wire row.
    name: 'approve',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ actionRequestId: id, reason: z.string().optional() }).strict(),
    resultSchema: wire.ActionRequestWireSchema,
    description:
      'Approve a pending ActionRequest (I14: the approver must hold the requested scope). `reason` is optional for low/medium blast radius and required (non-blank) for high — 400 reason_required otherwise; it is written to the decision rationale and the audit row and exposed as decisionReason.',
  },
  {
    name: 'reject',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ actionRequestId: id, reason: z.string().optional() }).strict(),
    resultSchema: wire.ActionRequestWireSchema,
    description:
      'Reject a pending ActionRequest. `reason` (optional) is written to the decision rationale and the audit row and exposed as decisionReason.',
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
    // R-42 (maintainer decision D-22): the same visibility as `list_action_requests` — one
    // predicate (`governance/approval/reads.ts`'s `getActionRequestVisibleTo`), so a single-row
    // read never shows more than the list. A row outside it answers 404, like an unknown id.
    description:
      'Read one ActionRequest the caller may see: the owner sees every row, anyone else only a row matching one of their own active grants (I14) or one they requested. Otherwise 404.',
  },
  {
    // S5.5 leftover 21 (docs/STATUS.md row 21, docs/development-tasks.md §5b S5.5 item 8): the
    // console's "审批历史" read — every ActionRequest regardless of status, unlike `list_pending`'s
    // hardcoded `pending_approval` filter. Same visibility as `get_action` (R-42, D-22 — one
    // predicate, `governance/approval/reads.ts`'s `listActionRequestsForApprover` doc comment): the
    // owner sees every row, any other role only rows matching one of their own active
    // `capability_grants` (I14, the match `list_pending` uses) plus the rows they requested
    // themselves — a row a caller may not see must not appear here even once it is no longer
    // pending.
    name: 'list_action_requests',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z
      .object({
        status: z.union([ActionRequestStatusSchema, z.array(ActionRequestStatusSchema)]).optional(),
        gatekeeperId: id.optional(),
        // S6-A C28 (docs/console-completion-plan.md §5.5, §6; runbook web-console.md 已知缺口 6):
        // the task detail's "关联审批" — every ActionRequest a Task's WorkerRuns raised, decided
        // ones included (`list_pending` could only reverse-look-up pending ones). `taskId` is
        // resolved by the handler to the Task's WorkerRun ids (`parent_worker_run_id`); an
        // unknown `taskId` matches nothing (empty page, not 404 — same as an unknown
        // `gatekeeperId`). Both given → intersection.
        taskId: id.optional(),
        parentWorkerRunId: id.optional(),
        // Same default/max as `search` (docs/wire-contract-conventions.md §3;
        // substrate/graph/store.ts `DEFAULT_SEARCH_LIMIT`/`MAX_SEARCH_LIMIT`).
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.ActionRequestWireSchema),
    description:
      'List ActionRequests regardless of status (the approval history), optionally filtered by ' +
      'status, gatekeeperId, taskId (every WorkerRun of that Task) or parentWorkerRunId; ' +
      'keyset-paginated (limit, cursor → nextCursor). Same visibility as get_action: the owner ' +
      'sees every row, anyone else rows matching one of their own active grants (I14) or that ' +
      'they requested. Decided rows carry decisionReason / decidedBy / decidedAt.',
  },
  {
    // Review 2026-10-02 R-20 / maintainer decision D-15: the rule is keyed by (gatekeeperId,
    // actionKindTag). It used to be the bare Operation name on every gate, but names collide
    // across gates and the approver only ever saw one.
    name: 'set_auto_approved_action_kind',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'operator',
    paramsSchema: z.object({ gatekeeperId: id, actionKindTag: z.string().min(1) }).strict(),
    resultSchema: wire.PolicyWireSchema,
    description:
      '"Always allow" — auto-approve this Gatekeeper’s published Operation `actionKindTag` from now on, for every requester (a gate-scoped Policy rule; the same name on other Gatekeepers is not affected). 404 for an Operation not published on that Gatekeeper; 400 for a high-blast-radius Operation, which is never auto-approved (I8).',
  },
  {
    // 2026-09-08 wire-contract-conventions §1(c): a Grant points at a resource (`resourceType` +
    // `resourceId`), not a "capability" — that word is reserved for the registry name of *this*
    // row's own `name` field (was `capability: 'gatekeeper'` with the id inside `scope`).
    // Review 2026-10-02 R-26 / maintainer decision D-14: only the per-gate grant —
    // `resourceType: 'gatekeeper'` with a required `resourceId` — is accepted, because it is the
    // only kind the console shows and revokes (systems/SystemAccessCard). A wildcard
    // (`resource_id` null) or a bare `action_kind` grant still confers I14 approver authority and
    // auto-approval-rule eligibility but has been invisible in the console since #312, so it can no
    // longer be created; such rows only exist historically and are still evaluated as before
    // (`governance/capability/grants.ts`'s `MATCHING_GRANT_WHERE`). No `scope` param: the stored
    // `capability_grants.scope` was never read by any authorization check, so accepting it offered
    // a narrowing that did not exist (leftover 80 — maintainer 2026-09-25: no per-Operation
    // narrowing; stop accepting the param). Historical rows still echo their stored `scope` back
    // in `CapabilityGrantWire`, shown as a note.
    name: 'grant_capability',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        principalId: id,
        resourceType: z.literal('gatekeeper'),
        resourceId: id,
      })
      .strict(),
    resultSchema: wire.CapabilityGrantWireSchema,
    description:
      'Grant a Principal access to one Gatekeeper: resourceType "gatekeeper" with that Gatekeeper’s id as resourceId (no wildcard, no other resource types).',
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
    description:
      'Write a Policy rule: policy = {gatekeeperId?, actionKindTag, blastRadius?, autoApprove, requesterCanApprove?}. With gatekeeperId the rule covers that Gatekeeper’s action kind; without it, the action kind on every Gatekeeper — such a workspace-wide rule can only require approval (autoApprove: true needs a gatekeeperId, R-20 / D-15). A gate rule wins over the workspace-wide one.',
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
      'the request, the entry-agent ceiling, and the caller’s own Grants narrowed by their My Agent ' +
      'exclusions and the AgentPolicy gate cap (the entry Handle’s gate set) — never wider than an ' +
      'entry Handle; execution through it is re-checked against that set at call time. The token ' +
      'is returned once and never stored in plaintext.',
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
    // S8 W1-C (leftover 48 pagination list): `limit`/`cursor` alongside the pre-existing
    // `principalId` filter; omitting `limit` keeps today's "every Grant" behavior up to the new
    // default (`governance/capability/grants.ts`'s `listGrants` own doc comment).
    paramsSchema: z
      .object({
        principalId: id.optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.CapabilityGrantWireSchema),
    description:
      'List CapabilityGrants, optionally filtered to one Principal; keyset-paginated (limit, ' +
      'cursor → nextCursor).',
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
  {
    // S8 W1-C (F6 item 3, "选择器数据源...能力名"): the grantable capability-name picker for the
    // Worker editor (J7) — derived from the registry itself (`WORKER_CEILING_CAPABILITIES`, the
    // same ceiling `application/task/handle-mint.ts`'s `computeChildHandleScope` narrows a
    // WorkerDefinition's own declared `capabilities` against), never a hand-maintained list that
    // could drift from what a WorkerDefinition may actually declare.
    name: 'list_capability_names',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: noParams,
    resultSchema: listEnvelope(z.object({ name: z.string(), mode: CapabilityModeSchema }).strict()),
    description:
      'List every capability name a published `kind=worker` WorkerDefinition may declare in its ' +
      'own `capabilities` (the worker ceiling minus the two gate-projection patterns, which are ' +
      'not literal registry names) — for the Worker editor’s capability picker.',
  },
  {
    // S8 W1-C (F6, ui-audit-2026-09-23 J1/O1): "can this member's entry agent delegate execution
    // work, and what is missing" — the one read the console's execution-readiness control tower
    // (J1) and Worker-launch flows (J2) both need, derived from the exact same enforcement path
    // `invoke_worker` uses (`application/task/handle-mint.ts`'s `computeChildHandleScope`) so this
    // can never disagree with what a real `invoke_worker` call would do — see
    // `application/gateway/execution-readiness-handler.ts`'s own module doc comment for the full
    // reuse mapping.
    name: 'execution_readiness',
    group: 'governance',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ principalId: id.optional() }).strict(),
    resultSchema: wire.ExecutionReadinessWireSchema,
    description:
      'Whether principalId’s (default: the caller’s own) entry agent can currently delegate ' +
      'execution work — every enabled Gatekeeper in this workspace with whether this principal ' +
      'holds a grant for it and how many published Operations it exposes; every published ' +
      '`kind=worker` WorkerDefinition with whether it is delegable by this principal right now, ' +
      'how many gates the delegated Worker would actually reach, and what blocks it when not; ' +
      '`ready` (some Worker is delegable and reaches at least one gate) and a `missing[]` rollup ' +
      'of machine codes (no_enabled_gate / no_grant / no_published_worker / no_worker_gate) with ' +
      'the ids involved. An operator+ ' +
      'may pass another member’s principalId (same visibility floor as list_grants); any other ' +
      'caller may only check their own.',
  },
];

// -------------------------------------------------------------------------------------------
// task — §9.3 row constrains this group to propose or observe (never execute). `get_entry_context`
// and `report_turn` are S1.6 additions, not named in §9.3's table: §7.4's mode table describes
// their behavior ("该用户的待审批、进行中 Task 及其结果、相关 Fact、先例…" injected via `context`;
// "每轮回传 Turn 与决策") without naming the capabilities. Assumption (see PR body "假设"): grouped
// under `task` rather than a new group, since both are per-Turn/Task-lifecycle facilities for the
// entry agent (bootstrap read / write-back), not graph reads (`graph`) or provenance queries
// (`epistemic`). `get_entry_context` derives the caller and workspace from the Handle; its one
// optional param, `turnId` (2026-10-02 review R-57, decision D-23), names the Turn the read serves.
// `report_turn`'s field names follow this file's established camelCase param convention (`turnId`,
// not the task brief's prose `turn_id`) for consistency with every other capability here.
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

/**
 * Upper bound (seconds) on `invoke_worker`'s phase 1 — creating the Task and spawning its Worker,
 * which waits on worker-supervisor's `/task/spawn`. The kernel's supervisor client gives up after
 * this long (`adapters/supervisor-client`'s `DEFAULT_SUPERVISOR_CLIENT_TIMEOUT_MS`; a kernel unit
 * test pins the two to the same value), and the Task then fails `spawn_failed`. A client's per-call
 * timeout for `invoke_worker` must cover this phase plus the `wait:true` window plus some headroom
 * (2026-10-02 review R-54): counting only the wait window, a slow spawn made
 * `@nexttime/platform-extension`'s `KernelClient` give up while the kernel was still starting the
 * Worker, and the model's retry started a second.
 */
export const INVOKE_WORKER_SPAWN_BUDGET_SECONDS = 30;

const taskCapabilities: readonly Capability[] = [
  {
    name: 'get_entry_context',
    group: 'task',
    mode: 'observe',
    // D-08: leases and acknowledges the Turn's pending context items (R-57 / D-23).
    sideEffects: true,
    channel: 'handle',
    minRole: 'member',
    // R-57 (D-23): never consumes. With `turnId`, the Turn's Chat's items are returned for every
    // call of that Turn until `report_turn` (a `write`) acknowledges them; without it, a peek. An
    // older entry runtime sends `{}` and is still valid (the kernel attributes it to the running
    // Turn — application/gateway/handlers.ts `getEntryContextHandler`).
    paramsSchema: z.object({ turnId: id.optional() }).strict(),
    resultSchema: z
      .object({
        // `application/linkage`'s own unacknowledged-item payloads — opaque per-kind JSON, not one
        // fixed shape (`EntryContextItems`, application/linkage/store.ts).
        pendingApprovals: z.array(jsonRecord),
        tasks: z.array(jsonRecord),
        // The most recently recorded active Facts (`DEFAULT_RECENT_FACTS_LIMIT`, newest first, `id`
        // breaking ties) — a recency sample, never chosen for the question at hand.
        facts: z.array(wire.FactWireSchema),
        // Every active Fact counted per `linkType` (ordered by `linkType`): the whole graph's
        // relationship shape, so an agent knows what `list_facts` can enumerate. Additive; an
        // entry runtime that predates it ignores it.
        factCountsByLinkType: factCountsByLinkTypeSchema,
        precedents: z.array(z.unknown()),
      })
      .strict(),
    description:
      'The calling principal’s current situation: pending approvals, running and recently ' +
      'finished Tasks with their results, the most recently recorded Facts (a recency sample ' +
      'with epistemic_status, not chosen for any question), active Fact counts per link type ' +
      '(the graph’s whole relationship shape — enumerate one with `list_facts`), and precedents. ' +
      'Entry agents receive this automatically before every model call; call it yourself only ' +
      'from an interactive session, which has no such injection. Reading never consumes ' +
      'anything: without `turnId` it covers every chat; with `turnId` only that Turn’s chat, ' +
      'and the same items come back for that Turn until `report_turn` acknowledges them.',
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
      'Record the outcome of a finished Turn (`turnId`, `summary`, optional `decisions`), and ' +
      'acknowledge the context items `get_entry_context` showed it. The entry runtime calls this ' +
      'once per Turn on its own; interactive sessions have no Turn to report.',
  },
  {
    // S10 E1 (docs/s10-evolution-plan-2026-10-04.md §3.2 `Turn followed ProcedureVersion`, §5.3):
    // the entry agent says which published Procedure version it is following this Turn — a claim
    // (agent-reported), hung on the running Turn the same way `record_decision` attributes a
    // Decision. A separate capability, not a `report_turn` param: the entry runtime, not the
    // model, calls `report_turn`, so the model has no way to hand it a Procedure.
    name: 'record_procedure_followed',
    group: 'task',
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ procedureId: id, version: z.number().int().positive() }).strict(),
    resultSchema: wire.ProcedureClaimWireSchema,
    description:
      'Record that this Turn follows a published Procedure (procedureId@version from ' +
      'find_procedures). Call it once, when you start following the Procedure; the first ' +
      'Procedure recorded for a Turn stands and a later call returns it unchanged. Stored as your ' +
      'own claim and shown to people as agent-reported.',
  },
  {
    // S10 E1 (§3.4, maintainer decision 7): a Procedure's `verify` step reports whether a Task it
    // delegated achieved its goal. Entry ceiling only — a Worker never grades its own Task — and
    // only for a Task acting for the caller's own principal.
    name: 'report_task_outcome',
    group: 'task',
    mode: 'write',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ taskId: id, outcome: ObjectiveOutcomeSchema }).strict(),
    resultSchema: wire.ObjectiveOutcomeWireSchema,
    description:
      'Report, from a Procedure’s verify step, whether a finished Task you delegated achieved its ' +
      'goal (achieved / not_achieved) — separate from its execution status. You may correct it ' +
      'once; repeating the current value is a no-op.',
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
        // 2026-10-02 review R-54 (decision D-12), the same two kinds `request_action` uses: an
        // explicit key is scoped to (on_behalf_of, sid) by the handler and returns the Task first
        // created with it, whatever its status — and a fresh one is a per-call nonce that starts a
        // new Task even while an identical one is running. Omitted, a default is derived from
        // (sid|principal, definition@version, hash of input and gates), so a retry after a client
        // timeout returns the Task already running instead of starting a second Worker — but only
        // while that Task is not yet terminal; after it is, an identical call starts a new Task.
        idempotencyKey: z.string().min(1).optional(),
      })
      .strict(),
    resultSchema: wire.InvokeWorkerResultWireSchema,
    description:
      'Create a Task from a published WorkerDefinition (`definition@version`) with `input`, spawn ' +
      'a Worker for it, and return `{taskId, status}`. With `wait` omitted or false the call ' +
      'returns as soon as the Task exists; with `wait: true` it holds for up to `timeout` ' +
      'seconds (90 at most) and returns the terminal result if the Worker finishes in time, ' +
      'otherwise the same `{taskId, status}`. `gates` narrows the Worker’s Handle to those ' +
      'Gatekeepers (it can only narrow, never widen) — each entry is a Gatekeeper id; a ' +
      'Gatekeeper’s name is also accepted when it names exactly one Gatekeeper this ' +
      'WorkerDefinition declares (ambiguous or unknown names are rejected with the declared ' +
      'ids/names listed). An identical call (same definition, version, `input` and `gates`) ' +
      'made while an earlier one is still unfinished returns that earlier Task instead of ' +
      'starting a second Worker; once it has finished, an identical call starts a new one. To ' +
      'run a second identical Worker alongside the first, pass a fresh `idempotencyKey`; a ' +
      'repeat with the same key returns the Task it first created. The outcome — completion, ' +
      'failure, or an approval that landed — is delivered later: entry agents receive it in a later turn’s ' +
      'context; other callers read it with `get_task`. The Worker acts on behalf of the calling ' +
      'principal.',
  },
  {
    name: 'get_task',
    group: 'task',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ taskId: id }).strict(),
    resultSchema: wire.TaskWireSchema,
    // D-21 (review 2026-10-02, L2-11): kernel `taskVisibleTo` (application/task/service.ts).
    description:
      'Read one Task and its WorkerRuns. Visible to the workspace owner, the principal the Task ' +
      'acts for, and the Task’s own WorkerRun Handle; for anyone else it is not found, exactly ' +
      'like an unknown id.',
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
    // S8 W1-C (leftover 48 pagination list): keyset-paginated on (created_at, id); omitting
    // `limit` keeps today's "every Task" behavior up to the new default (see
    // `application/task/service.ts`'s `listTasksForPrincipal` doc comment for the chosen value).
    paramsSchema: z
      .object({ limit: z.number().int().positive().optional(), cursor: z.string().optional() })
      .strict(),
    resultSchema: listEnvelope(wire.TaskWireSchema),
    description:
      "List the caller's own Tasks (newest first), each with its WorkerRuns; keyset-paginated " +
      '(limit, cursor → nextCursor).',
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
    // D-24 (review 2026-10-02) — see publish_operation (meta group) for the rule.
    name: 'publish_worker_definition',
    group: 'worker',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z.object({ definitionId: id, version: z.number().int().positive() }).strict(),
    resultSchema: wire.WorkerDefinitionWireSchema,
    description:
      'Publish your draft WorkerDefinition version (I12: immutable once published). Builder floor; the workspace owner may publish anyone’s draft, anyone else’s draft reads as not found.',
  },
  {
    name: 'deprecate_worker_definition',
    group: 'worker',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder', // D-24 — see publish_worker_definition.
    paramsSchema: z.object({ definitionId: id, version: z.number().int().positive() }).strict(),
    resultSchema: wire.WorkerDefinitionWireSchema,
    description:
      'Deprecate a published WorkerDefinition version. Builder floor; only its proposer or the workspace owner may deprecate it (403 not_proposer otherwise).',
  },
  {
    // S8 W3 K2 (leftover 82; ontology_version added by leftover 99): drafts of
    // WorkerDefinition/Skill/Procedure/OntologyVersion had `draft -> published`
    // as their only exit (I16 "提议者私有" — nobody else can even see it, so no owner-override
    // exists either). Human-channel-only, no `minRole` — I16's channel split and the "own draft
    // only" predicate are the gate (D-24 raised publish_*/deprecate_* to `builder`; discarding
    // one's own draft was left as is). Deletes the row outright (never a fourth
    // `PublishableStatus`); a published/deprecated version is never reachable through this
    // (`application/worker/draft-lifecycle.ts`'s own `DraftNotDiscardableError`). The kernel also
    // runs a periodic sweep that discards drafts past a staleness threshold, attributed to a
    // platform service Principal — not a capability a caller invokes.
    name: 'discard_draft',
    group: 'worker',
    mode: 'execute',
    channel: 'human',
    paramsSchema: z
      .object({
        kind: DraftKindSchema,
        id: id,
        version: z.number().int().positive(),
        // S10 E1 (§5.3 "草稿被丢弃时记录原因"): optional, free text — kept in this call's AuditRecord
        // as a signal for the evolution loop (why a proposal was not wanted).
        reason: z.string().max(500).optional(),
      })
      .strict(),
    resultSchema: wire.DiscardDraftResultWireSchema,
    description:
      'Discard one of your own private draft WorkerDefinition/Skill/Procedure/OntologyVersion versions (I16), with an optional reason (kept in the audit record). Only the draft’s own proposer may discard it; a published or deprecated version is never deletable through this.',
  },
  {
    name: 'list_worker_definitions',
    group: 'worker',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    // S8 W1-C (leftover 48 pagination list): `limit`/`cursor` alongside the pre-existing `kind`
    // filter — keyset-paginated, newest first; omitting `limit` keeps today's "every published
    // WorkerDefinition" behavior up to the new default (`application/worker/definitions.ts`'s
    // `listWorkerDefinitions` own doc comment).
    // S8 W2-U2b (audit R6 "草稿保存后找不回", the same read-privacy shape `list_skills` already
    // has): `includeOwnDrafts` defaults to false, reproducing today's "published only" result
    // byte-for-byte — when true, additionally includes the caller's own `draft` rows (never
    // another principal's, `application/worker/definitions.ts`'s `listWorkerDefinitionsPage` own
    // doc comment). Each row already carries `status` (`wire.WorkerDefinitionWireSchema`), so a
    // client can tell a draft row apart from a published one.
    paramsSchema: z
      .object({
        kind: z.enum(['entry', 'worker']).optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
        includeOwnDrafts: z.boolean().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.WorkerDefinitionWireSchema),
    description:
      'List published WorkerDefinitions, optionally filtered by kind; keyset-paginated (limit, ' +
      'cursor → nextCursor). With includeOwnDrafts, also includes the caller’s own draft ' +
      'WorkerDefinitions.',
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
    resultSchema: wire.RegisterSourceResultWireSchema,
    description:
      'Register a Source (document/DB/API/person/agent session). Idempotent on (kind, name): registering a name you already own with the same visibility returns the existing Source with created: false; a name held by another owner, or registered with the other visibility, is 409 source_identity_conflict.',
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
        observations: z.array(ingestObservationSchema),
        /** S5.2 observation window: "this submission is this Source's complete view of these ObjectTypes (within this Activity)". Every still-active Fact of this Source that starts at an Object of one of these types and was not re-observed in this Activity is invalidated with reason `not_reobserved`. Declare it on the last submission of a run, only after every collection step succeeded. */
        window: z
          .object({
            complete: z.literal(true),
            objectTypes: z.array(z.string().min(1)).min(1).max(100),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        // A submission with nothing to say is only meaningful as a window close — the way a run
        // whose last phase produced no items still declares its complete view.
        if (value.observations.length === 0 && value.window === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['observations'],
            message: 'observations must not be empty unless a window is declared',
          });
        }
      }),
    resultSchema: wire.SubmitObservationsResultWireSchema,
    description:
      'Submit a batch of Observations from one Activity (collectors, §7.8). Every objectType must be declared by the published ontology with its identityKey fields present; every link’s linkType must be declared and accept source -> target (I2) — a violation fails the whole batch with 400 ontology_violation (or is written and audited when the workspace’s ontology enforcement is warn). Re-observing an unchanged Fact advances its lastObservedAt; `window: {complete: true, objectTypes}` declares this submission the Source’s complete view of those ObjectTypes within the Activity and invalidates (not_reobserved) every Fact of this Source starting at such an Object that the Activity did not re-observe — pass it on a run’s last submission (observations may then be empty).',
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
    // S6-A (docs/console-completion-plan.md §5.5 "`audit_query` 加 keyset 分页（与平台审计页一致）"):
    // top-level `limit` / `cursor`, the same shape `platform_audit_query` and
    // `list_action_requests` use; `filter` keeps its pre-existing opaque record
    // (`actorPrincipalId` / `action` / `resourceType` / `resourceId`, plus a legacy `limit` that
    // still works when the top-level one is absent). Page order and cursor are
    // `(date_trunc('milliseconds', created_at), id)` — substrate/audit/writer.ts's own doc comment.
    paramsSchema: z
      .object({
        filter: jsonRecord.optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().min(1).optional(),
      })
      .strict(),
    // S3.7 wire fix (see PR body): previously a bare `AuditRecordRow[]` — §3 "不返回裸数组". This
    // name does not match `list_*`/`find_*` either, same reasoning as `search` (graph group)
    // above — fixed anyway.
    resultSchema: listEnvelope(wire.AuditRecordWireSchema),
    description:
      'Query this workspace’s AuditRecords newest first, narrowed by filter {actorPrincipalId?, action?, resourceType?, resourceId?}; keyset-paginated (limit — default 100, max 1000, truncated: true when clamped — and cursor → nextCursor).',
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
    // S6-A C27 (docs/console-completion-plan.md §5.5, §6 "只导出当前筛选范围"): `nodeId` — the same
    // untyped id `explain{nodeId}` takes (Fact, Decision or Activity, resolved the same way) — so
    // the audit page can export exactly the explain view it is showing without first knowing which
    // of the three the id is. Counts as one of the "exactly one root" alternatives.
    name: 'export_prov',
    group: 'audit',
    mode: 'observe',
    channel: 'human',
    minRole: 'auditor',
    paramsSchema: z
      .object({
        nodeId: id.optional(),
        factId: id.optional(),
        decisionId: id.optional(),
        activityId: id.optional(),
        depth: z.number().int().min(1).max(5).optional(),
      })
      .strict(),
    resultSchema: wire.ExportProvResultSchema,
    description:
      'Export a PROV-JSON-style provenance graph around one root — exactly one of nodeId (any of the three, resolved like explain), factId, decisionId or activityId — built from explain(); depth (1-5) bounds the causal walk for a Fact/Decision root.',
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
    // S8 W1-C (selector data source, F6 item 3 + leftover 48 pagination list): `q`
    // (case-insensitive substring on displayName) for the console's member picker (grant flows,
    // J6/SY2); `limit`/`cursor` keyset pagination — omitting `limit` keeps today's "every
    // Principal" behavior up to the new default (`application/gateway/members-handlers.ts`'s
    // `listPrincipalsDetailed` own doc comment).
    paramsSchema: z
      .object({
        q: z.string().min(1).optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.PrincipalWireSchema),
    description:
      'List every Principal in the workspace (kind/role/hasApiKey/disabledAt — never the key ' +
      'hash), optionally narrowed by q (case-insensitive substring on displayName); ' +
      'keyset-paginated (limit, cursor → nextCursor).',
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
      'Change a human or service Principal’s role. Refuses to demote the workspace’s last active human owner (a service owner never counts) and refuses an agent or internal Principal.',
  },
  {
    name: 'rotate_api_key',
    group: 'members',
    // minRole:'member' is the registry-level floor only (a service principal may rotate its own
    // key); the handler additionally enforces "owner, or the caller’s own principalId", and
    // refuses a human target (D-25) — the same "minRole gates entry, the handler narrows
    // further" shape `set_auto_approved_action_kind` already established
    // (packages/shared/src/capabilities.ts governance group, above).
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ principalId: id }).strict(),
    resultSchema: wire.RotateApiKeyResultWireSchema,
    description:
      'Rotate a service Principal’s API key — the old key stops working immediately; the new plaintext key is returned once. A person’s membership is never issued a key (409 conflict): people sign in with a password, and personal automation uses a service Principal or an MCP Handle.',
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
      'Disable a human or service Principal: its API key and every Handle issued on its behalf stop working immediately. Refuses the workspace’s last active human owner, an agent or internal Principal, and disabling oneself.',
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
    // S8 W1-C (leftover 48 "无批量 Object 读"; ui-audit-2026-09-23 J8/S10/O1 — RefChip degrades to
    // the bare-id fallback whenever an id is not already in a loaded `list_*` directory,
    // `packages/web/src/components/ui/RefChip.tsx`'s own doc comment "principle 3: id 永不裸露").
    // Covers exactly RefChip's five existing `RefKind`s (`object`/`principal`/`gatekeeper`/
    // `workerDefinition`/`actionRequest`) — the console's own list-loaded directories
    // (`list_principals`/`list_gatekeepers`/`list_worker_definitions`) already cover the common
    // case; this fills the gap for an id referenced from data the caller did not already load in
    // full (an audit row's actor, a Conflict's Fact, a traversal neighbour outside the loaded
    // page, …).
    //
    // Group placement: `members`, not `graph` — despite reading graph Objects among other things
    // — because `governance/capability/handles.ts`'s `buildEntryCeilingCapabilityNames` sweeps
    // every `group:'graph'` capability into the entry-agent Handle ceiling unconditionally
    // (correct for every other row in that group, all `channel:'handle'`); a `channel:'human'`
    // row there breaks `entryScope()`'s own `assertValidScope` round trip (a Handle scope can
    // never legally name a human-channel capability — confirmed by `handles.test.ts`'s own
    // registry-wide round-trip test). `members` already frames itself as the catch-all for a
    // workspace-summary/reference read with no other natural home (this file's own `members`
    // group doc comment, `get_workspace`/`list_models`) — the same reasoning applies here.
    name: 'resolve_refs',
    group: 'members',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ ids: z.array(id).min(1).max(200) }).strict(),
    resultSchema: listEnvelope(wire.ResolvedRefWireSchema),
    description:
      'Batch-resolve up to 200 ids to {id, kind, name?, typeName?} across the reference kinds ' +
      'the console renders as RefChips (graph Object incl. Gatekeeper and Operation, Principal, ' +
      'WorkerDefinition, ActionRequest, Task, Chat, Workspace) — one bounded query per kind, ' +
      'never per id. An id that does not exist, or that the caller may not see, is silently ' +
      'omitted (never 404, never leaks existence across visibility, same rule get_object already ' +
      'follows for a single id). Workspace resolves only the caller’s own workspace unless the ' +
      'caller is a platform administrator (console-session login).',
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
      'Read one Principal’s AgentProfile — raw fields (scalars: null = inherit; lists: what the member excluded) plus the resolved `effective` values: everything currently granted / published minus the exclusions, capped by the workspace AgentPolicy. Omit principalId for the caller’s own; naming another principal requires owner.',
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
        // unchanged). The scalars are `nullable` (an explicit `null` resets that field to "inherit
        // the workspace AgentPolicy default") — distinguishable because zod leaves an omitted key
        // as `undefined` while a present-but-null key parses to `null`. The three lists are
        // exclusion lists (console redesign D1): `[]` excludes nothing, so later grants / publishes
        // flow in automatically.
        model: z.string().min(1).nullable().optional(),
        excludedSkills: z.array(z.string().min(1)).optional(),
        excludedGatekeepers: z.array(id).optional(),
        excludedWorkerDefinitions: z.array(id).optional(),
        promptAddendum: z.string().nullable().optional(),
        autoApproveLow: z.boolean().nullable().optional(),
      })
      .strict(),
    resultSchema: wire.AgentProfileWireSchema,
    description:
      'Update one Principal’s AgentProfile (never widens past the principal’s own Grants or the workspace AgentPolicy — the Skill / Gatekeeper / Worker lists are exclusion lists and can only narrow; 400 invalid_params on a model outside the whitelist, an addendum over the policy’s length cap, or auto-approve-low when the policy forbids it; autoApproveLow false narrows, null and true follow the policy). A member may edit only their own profile, and only when AgentPolicy.memberCanEditProfile is true; an owner may edit anyone’s. Immediate and audited; revokes the target principal’s entry-session Handles so the next turn re-mints under the new scope.',
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
      'Update the workspace’s AgentPolicy — a partial update, omitted fields are left unchanged. Owner only. allowMemberAutoApproveLow (default true) is enforced: false turns off low-blast-radius auto-approval for every requester, whatever their AgentProfile says (D-16).',
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
      'The administrator landing page in one read: kernel version and applied migrations, user / workspace / gatekeeper counts (plus cross-workspace pending-approval and running-Task counts, and graph freshness — S8 W4-C), a service-health summary, the first-run checklist (live state of each page, never a wizard), and the most recent platform audit rows.',
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
        /** S6 A6: only users awaiting activation (`hasPassword: false`) — the "清理待激活用户"
         *  batch entry lists these and hands the selection to `purge_user`. */
        pendingOnly: z.boolean().optional(),
        /** S6 A6: hide *residual* users — awaiting activation (`hasPassword: false`), holding at
         *  least one membership Principal, and with **no non-disabled membership in an active
         *  `standard` workspace**: every live membership is in a disabled or an `ephemeral`
         *  workspace, or every membership was removed. Acceptance-run residue that
         *  `purge_workspace` removes with the workspace (§4 edge (b)) or `purge_user` takes.
         *  Omitted = shown, as before. The "清理待激活用户" entry lists with `pendingOnly` instead
         *  (`hideResidual` hides exactly the users `purge_user` can take). */
        hideResidual: z.boolean().optional(),
        ...platformCursorParams,
      })
      .strict(),
    resultSchema: listEnvelope(wire.UserWireSchema),
    description:
      'The platform user directory with each user’s memberships. `hasPassword: false` marks a user awaiting activation (backfilled from a pre-S4.1 Principal, or created without a password). No filter lists everyone; `pendingOnly` keeps only users awaiting activation, `hideResidual` drops the awaiting-activation users who hold a membership but none that is non-disabled in an active standard workspace (the users page’s default view).',
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
      'Disable or re-enable a user. Disabling revokes every console session, every session and Handle of the user’s Principals and any API key on them immediately; the row, its memberships and its conversations are kept (audit only grows). The last active administrator cannot be disabled, nor can a workspace’s last active human owner (409 last_owner).',
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
      'Set a temporary password (returned exactly once, must be changed on first login) and clear any login lock. Also the activation path for a user without a password. Revokes every credential the user holds: console sessions, the sessions and Handles of every membership (an issue_handle MCP Handle included) and any API key on a membership.',
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
      'Remove a user from a workspace: disables the membership Principal and revokes its sessions, their Handles and any API key on it. The Principal row stays for audit lineage. Refused for the workspace’s last active owner (409 last_owner).',
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
        // `defaultEntryModel` is deliberately absent — `set_platform_default_model` is its only
        // writer (validated against `list_platform_models`, S7-E E5), the same "not the generic
        // patch" treatment E1 gives `activeRuntimeImage` (wire/platform.ts's own comment).
        defaultDailyCallLimit: z.number().int().nonnegative().nullable().optional(),
        defaultMonthlyTokenBudget: z.number().int().nonnegative().nullable().optional(),
        defaultPlatformRole: wire.PlatformRoleWireSchema.optional(),
        passwordMinLength: z.number().int().min(8).max(128).optional(),
      })
      .strict(),
    resultSchema: wire.PlatformSettingsWireSchema,
    description:
      'Partial update of the platform settings — omitted fields are left unchanged. Every write is audited and bumps `version`; the previous row is kept for rollback. `defaultEntryModel` is not settable here — use `set_platform_default_model`.',
  },
  {
    name: 'set_platform_default_model',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ model: z.string().min(1).nullable() }).strict(),
    resultSchema: wire.PlatformSettingsWireSchema,
    description:
      'Sets the platform’s default entry model (design §6.2) — what `create_workspace` (when its caller omits `entryModel`) and the bootstrap default workspace take. Must be one of `list_platform_models`’ models; `null` = pi’s own default. Audited and bumps `version`, same as `update_platform_settings`.',
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
    paramsSchema: z
      .object({
        status: wire.WorkspaceStatusWireSchema.optional(),
        /** S6 A1: `standard` or `ephemeral` only. */
        purpose: wire.WorkspacePurposeWireSchema.optional(),
        /** S6 A1: `false` drops ephemeral workspaces whose `expiresAt` has passed (they are
         *  purgeable and only clutter the page). Omitted or `true` = included, as before. */
        includeExpired: z.boolean().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.PlatformWorkspaceWireSchema),
    description:
      'Every workspace with its status, entry model, allowed-model list, owners, active member count, purpose / expiry / disabled-at and whether it is purgeable right now, oldest first. No filter lists everything (disabled and expired included); `status` / `purpose` narrow, `includeExpired: false` hides expired ephemeral workspaces — the workspaces page’s default view is `{status: "active", includeExpired: false}`.',
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
        /** S5.1: what a Link write the published ontology does not license does. Omitted → the kernel's `ONTOLOGY_ENFORCEMENT` default (`reject`). */
        ontologyEnforcement: wire.OntologyEnforcementWireSchema.optional(),
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
        /** S5.1: `reject` (a Link write the published ontology does not license fails with 400 ontology_violation) or `warn` (written, audited, counted by invariant I-S5-1 — the rollout mode). */
        ontologyEnforcement: wire.OntologyEnforcementWireSchema.optional(),
      })
      .strict(),
    resultSchema: wire.PlatformWorkspaceWireSchema,
    description:
      'Rename a workspace, set its entry model — the model every member’s entry agent uses until they pick their own in 我的智能体 (takes effect on containers started afterwards) — and/or set its ontology enforcement (reject / warn) for Link writes the published ontology does not license.',
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
  },
  // S6 A1 / A6 (docs/console-completion-plan.md §4 "Workspace 生命周期", §5.2, §6, §7): the purge
  // plane. Governed, administrator-only, two-step on the console, platform audit kept
  // (`platform.workspace_purged` / `platform.user_purged` carry what was removed). The cascade
  // itself runs on the kernel's bootstrap (superuser) path after the platform transaction commits
  // — the application role never gains DELETE on audit rows or workspaces (audit only grows).
  {
    name: 'purge_workspace',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        workspaceId: z.string().min(1),
        /** Omitted / `false`: preview only — counts, warnings and the users that would go, nothing
         *  deleted. `true`: execute. The console shows the preview, then sends `true`. */
        confirm: z.boolean().optional(),
      })
      .strict(),
    resultSchema: wire.PurgeWorkspaceResultWireSchema,
    description:
      'Purge a workspace — the terminal state after disable: revoke and delete every CapabilityHandle, then Tasks, Chats / Turns / Activities / Decisions / Conflicts / Facts / Objects / Sources / Observations / Evidence, the workspace’s own audit rows, its Principals and the row itself, in one transaction; users whose memberships were all here and who never activated go with it. Accepted only for a workspace disabled ≥ 7 days (or disabled before migration 0030) or an ephemeral workspace past its expiry (409 workspace_active / retention_not_elapsed); never the platform default (409 default_workspace). Without `confirm: true` it is a dry run. A `service_handle_in_use` warning names each service Principal (collector, external runtime) whose Handle a process may still be using. The platform audit row `platform.workspace_purged` records the counts; host-side task / principal directories are listed for scripts/delete-workspace.sh.',
  },
  {
    name: 'purge_user',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ userIds: z.array(platformUserId).min(1).max(200) }).strict(),
    resultSchema: wire.PurgeUsersResultWireSchema,
    description:
      'Delete users awaiting activation that hold no active membership — the leftovers after their workspaces were purged or their memberships removed. Batch: each id gets its own outcome (`purged`, or `skipped` with a reason: a password, a console login, a platform administrator, a non-disabled membership, or an audit / settings reference); a skipped user never fails the call. Disabled membership Principals are detached (their `userId` cleared, rows kept for audit lineage). One `platform.user_purged` audit row per purged user.',
  },
  // P-B1 (docs/platform-admin-design.md §6.3 集成; development-tasks P-B "拆分与决定"): connectors,
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
      'Set a connector’s mode (disabled / self-serve / platform preset) and/or the Operations it may never run. The mode governs catalog visibility and new connections only (create_connection / request_connection need self-serve, enable_gate_instance needs platform preset); it never tears down existing workspace links. A disabled Operation is refused on its next call everywhere — that is the cut-off for links that already exist.',
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
    // R-18 (decision D-18): an enabled / disabled gate's re-announced manifest that changes its
    // Operation set or a reviewed field is held as `pendingManifest`; this adopts exactly the
    // version the administrator looked at (its digest), never a later one.
    name: 'confirm_gate_manifest',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ gateId: z.string().min(1), digest: z.string().min(1) }).strict(),
    resultSchema: wire.GateInstanceWireSchema,
    description:
      'R-18: adopt a gate instance’s pending announced manifest (pendingManifest) as the manifest in effect — what later workspace enables import and refresh_operation_governance aligns to. digest must be the pending manifest’s own digest: a newer announce replaces it, so a stale digest refuses 409 manifest_changed; nothing pending refuses 409 no_pending_manifest. Platform AuditRecord with the added / removed / changed Operations.',
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
    // D-08: records the probe's health on the gate instance.
    sideEffects: true,
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
      'Every live session held by a `service` Principal, and every MCP session a member opened with `issue_handle`, across workspaces — external runtimes such as Claude Code, a local pi over /mcp, or a collector — for inventory and revocation.',
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
      'Revoke one external runtime’s session — a service Principal’s, or a member’s MCP session — and every Handle issued under it, immediately.',
  },
  // S6-B (docs/console-completion-plan.md §5.4 / §6; docs/platform-admin-design.md §6.2): the
  // console's only kernel-side piece of provider management. The provider records live in
  // llm-proxy (web → caddy `/api/llm-admin/*` → llm-proxy admin endpoints); the kernel signs a
  // short-lived capability token and audits the issuance — it never sees a provider key.
  {
    name: 'issue_llm_admin_token',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: wire.LlmAdminTokenWireSchema,
    description:
      'S6-B: a 5-minute platform JWT (signed with the Handle key, distinct typ / aud — never accepted as a Handle) that lets the administrator’s browser call llm-proxy’s provider-management endpoints via caddy `/api/llm-admin/*`. Audited as `platform.llm_admin_token_issued` with the token’s `jti`; llm-proxy’s own audit lines carry the same `jti`. The token carries no provider key and the kernel stores none.',
  },
  // S8 W4-C (journey ⑤ 清理验收残留): a cross-workspace **count** of draft WorkerDefinition/Skill/
  // Procedure rows — never their content (I16 keeps a draft visible only to its own proposer).
  // Handler in application/gateway/platform-residue-handler.ts.
  {
    name: 'platform_draft_residue',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: wire.PlatformDraftResidueWireSchema,
    description:
      'Cross-workspace draft counts by kind (WorkerDefinition/Skill/Procedure) — never their content or proposer. The periodic sweep (`DRAFT_EXPIRY_DAYS`, default 30) deletes anything this count includes once it goes stale; this capability exists only so a human can see the queue before it empties itself.',
  },
  // S7-E (P-C, docs/platform-admin-design.md §6.5 / §6.7; development-tasks.md §5d S7-E 决定
  // E1–E4): the runtime layer (active image / inventory / rollback / pi drift) and platform
  // status. Handlers live in application/platform/runtime.ts (kernel), not platform-handlers.ts.
  {
    name: 'runtime_inventory',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: wire.RuntimeInventoryWireSchema,
    description:
      'The active runtime image (tag/digest, baked-in pi and platform-extension versions) and every resident entry container across workspaces, each flagged 待重建 when its own resolved image id differs from the active image’s — derived live, never stored.',
  },
  {
    name: 'list_runtime_images',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.RuntimeImageWireSchema),
    description:
      'Every runtime image worker-supervisor knows about that carries the platform’s `ai.nexttime.*` labels (built by `docker compose build worker-runtime` on the host/CI — this capability never builds one).',
  },
  {
    name: 'set_active_runtime_image',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ image: z.string().min(1) }).strict(),
    resultSchema: wire.PlatformSettingsWireSchema,
    description:
      'Sets the platform’s active runtime image (must already appear in `list_runtime_images`) — resident entry containers pick it up at their own next spawn (spec-drift rebuild, E2); no forced restart. Audited.',
  },
  {
    name: 'rollback_runtime_image',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: wire.PlatformSettingsWireSchema,
    description:
      'Switches the active runtime image back to the most recent `platform_settings_history` value that differs from the current one — an intervening unrelated settings write (e.g. siteName) is skipped over, not treated as "the previous value". Calling this repeatedly toggles between the last two distinct images. Audited.',
  },
  {
    name: 'roll_entry_containers',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        /** Omitted = every resident container currently flagged 待重建; when given, only these
         *  principals are considered (still skipped if not 待重建 or in-flight). */
        principalIds: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    resultSchema: wire.RollEntryContainersResultWireSchema,
    description:
      'Acceleration only (E2): stops resident entry containers that both need rebuild and have no in-flight Turn (kernel’s own `activities` bookkeeping) — never a forced stop of a busy container, never a draining/reject-new-Turn state. Every stopped container is recreated with the active image at its own next spawn regardless of whether this was ever called.',
  },
  {
    name: 'pi_drift',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: wire.PiDriftWireSchema,
    description:
      'Whether the pi this release expects (`pi.version`, baked into the kernel image) and the pi in the active runtime image (its own version label) agree, plus that image’s platform-extension version — never a live npm/GitHub lookup; `status: "unknown"` when the kernel build carries no pi.version or the active image has no real version label. Whether upstream has a newer pi is `platform_updates`.',
  },
  {
    name: 'platform_updates',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: wire.PlatformUpdatesWireSchema,
    description:
      'S10 U1: what is newer than this deployment — newer platform releases (migrations crossed, breaking, the exact `apply-release.sh --pull` command, the rollback release) and the latest upstream pi with the nightly drift check’s verdict — read from the ReleaseChannel record the host’s update-feed service downloads (the kernel itself never goes online). Validates the file on every read (schema, 64 KiB cap); reports how fresh it is. Reminder only: nothing here upgrades anything.',
  },
  {
    name: 'platform_status',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: wire.PlatformStatusWireSchema,
    description:
      'Read-only service health (kernel, postgres, llm-proxy, worker-supervisor, egress-proxy [unknown — its healthz is loopback-only by design], every gate instance’s last-known health), a 30-day cross-workspace llm_usage rollup, the most recent 50 platform audit rows, and backup posture (reports "未配置 not configured" until 遗留 6 lands — no backup timer exists).',
  },
  // P-B2b (docs/platform-admin-design.md §6.4 模块; docs/development-tasks.md §5d S7-D 决定 D1–D4):
  // the platform plane's own view of modules — every module this deployment ships
  // (`ontology/modules.yaml`), aggregated across workspaces, plus which install by default into a
  // new workspace. `group: 'platform'` (not `'modules'`, `assertRegistryConsistent`'s own
  // scope↔group invariant below) — the workspace-scope half (`list_workspace_modules`/
  // `install_module`/`upgrade_module`, the owner's 能力目录 模块 tab, P-B2 决定 ①) is
  // `modulesCapabilities` further down.
  {
    name: 'list_modules',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.ModuleWireSchema),
    description:
      'Every module this deployment ships (`ontology/modules.yaml`), with its version list and how many workspaces have it installed / are behind the latest version.',
  },
  {
    name: 'set_default_modules',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ defaultModules: z.array(z.string().min(1)).max(100) }).strict(),
    resultSchema: wire.PlatformSettingsWireSchema,
    description:
      'Set the module family names `create_workspace` installs (each at its own latest indexed version) into every new workspace. Every name must already be in `list_modules`’ own index — an unknown name 400s rather than being silently kept.',
  },
];

// -------------------------------------------------------------------------------------------
// modules, workspace half (P-B2b, docs/platform-admin-design.md §6.4; docs/development-tasks.md
// §5d S7-D 决定 D1–D4): `list_workspace_modules` / `install_module` / `upgrade_module` — the
// owner's 能力目录 模块 tab (P-B2 决定 ①: install/upgrade is `scope:'workspace'`, owner — same
// rule `enable_gate_instance` already follows for the analogous "enable a platform-catalog thing
// into my own workspace" action). The platform-scope half (`list_modules`/`set_default_modules`)
// is in `platformCapabilities` above, `group: 'platform'` (`assertRegistryConsistent`'s own
// invariant: every `scope:'platform'` capability must be `group:'platform'`, and vice versa).
// -------------------------------------------------------------------------------------------

const modulesCapabilities: readonly Capability[] = [
  {
    name: 'list_workspace_modules',
    group: 'modules',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.WorkspaceModuleWireSchema),
    description:
      'Every module this deployment ships, with this workspace’s own install state (not installed / up to date / outdated / customized) — the owner’s 能力目录 模块 tab.',
  },
  {
    name: 'install_module',
    group: 'modules',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        name: z.string().min(1),
        /** Required when the module is currently `customized`, or any index version between the
         *  current one and the latest is `breaking` (400 `module_confirm_required` otherwise, with
         *  the exact versions in `details`). */
        confirm: z.boolean().optional(),
      })
      .strict(),
    resultSchema: wire.WorkspaceModuleWireSchema,
    description:
      'Install a module into this workspace — publishes its latest `OntologyDefinition` (the same mechanism `seed-domain-pack` uses) with this owner as `proposed_by`/`published_by`. Already installed → identical to `upgrade_module` (same underlying call, D3). An ObjectType or ActionType name another installed ontology family already declares refuses 409 ontology_namespace_conflict (I-P1).',
  },
  {
    name: 'upgrade_module',
    group: 'modules',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ name: z.string().min(1), confirm: z.boolean().optional() }).strict(),
    resultSchema: wire.WorkspaceModuleWireSchema,
    description:
      'Advance this workspace’s installed module directly to its latest indexed version (one publish, never stepping through intermediate versions). Not installed yet → identical to `install_module` (same underlying call, D3). Already at the latest content → a no-op returning the current state (never wastes a version number). An ObjectType or ActionType name another installed ontology family already declares refuses 409 ontology_namespace_conflict (I-P1).',
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
  ...modulesCapabilities,
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
  'update_operation_description',
  // STATUS leftover 89: a human attestation is a person's own word — never reachable by a Handle.
  'attest_fact',
  'approve',
  'reject',
  'list_pending',
  'get_action',
  // S5.5 leftover 21 — same human-only defense-in-depth as its two siblings right above.
  'list_action_requests',
  'set_auto_approved_action_kind',
  'grant_capability',
  'revoke_capability',
  'set_policy',
  'set_quota',
  'issue_handle',
  'publish_worker_definition',
  'deprecate_worker_definition',
  'discard_draft',
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
  // P-A1: the platform plane, plus a few workspace-scope members that belong next to it. The
  // `scope: 'platform'` names here are never callable by a Principal at all (the gateway admits
  // only a platform-admin console session); the workspace-scope ones — `list_available_gate_instances`,
  // `enable_gate_instance`, `preview_gate_instance_enable`, `refresh_operation_governance`,
  // `issue_service_handle`, `issue_gate_credential_token` — are a workspace's own connection and
  // credential management, human-only for the same reason as the S3.11 names above. None is ever a
  // Handle-scope member.
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
    'confirm_gate_manifest',
    'test_gate_instance',
    'list_external_runtimes',
    'revoke_external_runtime',
    'list_available_gate_instances',
    'enable_gate_instance',
    'preview_gate_instance_enable',
    'refresh_operation_governance',
    'issue_service_handle',
    'create_gate_instance',
    'delete_gate_instance',
    'issue_gate_host_token',
    'issue_gate_credential_token',
    'issue_llm_admin_token',
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

/** D-08: whether calling `capability` changes state — its explicit `sideEffects` flag, else what
 *  its `mode` implies (see `Capability.sideEffects`). The read-only test every consumer uses. */
export function capabilityHasSideEffects(
  capability: Pick<Capability, 'mode' | 'sideEffects'>,
): boolean {
  return capability.sideEffects ?? capability.mode !== 'observe';
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

    // D-08: a write / propose / execute is never side-effect free.
    if (capability.mode !== 'observe' && capability.sideEffects === false) {
      throw new Error(
        `capability registry: "${capability.name}" is ${capability.mode}-mode but declares sideEffects:false`,
      );
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
