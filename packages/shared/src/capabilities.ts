import { z } from 'zod';
import { GateAbsenceSchema } from './action-description.js';
import {
  ConflictStatusSchema,
  ConnectionRequestStatusSchema,
  DraftKindSchema,
  GoalPlannerModeSchema,
  RejectableDraftKindSchema,
  RoleSchema,
  WorkerDefinitionKindSchema,
} from './enums.js';
import {
  ActionRequestFailureKindSchema,
  ActionRequestReconciliationSchema,
  ActionRequestStatusSchema,
  GoalRunStatusSchema,
  ObjectiveOutcomeSchema,
} from './enums.js';
import type { CapabilityChannel, Role } from './enums.js';
import { listEnvelope } from './envelope.js';
import { EVAL_CASE_MECHANISM_MAX, evalCaseContentFields, evalCaseKindFields } from './eval-case.js';
import {
  GoalBudgetSchema,
  GoalPlanSchema,
  MAX_GOAL_IDEMPOTENCY_KEY_CHARS,
  MAX_GOAL_NOTE_CHARS,
  MAX_GOAL_STATEMENT_CHARS,
  MAX_PLAN_STEPS,
  MAX_REVISION_REASON_CHARS,
  MAX_WORKER_SPEC_LIST,
  StepKeySchema,
  StepRemovalsSchema,
  StepTrialDraftSchema,
} from './goal-plan.js';
import { PlanRevisionDecisionSchema } from './goal-planner.js';
import { CapabilityScopeSchema } from './handle-token.js';
import { OntologyDefinitionSchema } from './ontology-definition.js';
import { GoalFromProcedureSchema } from './procedure.js';
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
  // S11 GO5 (docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §4.3, §7): GoalRuns — the
  // reads (GO5a), the requester's and owner's operations (GO5b) and `propose_goal` (GO5c). Its own
  // group: a GoalRun is neither a Task (it runs many) nor a governance record.
  'goal',
  // S10 E3 (docs/s10-evolution-plan-2026-10-04.md §5.5, §5.6): evaluation suites (E3-1) and, later,
  // evaluation runs. Its own group: what it holds is closed to agents (I-E4), so every member is
  // human-channel, made for a person, and listed in HUMAN_ONLY_CAPABILITY_NAMES.
  'evaluation',
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
  /**
   * S11 GO5c: the call acts for a person — the Principal it is made for (the caller on the human
   * channel, the Handle's `obo` on the handle channel) must be `kind = 'human'`. The kernel's
   * dispatch refuses any other with 403, and a service Handle never carries it
   * (`issue_service_handle` drops it as it drops what the role may not use; the console does not
   * offer it there). `propose_goal`: a goal's requester confirms it in the console, which a
   * service or agent Principal cannot. Absent = any kind.
   */
  readonly actsForPerson?: true;
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
  /**
   * S10 E3-1b (docs/s10-evolution-plan-2026-10-04.md §3.3 I-E4, 评测对人透明、对 agent 封闭):
   * top-level param field names whose values `application/gateway/dispatch.ts` leaves out of this
   * capability's `audit_records.payload` — replaced whole by {@link AUDIT_WITHHELD_VALUE}, and named
   * in the payload's `withheldParams`. An evaluation case's content lives in `eval_cases` only, so
   * its one read path is `get_eval_case`, a person's: nothing that reads the audit trail can carry a
   * holdout case anywhere else. Not a credential rule (that is `redactedParamKeys`): the values are
   * not secrets, and the record says what was left out instead of counting masked values.
   */
  readonly auditWithheldParamKeys?: readonly string[];
}

/** What the audit copy of a call's params holds in place of a value its capability withholds
 *  (`Capability.auditWithheldParamKeys`). */
export const AUDIT_WITHHELD_VALUE = '[withheld]';

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
 *  entry's own resultSchema doc comment below). Defined once, reused by both.
 *
 *  S11 「门确认不存在」 A: `absent` is set when the gate answered that the target has no such
 *  thing — the target's http status or exit status, one the published Operation declares means so
 *  (`isDeclaredAbsence`); `data` is then `null` and no Facts were written. */
const gateObserveResultSchema = z
  .object({
    status: z.literal('ok'),
    data: z.unknown().optional(),
    observedFactCount: z.number().int().nonnegative(),
    absent: GateAbsenceSchema.optional(),
  })
  .strict();

// -------------------------------------------------------------------------------------------
// chat — human channel only ("只走 human 通道")
// -------------------------------------------------------------------------------------------

const chatCapabilities = [
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
] as const satisfies readonly Capability[];

// -------------------------------------------------------------------------------------------
// ontology
// -------------------------------------------------------------------------------------------

const ontologyCapabilities = [
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
] as const satisfies readonly Capability[];

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

const graphCapabilities = [
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
          // S11 W1a E2-2 (fork 4 = a): a hint, never the order.
          outcomes: wire.ProcedureOutcomeHintWireSchema,
        })
        .strict(),
    ),
    description:
      'Find published Procedures whose name/description matches any keyword in `need` (space/' +
      'punctuation-separated; a blank need lists every candidate). Each result carries outcomes ' +
      '{achieved, total}: platform statistics over only the goals made from that version and ' +
      'judged by the requester or a platform check. A small total says little about the ' +
      'Procedure’s quality, and results are not ordered by it.',
  },
] as const satisfies readonly Capability[];

// -------------------------------------------------------------------------------------------
// gate — interface-manifest projection. `<gate>.<op>` is a *pattern*: the real, dynamic capability
// names (e.g. `docker.container_restart`) are generated at runtime from a Gatekeeper's published
// Operations (§7.4, §7.5) and are therefore not enumerable here. Two pattern rows stand in for
// the two Operation modes: the observe-class projection (called directly) and the execute-class
// projection (intercepted client-side and turned into a `request_action` call, per §7.4 "拦截是
// 便利闸门，安全边界在 gateway"). assertRegistryConsistent()'s execute+handle allow-list
// recognizes both `request_action` and this execute-class gate pattern by name.
// -------------------------------------------------------------------------------------------

const gateCapabilities = [
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
      'Run one published observe-class Operation on a Gatekeeper and return its data (the capability behind every <gate>.<op> observe tool); execute-class Operations are refused. Params carrying a literal credential (a JWT, a vendor API key, a private key, a Bearer or Authorization token, a Basic user:password, a URL with a password) are refused before the gate is called — 400 credentials_in_observe_params (details: suspectedSecretValues, suspectedSecretPaths); a gate authenticates with the credentials configured on it. Any other suspected value passes and the audit row records how many and where: one under a secret-named field (pageToken), or query text that only mentions a credential (an Authorization header name, token=expired, a $VAR placeholder).',
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
] as const satisfies readonly Capability[];

// -------------------------------------------------------------------------------------------
// connection
// -------------------------------------------------------------------------------------------

const connectionCapabilities = [
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
      'Register a Gatekeeper instance with address and credentials (credentials go straight to the gatekeeper, never persisted by the kernel); auto-imports a manifest draft for http/mcp. The endpoint must not be a platform-catalog gate instance (400 endpoint_is_platform_gate) — those are enabled with enable_gate_instance. Requires connectionSecret (from mint_connection_secret, already configured in the gate); endpoint and manifestSource must not point at platform services or networks (400 connection_target_refused). Refused (409 connector_not_self_serve) unless the platform keeps this kind’s connector in self-serve mode. P0b: refused 409 endpoint_already_connected (details.gatekeeperId and details.gatekeeperName, the Gatekeeper already there) when this workspace already has a Gatekeeper at that endpoint, under any spelling of it (scheme and host case, a trailing dot, the default port, user info, query and fragment, trailing slashes, an IDN host and its punycode, percent-encoding) — re-sync or rotate that one instead; the new Gatekeeper is recorded as a self connection, which the platform can suspend (suspend_self_connection).',
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
    // Review #493 on #592 (P2, the bulk form of legacy 300): `drafts` names every draft as the
    // caller read it — list_operations' `name` + `draftDigest` for this gatekeeper's drafts.
    paramsSchema: z
      .object({
        gatekeeperId: id,
        drafts: z
          .array(z.object({ name: z.string().min(1), draftDigest: z.string().min(1) }).strict())
          .max(1000),
      })
      .strict(),
    resultSchema: wire.PublishManifestResultWireSchema,
    description:
      'Publish every draft Operation in a Gatekeeper’s interface manifest (I16/I17): the gate’s own import-origin drafts; an agent’s or person’s proposal stays a draft (skippedDraftOperationNames) for publish_operation. drafts lists the drafts as you read them (name + draftDigest from list_operations); refused 409 draft_changed, with nothing published, when a draft it would publish is missing from drafts or was revised since. Legacy J: a draft declaring a param only the gate sets (an identity/routing header, a credential query param, a cookie, a query param its binding fixes) stays a draft and is listed in gateOwnedParamDrafts with those params. A draft declaring answers that mean “does not exist” stays a draft too, listed in absentAnswerDrafts — publish_operation with absentAnswersReviewed publishes it.',
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
      'P-B1: enable a platform gate instance in this workspace — registers its Gatekeeper, imports and publishes its announced Operations (origin import), and links the workspace to the instance so trust and disabled Operations are read live. Idempotent per (workspace, gate). S8 W2-K2 (leftover 73): when an existing Gatekeeper in this workspace already has the same endpoint (the same gate process registered before — a gate the workspace connected itself at that address, or one the removed register-gatekeeper CLI registered), links it instead of registering a duplicate (result carries linkedExisting + drift); more than one match refuses 400 ambiguous_existing_gatekeeper rather than guess. L4-13: a single match already linked to a different gate instance refuses 409 gatekeeper_already_linked (one link per Gatekeeper). R-18: an optional manifestDigest (from preview_gate_instance_enable) makes it refuse 409 manifest_changed when the manifest in effect is no longer the previewed one. Legacy J: an imported draft declaring a param only the gate sets stays a draft, listed in gateOwnedParamDrafts; so does one declaring answers that mean “does not exist”, listed in absentAnswerDrafts. P0b: linking a Gatekeeper the workspace connected itself converts it to the catalog origin (its self-connection record goes; audited gatekeeper.self_connection_linked); one the platform suspended refuses 409 self_connection_suspended.',
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
      'S8 W2-K2 (audit J3): read-only preview of what enable_gate_instance would do for this gate instance right now — whether it would link an existing Gatekeeper by endpoint (with any name/target/transportKind drift) or register a new one (or refuse as ambiguous_existing_gatekeeper, or 409 gatekeeper_already_linked when that Gatekeeper is already linked to another instance, or 409 self_connection_suspended when it is a self connection the platform suspended), and which announced Operations would be newly imported vs. are already published/deprecated (flagging drift from the announced manifest, audit CO2; legacy K: definitionDiffers when the gate announces another definition, which it refuses to run calls under until a revision is published). Computed by the exact same lookup and manifest-parse functions enable_gate_instance uses; writes nothing.',
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
      'S8 W3-K1 (leftover 79, audit CO2): apply the gate’s currently-announced governance fields (mode, blastRadius, autoApprovable, awaitDecision, reads, writes and the MCP hints — STATUS leftover 344) to every selected, already-deployed Operation of this Gatekeeper whose fields disagree with it (in place — no new Operation version). operationNames narrows the selection; omitted refreshes every announced Operation. The announced manifest is the linked platform gate instance’s manifest in effect, or — legacy 214, for a gate the workspace connected itself — the gate’s own describe_operations, read again now (preview_gatekeeper_resync). Either way an announced Operation this Gatekeeper never had is imported as an import-origin draft, never published here (listed in revisionDrafts, audited with reason new_in_adopted_manifest or new_on_gate); one the gate itself no longer runs is not. For a self-connected gate a governance change that loosens anything (direction loosened or mixed) is never written in place — the published Operation keeps its fields and an import-origin revision draft carrying the gate’s entry is opened instead (revisionDrafts, audited with reason governance_loosened or definition_changed plus governanceDirection), taking effect only when an owner publishes it; a tightening is still applied in place. Refuses 409 no_announced_manifest when this Gatekeeper is at a platform gate instance’s address but was never enabled from the catalog, and 409 manifest_changed when manifestDigest is not the digest of the manifest in effect or of the gate’s description (R-18: only the previewed values are ever applied). One AuditRecord per refreshed Operation with before/after and a loosened/tightened/mixed classification. Legacy K: a selected published Operation whose announced definition changed (the gate refuses calls under the deployed one) gets an import-origin revision draft at the next version carrying the announced definition, listed in revisionDrafts and audited as operation.revision_drafted; an owner publishes it with publish_operation / publish_manifest. A pending import-origin draft (an earlier revision, or one a bulk publish held back for a gate-owned param, legacy J) is rewritten to the announced entry at its own version when it differs, and listed the same way; an agent’s or person’s proposal is never overwritten.',
  },
  {
    // Legacy 214: the read half of refresh_operation_governance for a gate the workspace connected
    // itself — same scope/minRole as the write; `observe` since it writes nothing (it does call the
    // gate's own describe_operations, as create_connection does).
    name: 'preview_gatekeeper_resync',
    group: 'connection',
    mode: 'observe',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ gatekeeperId: id }).strict(),
    resultSchema: wire.PreviewGatekeeperResyncResultWireSchema,
    description:
      'Legacy 214: read-only preview of re-syncing a gate the workspace connected itself (create_connection) — asks the gate what it runs now (describe_operations, with the connection’s own secret) and compares it with this Gatekeeper’s Operations by the same rules as preview_gate_instance_enable: drafts and names it never had (operationsToImport; without pendingDraft the resync imports them as drafts), deployed ones with governance drift (differs, direction; governanceByRevision when the change loosens anything — the resync then opens a revision instead of writing it in place) or another definition (definitionDiffers — the gate refuses calls under the deployed one until a revision is published), and published names the gate no longer describes (notDescribed). manifestDigest goes back to refresh_operation_governance, which opens the revisions. Refuses 409 gatekeeper_linked for a Gatekeeper enabled from a platform gate instance (align with its announcement instead) and 409 no_announced_manifest for one at a platform instance’s address that was never enabled from the catalog. Writes nothing.',
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
] as const satisfies readonly Capability[];

// -------------------------------------------------------------------------------------------
// meta
// -------------------------------------------------------------------------------------------

const metaCapabilities = [
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
    paramsSchema: z
      .object({
        gatekeeperId: id,
        name: z.string().min(1),
        credentialsReviewed: z.boolean().optional(),
        // S11 「门确认不存在」 B-a: the caller confirms the draft's `absentAnswers` — required when it
        // declares any (`OperationSummaryWire.absentAnswers`).
        absentAnswersReviewed: z.boolean().optional(),
        // Review #493 on #583: the draft the caller reviewed (`OperationSummaryWire.draftDigest`).
        // Legacy 300: required — a publish names what was reviewed, never "whatever is there now".
        draftDigest: z.string().min(1),
      })
      .strict(),
    resultSchema: wire.OperationPublishResultWireSchema,
    description:
      'Publish a draft Operation (I16). Builder floor; only the draft’s proposer or the workspace owner may publish it (403 not_proposer otherwise). When the draft carries suspected credentials, credentialsReviewed: true is required — 400 credentials_review_required (details: subject, suspectedSecretValues) otherwise. Legacy J: an http Operation declaring a param only the gate sets (an identity/routing header, a credential query param, a cookie, a query param its binding fixes) is never published — 400 gate_owned_params (details: params [{param, location}]). draftDigest is the catalog’s draftDigest for the draft reviewed: when the draft was revised in place since, 409 draft_changed and nothing is published. An observe Operation whose binding declares answers that mean “does not exist” (absentAnswers) is published only with absentAnswersReviewed: true — the caller confirms the gate’s credentials can see what such a call looks up, so those answers come only when it is not there (not for no permission, a wrong address, or any other failure that gives the same answer) — 400 absent_answers_review_required (details: absentAnswers) otherwise; only a person confirms (a service Principal’s absentAnswersReviewed is refused 403); the published version records who confirmed and when (absentAnswersReview).',
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
    // Legacy 278 (UX acceptance of #577): a draft Operation nobody will publish — the gate no longer
    // announces it, or it declares a param only the gate sets — had no way out of the catalog.
    // Discarding is a lifecycle transition (`OPERATION_TRANSITIONS`, `draft → discarded`), not a
    // delete: the row, its `exposes` Fact and provenance stay; directory reads leave it out. Same
    // D-24 authority as publish/deprecate (builder floor, then the draft's proposer or the owner),
    // checked on the locked row. `version` and `draftDigest` (`OperationSummaryWire.draftDigest`)
    // together name the draft the caller looked at: a draft is revised in place at the same version
    // (its proposer re-proposing, a gate re-import), so the version alone does not (review #493 on
    // #583) — a draft whose digest differs is refused 409 `draft_changed` and nothing is written.
    // `reason` lands in this call's AuditRecord (dispatch.ts) — the same signal `discard_draft`
    // keeps for the evolution loop.
    name: 'discard_operation_draft',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z
      .object({
        gatekeeperId: id,
        name: z.string().min(1),
        version: z.number().int().positive(),
        draftDigest: z.string().min(1),
        reason: z.string().max(500).optional(),
      })
      .strict(),
    resultSchema: wire.OperationDiscardResultWireSchema,
    description:
      'Discard one draft Operation version (draft → discarded): it stays recorded but leaves the catalog, and the next draft of that Operation takes a new version. Builder floor; only the draft’s proposer or the workspace owner may discard it (403 not_proposer otherwise); a published or deprecated version is 409 (deprecate it instead). draftDigest is the draftDigest the catalog listed for that draft: a draft revised in place since refuses 409 draft_changed and nothing is discarded. Optional reason, kept in the audit record.',
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
      'S8 W3-K1 (leftover 81): edit one Operation’s description in place (documentation only, not a governance field — no draft/publish step). Builder floor; only the Operation’s proposer or the workspace owner may edit it (403 not_proposer otherwise). description must be non-blank after trimming, at most 2000 characters; refused when it carries a suspected credential (400 credentials_in_text) or still holds the [redacted] mark a read shows in place of one — write that part again (400 redacted_text_submitted). Sent exactly as a read shows the current description, it changes nothing (the stored text is kept). AuditRecord with before/after for a change.',
  },
  {
    name: 'propose_skill',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    // S11 W1a E2-0 (legacy 48 ②, S10 decision 10): `skillId` makes the draft the next version of
    // that Skill family; omitted, a new family as before (application/worker/family-version.ts).
    paramsSchema: z.object({ skill: jsonRecord, skillId: id.optional() }).strict(),
    resultSchema: wire.SkillProposeResultWireSchema,
    description:
      'Propose a private draft Skill, typically at the end of a successful WorkerRun. skillId ' +
      'makes it the next version of that Skill (omitted: a new Skill); the new version keeps the ' +
      'Skill’s name (409 skill_name_changed — a different name is a new Skill), and is refused ' +
      'while the Skill’s latest version is still a draft (409 draft_pending: that draft is ' +
      'published, discarded or rejected first). An unknown skillId is not found.',
  },
  {
    name: 'propose_procedure',
    group: 'meta',
    mode: 'propose',
    channel: 'handle',
    minRole: 'builder',
    // S11 W1a E2-0: `procedureId` makes the draft the next version of that family, as
    // propose_skill's `skillId`.
    paramsSchema: z.object({ procedure: jsonRecord, procedureId: id.optional() }).strict(),
    resultSchema: wire.ProcedureProposeResultWireSchema,
    description:
      'Propose a private draft Procedure distilled from a successful Task: procedure is {name, ' +
      'description, steps — operation, worker, approval or verify — and optionally parameters}. ' +
      'A worker step names a worker-kind WorkerDefinition version; one naming another kind (an ' +
      'entry definition) is refused (400 invalid_step_reference). ' +
      'A published Procedure is also a template a goal’s plan is made from (propose_goal’s ' +
      'fromProcedure): a worker step may carry what a plan step does (key, dependsOn, input, ' +
      'outputSchema, maxAttempts, and bindings — from an earlier step it depends on, or from ' +
      '$params, the parameters the goal is proposed with), a verify step a check (an acceptance ' +
      'check the platform makes), and parameters is the schema of those parameters — the same ' +
      'bounded JSON Schema subset as an outputSchema. procedureId makes it the next version of ' +
      'that Procedure (omitted: a new Procedure); refused while the Procedure’s latest version ' +
      'is still a draft (409 draft_pending: that draft is published, discarded or rejected first). An unknown ' +
      'procedureId is not found.',
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
    // Legacy 300: `version` is the version the caller reviewed (`SkillSummaryWire.version`, or the
    // propose result's). The kernel publishes the family's latest version, and refuses 409
    // `version_changed` when that is another one — nothing is written. Review #493 on #764 (F1):
    // a discarded draft is deleted and its version taken again by the next proposal, so the
    // version alone does not bind the content reviewed — `draftDigest` (`SkillSummaryWire.
    // draftDigest`, or the propose result's) does, refused 409 `draft_changed` when it differs.
    paramsSchema: z
      .object({
        skillId: id,
        version: z.number().int().positive(),
        draftDigest: z.string().min(1),
        credentialsReviewed: z.boolean().optional(),
        // S10 E3-3 (§5.5 结果去哪, I-E3): the draft's evaluations as the caller reviewed them
        // (get_skill_publish_evidence) — absent is `{evaluationId: null}`, "I saw none".
        evaluationReview: wire.PublishEvaluationReviewSchema.optional(),
      })
      .strict(),
    resultSchema: wire.SkillPublishResultWireSchema,
    description:
      'Publish your draft Skill (I16) — the latest version under skillId, which must be the version given (the one reviewed): a newer version under skillId since is 409 version_changed and nothing is published. draftDigest is the draftDigest list_skills / get_skill / propose_skill gave for that draft: a draft discarded and proposed again under the same version since is 409 draft_changed and nothing is published. Builder floor; the workspace owner may publish anyone’s draft (e.g. one a member’s Worker proposed); another builder’s draft is 403 not_proposer. When the draft carries suspected credentials, credentialsReviewed: true is required — 400 credentials_review_required (details: subject, suspectedSecretValues) otherwise. A name another Skill family already has published refuses 409 skill_name_conflict (a Worker mounts Skills by name, so one name has one Skill) — deprecate that one or rename the draft. Evaluation is evidence, never a gate, but the publish names the evidence reviewed: evaluationReview.evaluationId is the first of get_skill_publish_evidence’s evaluations for this draft (null, or evaluationReview omitted: none) — another finished since is 409 evaluation_changed (details: evaluationId, the latest now) and nothing is published; while one of the draft’s evaluations runs, 409 draft_evaluating. Each failure in its acknowledge list (the cases a regressed or worse evaluation of this draft lost) needs an acknowledgement with a reason (evaluationReview.acknowledgements: [{evaluationId, caseId, reason}]), given by a person (a service Principal’s is 403) — 400 evaluation_review_required (details: items [{evaluationId, caseId}] not acknowledged) otherwise; one naming no such failure, or one twice, is 400 invalid_params. The audit record keeps the evidence’s id, verdict and reason, and each acknowledgement with its reason.',
  },
  {
    name: 'publish_procedure',
    group: 'meta',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder', // D-24 — see publish_skill.
    paramsSchema: z
      .object({
        procedureId: id,
        // Legacy 300 and review #493 on #764 (F1) — see publish_skill.
        version: z.number().int().positive(),
        draftDigest: z.string().min(1),
        credentialsReviewed: z.boolean().optional(),
      })
      .strict(),
    resultSchema: wire.ProcedurePublishResultWireSchema,
    description:
      'Publish your draft Procedure (I16) — the latest version under procedureId, which must be the version given (the one reviewed): a newer version under procedureId since is 409 version_changed and nothing is published. draftDigest is the draftDigest list_procedures / propose_procedure gave for that draft: a draft discarded and proposed again under the same version since is 409 draft_changed and nothing is published. Builder floor; the workspace owner may publish anyone’s draft; another builder’s draft is 403 not_proposer. When the draft carries suspected credentials, credentialsReviewed: true is required — 400 credentials_review_required (details: subject, suspectedSecretValues) otherwise. Every operation step must name a published Operation and every worker step a published worker-kind WorkerDefinition version — 400 invalid_step_reference naming the step otherwise. A Procedure that says how a goal’s plan is made from it (parameters, a worker step’s plan fields, a verify step’s check) is published only when the plan it makes passes everything a written plan is held to — its $params bindings checked against parameters, no credential or [redacted] mark — 400 invalid_params with details.problems otherwise; one with an operation or approval step is still published, for following by hand, but makes no goal.',
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
      'each with its proposedBy; a draft row also carries inUse, the family’s latest published ' +
      'version (the one Workers mount until the draft is published), when there is one; ' +
      'keyset-paginated (limit, cursor → nextCursor).',
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
    // UX acceptance of #764 (P2-1): `version` reads that version — the published one a draft row's
    // `inUse` names — instead of the latest; same read rule.
    paramsSchema: z
      .object({ skillId: id, version: z.number().int().positive().optional() })
      .strict(),
    resultSchema: wire.SkillDetailWireSchema.nullable(),
    description:
      'Read one Skill (latest version, or the version named) with its full markdown body — same ' +
      'read rule as list_skills (published, or a draft the caller may see); null for an unknown ' +
      'id or version, or a draft the caller may not see.',
  },
  {
    // S11 W1a E2-1 (S10 §5.4; coordinator decisions 2026-10-29): a Skill family's statistics,
    // aggregated when read — see `wire/skill-stats.ts` for every counting rule. Human channel, builder
    // floor (fork 7 = a): the numbers span every conversation and goal in the workspace, so they go
    // to the people who maintain Skills, as numbers only.
    name: 'get_skill_stats',
    group: 'meta',
    mode: 'observe',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z.object({ skillId: id }).strict(),
    resultSchema: wire.SkillStatsWireSchema.nullable(),
    description:
      'How each version of a Skill family has done: WorkerRuns that loaded it; Tasks completed / failed / cancelled / in progress under the version their last run loaded; the attainment rate (requester and verified_by_check outcomes) with proxy outcomes (agent_reported, reviewer_assessed) apart; the same per run environment (environmentDigest, null = unknown), each segment marked reviewSuggested when its latest reviewStreak primary outcomes were all not achieved; and failed Tasks grouped by WorkerDefinition version × failure category × what refused them. Numbers only. Builder floor; null for an unknown skillId.',
  },
  {
    // S10 E3-3 (§3.3 I-E4, §5.5 封闭 / 防噪): what the proposer — and an agent acting for them —
    // is told of the evaluations of their drafts of one Skill: the verdict on the dev cases only
    // (`DraftEvaluationDevVerdict`, written when the evaluation ends), never a pass count, a case
    // or a reason. Handle channel; the caller's own proposals only, whatever their role (on a
    // Handle, its obo's). Read from one column of the evaluation's row — the scoring module stays
    // the human-channel handlers' alone (`.dependency-cruiser.cjs`).
    name: 'get_skill_draft_verdicts',
    group: 'meta',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ skillId: id }).strict(),
    resultSchema: wire.SkillDraftVerdictsWireSchema,
    description:
      'How the finished evaluations of the drafts you proposed of one Skill came out, newest first (at most 20; truncated when there are more): each draft’s version and draftDigest, and its devVerdict — the evaluation’s rules read on its dev cases only: regressed (a regression case it kept passing is now lost), refuted (the failure it aimed at is not shown fixed), worse, better or non_inferior against the version it would replace, inconclusive (those cases do not decide), or unmeasured. Read it before proposing the next version (propose_skill with skillId): a draft found regressed, refuted or worse is not a direction to repeat. Pass counts, the cases, why and when are not given, nor an evaluation still running. Drafts someone else proposed are not listed; an unknown skillId lists none.',
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
      'first, each with its proposedBy and its parameters schema (null: it takes none); a draft ' +
      'row also carries inUse, the family’s latest published version (the one a goal made from ' +
      'it uses until the draft is published), when there is one; keyset-paginated (limit, ' +
      'cursor → nextCursor).',
  },
  {
    // S11 W1a E2-2 (S10 §5.4; coordinator decisions 2026-10-29): a Procedure family's statistics,
    // aggregated when read — see `wire/procedure-stats.ts` for every counting rule. Same audience as
    // `get_skill_stats` (human channel, builder floor, numbers only).
    name: 'get_procedure_stats',
    group: 'meta',
    mode: 'observe',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z.object({ procedureId: id }).strict(),
    resultSchema: wire.ProcedureStatsWireSchema.nullable(),
    description:
      'How each version of a Procedure family has done: the goals made from it by status (proposed / in progress / completed / cancelled / failed); the attainment rate over their outcomes (requester and verified_by_check) with reviewer_assessed apart; the Turns whose entry agent said it followed the version and the requester’s outcomes of them (claims: agent-reported, never in the rate); the same per set of run environments the goals ran in (environmentDigests, null = unknown), each segment marked reviewSuggested when its latest reviewStreak primary outcomes were all not achieved; and the goals that ended without being achieved, grouped by where they went wrong (a Procedure step by key, a step a later revision added, the acceptance checks, or the requester) × the step’s failure category. Numbers only. Builder floor; null for an unknown procedureId.',
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
] as const satisfies readonly Capability[];

// -------------------------------------------------------------------------------------------
// epistemic — Semantica tool-name contract preserved (get_provenance=explain,
// get_causal_chain=causal_chain, analyze_decision_impact=decision_impact); §9.3 row constrains
// every capability in this group to observe or propose (never execute).
// -------------------------------------------------------------------------------------------

const epistemicCapabilities = [
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
        relatedFactIds: z.array(z.guid()).optional(),
        relatedTaskId: z.guid().optional(),
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
] as const satisfies readonly Capability[];

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

const governanceCapabilities = [
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
        // Legacy 232: non-empty like `observe_operation`'s; a name the gate holds no definition
        // for is refused by the handler (404 `unknown_operation`), not queued for approval.
        operation: z.string().min(1),
        params: jsonRecord,
        // P1-1 fix (review job 652a4abc): scoped to (workspace, on_behalf_of, sid, key) by the
        // handler before it reaches the DB's (workspace_id, idempotency_key) unique index — a
        // repeat call with the same key returns the existing ActionRequest instead of creating a
        // second one, whatever its status. Omitted, a default is derived from (sid|principal,
        // gatekeeperId, operation, stable params hash) so an unmarked retry still collapses onto
        // the same row — but only while that row is in flight (2026-10-02 review R-53, D-12):
        // once it is terminal, an identical call is a new intent. S11 GO3c (I-G4): from a Worker
        // whose Task runs for a goal step, neither applies — the step's own identity (step,
        // gatekeeperId, operation, stable params hash) replaces the key, across the step's
        // attempts: an executed request, one still in flight, or one whose outcome is unknown is
        // replayed, unless its requester decided to run it again.
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
    //     data?, reason?, failureKind?}` execution-outcome shape those continuations (`tryExecuteInline`/
    //     `awaitConcurrentExecution`/`pollAndExecute`/`readTerminalOutcome`) resolve to — with,
    //     for a row that has not finished (legacy 287), why it waits: `outcomeInDoubt` on an
    //     `executing` one whose `apply` got no answer, `queuedBehind` on an approved one.
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
          // On a `failed` outcome, the reason read back from its audit row, shown like
          // `ActionRequestWireSchema.failureReason` (legacy 338): redacted, clipped to 1000 code
          // points, unseen characters shown as `\u{XXXX}`, line breaks kept.
          reason: z.string().optional(),
          // S11 GO1: on a `failed` outcome, its kind (`ActionRequestWireSchema.failureKind`).
          failureKind: ActionRequestFailureKindSchema.optional(),
          // S11 GO3c: on a replayed `failed` + `outcome_unknown` row someone has reconciled, what
          // was found (`ActionRequestWireSchema.reconciliation`) — `effect_seen`: it counts as
          // executed.
          reconciliation: wire.ActionRequestReconciliationWireSchema.optional(),
          outcomeInDoubt: wire.ActionRequestOutcomeInDoubtWireSchema.optional(),
          queuedBehind: wire.ActionRequestQueuedBehindWireSchema.optional(),
        })
        .strict(),
    ]),
    description:
      'A Worker’s only execute-mode entry point onto a Gatekeeper; creates an ActionRequest. A Handle caller’s gates are re-checked at call time against what its member may act on now (Grants minus My Agent exclusions, capped by the AgentPolicy; an owner keeps the Handle’s gates minus the same exclusions) — a gate dropped since the Handle was minted is denied (R-37). An observe-class Operation runs as observe_operation does, with the same credential review of its params (400 credentials_in_observe_params).',
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
    paramsSchema: z
      .object({
        actionRequestId: id,
        reason: z.string().optional(),
        credentialsReviewed: z.boolean().optional(),
      })
      .strict(),
    resultSchema: wire.ActionRequestWireSchema,
    description:
      'Approve a pending ActionRequest (I14: the approver must hold the requested scope). `reason` is optional for low/medium blast radius and required (non-blank) for high — 400 reason_required otherwise; it is written to the decision rationale and the audit row and exposed as decisionReason. When params carry suspected credentials (the row’s suspectedSecretValues), credentialsReviewed: true is required — 400 credentials_review_required otherwise; the count is recorded with the decision and in the audit row.',
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
        // Legacy 331: narrows to failed / compensated rows of these failure kinds (not sent /
        // refused / outcome unknown); intersects with `status`.
        failureKind: z
          .union([ActionRequestFailureKindSchema, z.array(ActionRequestFailureKindSchema)])
          .optional(),
        // Same default/max as `search` (docs/wire-contract-conventions.md §3;
        // substrate/graph/store.ts `DEFAULT_SEARCH_LIMIT`/`MAX_SEARCH_LIMIT`).
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.ActionRequestWireSchema),
    description:
      'List ActionRequests regardless of status (the approval history), optionally filtered by ' +
      'status, failureKind, gatekeeperId, taskId (every WorkerRun of that Task) or ' +
      'parentWorkerRunId; ' +
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
    // Legacy 218: ticked on one ActionRequest, it allows the definition that request was made
    // against only (the rule records its digest); a revision published later goes back through
    // approval until someone allows it again.
    paramsSchema: z
      .object({ gatekeeperId: id, actionKindTag: z.string().min(1), actionRequestId: id })
      .strict(),
    resultSchema: wire.PolicyWireSchema,
    description:
      '"Always allow" — auto-approve this Gatekeeper’s published Operation `actionKindTag` from now on, for every requester (a gate-scoped Policy rule; the same name on other Gatekeepers is not affected), for as long as its published definition is the one `actionRequestId` was made against: a later revision with another definition goes back through approval. Whoever may approve that call may tick it: the owner, or an operator holding a grant on that Gatekeeper (I14; 403 otherwise). 404 for an Operation not published on that Gatekeeper or a request the caller cannot see; 400 for a request on another gate or action kind, or a high-blast-radius Operation, which is never auto-approved (I8); 409 version_changed when the request was made against a definition other than the one published now.',
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
      'Write a Policy rule: policy = {gatekeeperId?, actionKindTag, blastRadius?, autoApprove, requesterCanApprove?, operationVersion?}. requesterCanApprove omitted keeps the rule’s current value; null clears it (the default: the requester may approve below high). With gatekeeperId the rule covers that Gatekeeper’s action kind; without it, the action kind on every Gatekeeper — such a workspace-wide rule can only require approval (autoApprove: true needs a gatekeeperId, R-20 / D-15). A gate rule wins over the workspace-wide one. The rule names a real Operation: on a gate it must be published there (404 otherwise — except that an existing rule for an Operation the gate no longer publishes may still be rewritten with autoApprove: false, as long as requesterCanApprove is not loosened: not newly set true, and not cleared to null when it is false); workspace-wide some gate must publish one of that name (400 otherwise). autoApprove: true on a gate allows one published definition: operationVersion is required and must be the version published now (409 version_changed when another is); a revision published later goes back through approval.',
  },
  {
    name: 'set_quota',
    group: 'governance',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ key: z.string(), value: z.unknown().optional() }).strict(),
    resultSchema: wire.QuotaWireSchema,
    description:
      'Set an I18 quota (invoke_worker depth, concurrency, token/time, daily cost) or the monthly evaluation budget (evaluation.monthly_cost_budget_usd, a number of USD, never null).',
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
] as const satisfies readonly Capability[];

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

const taskCapabilities = [
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
        input: z.unknown().optional(),
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
    // D-21 (review 2026-10-02, L2-11): kernel `taskVisibleTo` (application/task/service.ts); the
    // owner's view of every Task is the human channel's only (legacy 417).
    description:
      'Read one Task and its WorkerRuns. Visible to the principal the Task acts for, the Task’s ' +
      'own WorkerRun Handle, and the workspace owner in the console (a Handle acting for the ' +
      'owner reads only the owner’s own Tasks); for anyone else it is not found, exactly like an ' +
      'unknown id. An attempt of a goal step also carries the output schema its result is held ' +
      'to (outputSchema), the last report that schema refused (rejectedOutput: the output and ' +
      'each problem’s place) and, when it redoes an attempt that ended without an accepted ' +
      'result, that attempt (reworkOf).',
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
          operation: z.unknown().optional(),
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
      'Post a Worker’s result contract ({summary, output?, findings?, factsToAssert?, evidence?, ' +
      'artifacts?, proposedSkill?, proposedOperations?}) back to the kernel; completes the Task ' +
      '(§7.3 结果契约). The Task of a goal step with an output schema (get_task outputSchema) ' +
      'accepts only a result whose output — a JSON object — meets it: otherwise 400 ' +
      'invalid_params naming each place (details.problems with path and message, ' +
      'details.problemCount), nothing written but the refused report on the Task ' +
      '(rejectedOutput) — fix the output and report again.',
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
] as const satisfies readonly Capability[];

// -------------------------------------------------------------------------------------------
// worker
// -------------------------------------------------------------------------------------------

const workerCapabilities = [
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
    // given, proposes the next version under that existing `id`, which must be a family the
    // caller can see — not found otherwise, as an id nothing has, also when only another
    // principal's drafts carry it (legacy 492: before, an unknown id started a family under it).
    // `kind` is immutable per `id` across versions (enforced by application/worker/definitions.ts,
    // not by this schema alone — a Zod shape has no way to see prior versions).
    paramsSchema: z
      .object({
        definitionId: id.optional(),
        kind: WorkerDefinitionKindSchema,
        definition: jsonRecord,
      })
      .strict(),
    resultSchema: wire.WorkerDefinitionWireSchema,
    description:
      'Propose a private draft WorkerDefinition version: definitionId omitted starts a new family; given, it must name a family you can see (not found otherwise) and the version keeps its kind.',
  },
  {
    // Legacy 145: the platform's entry template against the entry definition the workspace runs
    // with — the read behind the console's "the platform's entry prompt has a new version" notice.
    // Human channel: what the platform ships is the people's decision to adopt, not the agent's.
    name: 'get_entry_template_status',
    group: 'worker',
    mode: 'observe',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z.object({}).strict(),
    resultSchema: wire.EntryTemplateStatusWireSchema,
    description:
      'Compare the entry definition this workspace runs with against the platform’s entry template: the template (its prompt, capabilities and digest), the published entry version, and which template fields it has otherwise.',
  },
  {
    // Legacy 145: a draft, never a change to what runs — publishing it is
    // publish_worker_definition's (the owner, with its credential review). `templateDigest` and
    // `basedOn` are what the caller looked at: a template or entry version changed since is a 409.
    name: 'propose_entry_template_upgrade',
    group: 'worker',
    mode: 'propose',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z
      .object({
        templateDigest: z.string().min(1),
        basedOn: z
          .object({ definitionId: id, version: z.number().int().positive() })
          .strict()
          .nullable(),
      })
      .strict(),
    resultSchema: wire.EntryTemplateUpgradeWireSchema,
    description:
      'Propose your private draft of the next entry definition version: the platform template’s prompt and capabilities over the published version’s own model, egressDeny, name and description. Returns your identical draft instead of a second one. 409 entry_template_current when nothing differs; 409 entry_template_changed when the template or the published entry version is not the one in templateDigest / basedOn.',
  },
  {
    // D-24 (review 2026-10-02) — see publish_operation (meta group) for the rule.
    name: 'publish_worker_definition',
    group: 'worker',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z
      .object({
        definitionId: id,
        version: z.number().int().positive(),
        credentialsReviewed: z.boolean().optional(),
      })
      .strict(),
    resultSchema: wire.WorkerDefinitionWireSchema,
    description:
      'Publish your draft WorkerDefinition version (I12: immutable once published). Builder floor; the workspace owner may publish anyone’s draft, anyone else’s draft reads as not found. What the version names must be there — a worker’s capabilities within the worker ceiling, its gates Gatekeepers of this workspace, its skills published Skills (by id or name), and a model the llm-proxy catalog offers (list_models; 503 when the catalog cannot be read) — 400 unresolved_references (details: unresolved, each field’s values that do not resolve: capabilities, gates, skills, model) otherwise, every one at once, and nothing is published. When the draft carries suspected credentials, credentialsReviewed: true is required — 400 credentials_review_required (details: subject, suspectedSecretValues) otherwise.',
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
      'Discard one of your own private draft WorkerDefinition/Skill/Procedure/OntologyVersion versions (I16), with an optional reason (kept in the audit record). Only the draft’s own proposer may discard it; a published or deprecated version is never deletable through this. A Skill draft being evaluated (start_draft_evaluation) is 409 draft_evaluating until its evaluation ends or is cancelled.',
  },
  {
    // E2-0b (review #493 on #764, F2): the reviewer's transition beside `discard_draft` — a pending
    // Skill / Procedure draft blocks its family's next version (409 `draft_pending`), and only its
    // proposer may discard it. Rejecting takes it off the family (the row is deleted, like discard
    // and expiry) with a reason the AuditRecord keeps. Human channel only: an agent cannot reject.
    // `draftDigest` names the draft reviewed, as publish_skill / publish_procedure do.
    name: 'reject_draft',
    group: 'worker',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    paramsSchema: z
      .object({
        kind: RejectableDraftKindSchema,
        id: id,
        version: z.number().int().positive(),
        draftDigest: z.string().min(1),
        reason: z.string().trim().min(1).max(500),
      })
      .strict(),
    resultSchema: wire.RejectDraftResultWireSchema,
    description:
      'Reject a pending draft Skill / Procedure version (kind skill or procedure) so the family’s next version can be proposed again: the draft is deleted and the reason (required, kept in the audit record and shown to the draft’s proposer by list_draft_rejections) says why. Only the workspace owner or the proposer of the family’s version in use (its latest published version) may reject — anyone else is 403 not_proposer, and a family with no published version is the owner’s; the draft’s own proposer discards it instead (discard_draft). draftDigest is the draftDigest list_skills / get_skill / list_procedures gave for that draft: another draft under the same version since is 409 draft_changed. A version that is not a draft is 409 not_a_draft; a Skill draft being evaluated (start_draft_evaluation) is 409 draft_evaluating until its evaluation ends or is cancelled. Nothing is written when refused.',
  },
  {
    // Legacy 491: a rejection reaches the draft's proposer — the person, also for a draft an agent
    // proposed (its `proposedBy` is the person the Handle acted for). Only the caller's own; human
    // channel, as the rejection itself; `member`, since a member's Worker proposes Skills in their
    // name.
    name: 'list_draft_rejections',
    group: 'worker',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ kind: RejectableDraftKindSchema.optional() }).strict(),
    resultSchema: wire.ListDraftRejectionsResultWireSchema,
    description:
      'The Skill / Procedure drafts you proposed that a reviewer rejected (reject_draft), newest first (the latest 50): which family, version and name, who rejected it, when, and the reason they gave. kind narrows to skill or procedure. Only your own — also those an agent proposed on your behalf.',
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
] as const satisfies readonly Capability[];

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

const ingestCapabilities = [
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
] as const satisfies readonly Capability[];

// -------------------------------------------------------------------------------------------
// audit
// -------------------------------------------------------------------------------------------

const auditCapabilities = [
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
] as const satisfies readonly Capability[];

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

const membersCapabilities = [
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
] as const satisfies readonly Capability[];

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

const agentProfileCapabilities = [
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
] as const satisfies readonly Capability[];

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

const platformCapabilities = [
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
    // S11 P1-F: the templates `create_gate_instance`'s `preset` takes.
    name: 'list_connector_presets',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.ConnectorPresetWireSchema),
    description:
      'S11 P1-F: the connector presets this deployment ships — for each system a template of a gate-host instance (transport, credential mode, the Operations it announces), with no address and no credential. `packagedConnector` says the system is already connected through a packaged gate here, so no preset instance can join it; `instanceCount` counts the instances its connector already holds.',
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
        /** S11 P1-F: create it from this connector preset (`list_connector_presets`). The preset
         *  fixes the transport kind, the credential mode, the Operations and the connector (its
         *  name), so `transportKind`, `credentialMode`, `manifestSource` and `connector` are left
         *  out; only `target` is typed. An unknown name refuses 404 `connector_preset_not_found`. */
        preset: z.string().regex(wire.CONNECTOR_NAME_PATTERN).optional(),
        /** Required without `preset`. */
        transportKind: z.enum(['http', 'mcp']).optional(),
        target: z.string().url().max(2000),
        /** Required without `preset`. */
        credentialMode: z.enum(['shared', 'connected_account']).optional(),
        /** http: the OpenAPI document URL the host imports Operations from (required without `preset` — without it the instance would have no Operations). mcp: omitted, tools are listed on the target. */
        manifestSource: z.string().url().max(2000).nullable().optional(),
        /** P1: the connector (接入包) the instance belongs to, named after the system it serves.
         *  Omitted: the generic connector of its transport kind (`http` / `mcp`), whose mode also
         *  decides whether workspaces may connect that kind themselves (R-40). A name no connector
         *  carries yet creates one for this kind, `platform_preset`, so the instance reaches the
         *  catalog once enabled without touching the generic one; an existing one must be of the
         *  same kind (409 `connector_kind_mismatch`) and not a packaged gate's (409
         *  `connector_packaged`). */
        connector: z.string().regex(wire.CONNECTOR_NAME_PATTERN).optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.preset !== undefined) {
          for (const key of [
            'transportKind',
            'credentialMode',
            'manifestSource',
            'connector',
          ] as const) {
            if (value[key] !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [key],
                message: `the preset fixes ${key}; leave it out`,
              });
            }
          }
          return;
        }
        for (const key of ['transportKind', 'credentialMode'] as const) {
          if (value[key] === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `${key} is required without a preset`,
            });
          }
        }
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
      'P-B2a: create a generic http / mcp gate instance for the platform gate host to serve. Lands `discovered` with no heartbeat; the host pulls the definition, imports the Operations and announces it, then the administrator enables it exactly like a packaged gate. P1: `connector` names the system it serves; omitted, it joins the generic connector of its kind. S11 P1-F: `preset` creates it from a connector preset instead — only `target` is typed, the host builds it from the preset’s Operations, and it joins the preset’s connector (409 `connector_packaged` when a packaged gate holds that name). Never takes a credential — enter that via `issue_gate_host_token`.',
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
  // P0b (S10 W2; STATUS leftover 118 remainder ①): the gates workspaces connected themselves, and
  // the platform's per-connection cut-off for them. The catalog's cut-off stays the connector deny
  // list (`set_connector_mode`) — a self connection is not a gate instance, so it gets its own.
  {
    name: 'list_self_connections',
    group: 'platform',
    mode: 'observe',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        connector: z.string().min(1).max(64).optional(),
        workspaceId: z.guid().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.SelfConnectionWireSchema),
    description:
      'Every gate a workspace connected itself (create_connection), newest first: workspace, connector, target and endpoint (scheme, host and port only — the path, query and fragment stay in the workspace’s own views), who connected it and when, and whether the platform suspended it. catalogGateId flags one whose address is a platform gate instance’s.',
  },
  {
    name: 'suspend_self_connection',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z
      .object({
        workspaceId: z.guid(),
        gatekeeperId: z.guid(),
        reason: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    resultSchema: wire.SelfConnectionWireSchema,
    description:
      'Cut off a gate a workspace connected itself: from the next call on, every Operation of it is refused as disabled by the platform — request_action, observe, queued executions and the agent’s tool list alike — and the workspace’s entry-agent Handles are re-issued. The connection, its Operations and its history stay; resume_self_connection lifts it. The workspace cannot lift it, delete it or connect the same address again meanwhile — another spelling of it included (scheme and host case, a trailing dot, the default port, user info, trailing slashes, an IDN host and its punycode, percent-encoding). The suspension is this one connection’s: the gate reached under another host name or IP is a new connection; to stop workspaces connecting gates of a kind themselves, take that kind’s connector out of self_serve (set_connector_mode). Suspending a suspended one changes nothing.',
  },
  {
    name: 'resume_self_connection',
    group: 'platform',
    mode: 'write',
    channel: 'human',
    scope: 'platform',
    paramsSchema: z.object({ workspaceId: z.guid(), gatekeeperId: z.guid() }).strict(),
    resultSchema: wire.SelfConnectionWireSchema,
    description:
      'Lift the platform’s suspension of a self-connected gate: its published Operations run again from the next call, and the workspace’s entry-agent Handles are re-issued. Resuming one that is not suspended changes nothing.',
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
      'Sets the platform’s active runtime image (must already appear in `list_runtime_images`, be allowlisted, and not be `runtimeCompatible: false` — 409 `runtime_image_incompatible`, since worker-supervisor would refuse to start anything from it) — resident entry containers pick it up at their own next spawn (spec-drift rebuild, E2); no forced restart. Audited.',
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
      'Switches the active runtime image back to the most recent `platform_settings_history` value that differs from the current one — an intervening unrelated settings write (e.g. siteName) is skipped over, not treated as "the previous value". Calling this repeatedly toggles between the last two distinct images. Refused (409 `runtime_image_incompatible`) when that image is known to be one worker-supervisor would refuse to start anything from. Audited.',
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
      'Acceleration only (E2): stops resident entry containers that both need rebuild and have no in-flight Turn (kernel’s own `activities` bookkeeping) — never a forced stop of a busy container, never a draining/reject-new-Turn state. Every stopped container is recreated with the active image at its own next spawn regardless of whether this was ever called. Refused (409 `runtime_image_incompatible`) while the active image is one worker-supervisor would refuse to start anything from.',
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
      'S10 U1: what is newer than this deployment — newer platform releases (migrations crossed, breaking, the exact host commands — the target tag’s own `apply-release.sh --prefetch` before the maintenance window, then `--pull` in it — the rollback release) and the latest upstream pi with the nightly drift check’s verdict — read from the ReleaseChannel record the host’s update-feed service downloads (the kernel itself never goes online). Validates the file on every read (schema, 64 KiB cap); reports how fresh it is. Reminder only: nothing here upgrades anything.',
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
  // (its packs with one ontology component), aggregated across workspaces, plus which install by default into a
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
      'Every module this deployment ships (a pack with one ontology component, `packs/`), with its version list and how many workspaces have it installed / are behind the latest version.',
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
      'Set the module family names `create_workspace` installs (each at its own latest version) into every new workspace. Every name must already be in `list_modules` — an unknown name 400s rather than being silently kept.',
  },
] as const satisfies readonly Capability[];

// -------------------------------------------------------------------------------------------
// modules, workspace half (P-B2b, docs/platform-admin-design.md §6.4; docs/development-tasks.md
// §5d S7-D 决定 D1–D4): `list_workspace_modules` / `install_module` / `upgrade_module` — the
// owner's 能力目录 模块 tab (P-B2 决定 ①: install/upgrade is `scope:'workspace'`, owner — same
// rule `enable_gate_instance` already follows for the analogous "enable a platform-catalog thing
// into my own workspace" action). The platform-scope half (`list_modules`/`set_default_modules`)
// is in `platformCapabilities` above, `group: 'platform'` (`assertRegistryConsistent`'s own
// invariant: every `scope:'platform'` capability must be `group:'platform'`, and vice versa).
// -------------------------------------------------------------------------------------------

/** `preview_pack_install` / `install_pack` `workerGates` (S11 P1-E2): by Worker name, the gates the
 *  owner kept for a Worker the install binds — a subset of its binding's `candidates` (400
 *  invalid_params otherwise). A Worker not named is bound to every candidate; an empty list keeps
 *  none and is recorded (`gates: []`). A Worker whose head already has gates keeps them whatever
 *  is passed (`binding.source: 'workspace'`). */
const PackWorkerGatesParamSchema = z.record(z.string().min(1), z.array(id));

const modulesCapabilities = [
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
        /** Required when the module is currently `customized`, or any version between the
         *  current one and the latest is `breaking` (400 `module_confirm_required` otherwise, with
         *  the exact versions in `details`). */
        confirm: z.boolean().optional(),
        /** Legacy 300: the version the owner was shown as the target (`latestVersion` of
         *  `list_workspace_modules`) — 409 `version_changed` when the latest is another one. */
        version: z.number().int().positive(),
      })
      .strict(),
    resultSchema: wire.WorkspaceModuleWireSchema,
    description:
      'Install a module into this workspace — publishes its latest `OntologyDefinition` (the same mechanism `seed-domain-pack` uses) with this owner as `proposed_by`/`published_by`. version is the latestVersion the owner was shown: when the latest version is another one now (an upgrade shipped a newer pack version), 409 version_changed and nothing is published. Already installed → identical to `upgrade_module` (same underlying call, D3). An ObjectType or ActionType name another installed ontology family already declares refuses 409 ontology_namespace_conflict (I-P1). Applied as a ChangePlan segment: one `change_item.apply` audit row records the module version and the ontology version before and after. A module whose content widens authority (an ActionType added, removed or loosened) refuses 400 change_confirmation_required whatever confirm says — this capability takes no per-item confirmation.',
  },
  {
    name: 'upgrade_module',
    group: 'modules',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        name: z.string().min(1),
        confirm: z.boolean().optional(),
        version: z.number().int().positive(), // Legacy 300 — see install_module.
      })
      .strict(),
    resultSchema: wire.WorkspaceModuleWireSchema,
    description:
      'Advance this workspace’s installed module directly to its latest version (one publish, never stepping through intermediate versions). version is the latestVersion the owner was shown — 409 version_changed when the latest is another one now, nothing published. Not installed yet → identical to `install_module` (same underlying call, D3). Already at the latest content → a no-op returning the current state (never wastes a version number). An ObjectType or ActionType name another installed ontology family already declares refuses 409 ontology_namespace_conflict (I-P1). Applied as a ChangePlan segment, like `install_module`; an authority-widening change refuses 400 change_confirmation_required whatever confirm says.',
  },
  // S11 P1-B (docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.4, §5.4;
  // `application/change-plan`): the workspace's applied ChangePlan segments — every module install
  // or upgrade since P1 is one — read, dry-run a rollback, roll back. Workspace scope only: a
  // segment's contents are read in its own workspace (§5.4 "工作区段的内容只在该工作区可见").
  {
    name: 'list_change_segments',
    group: 'modules',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        /** Only segments from this source (a pack / module name). */
        sourceName: z.string().min(1).optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.ChangeSegmentWireSchema),
    description:
      'The ChangePlan segments applied to this workspace (each pack or module install or upgrade since the ChangePlan core is one), newest first: source, who applied it and how (human / platform), status, rollback; keyset-paginated (limit, cursor → nextCursor).',
  },
  {
    name: 'get_change_segment',
    group: 'modules',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ segmentId: z.guid() }).strict(),
    resultSchema: wire.ChangeSegmentDetailWireSchema,
    description:
      'One applied ChangePlan segment with its items in order — a version of an ontology family, a Skill or a Worker (WorkerDefinition) published, or a revision of an Operation’s governance (its description, risk level, auto-approval, wait-for-decision, reads and writes — never what the gate runs): each item’s target, state before and after (for an Operation, the fields it changed), authority classification and who confirmed it, and whether what it wrote is still in effect now; and its latest verification (verify_change_segment), null when never verified. 404 change_segment_not_found.',
  },
  {
    name: 'preview_roll_back_change_segment',
    group: 'modules',
    mode: 'observe',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ segmentId: z.guid() }).strict(),
    resultSchema: wire.ChangeRollbackPreviewWireSchema,
    description:
      'Dry run of roll_back_change_segment, writing nothing: per item (in reverse order) the state it would return to, the rollback’s own authority classification, the ontology types it takes out, and why it cannot be rolled back now (changed again since — roll that change back first —, gone, or a type name another family has taken); plus how many objects and active Facts use the types taken out (kept, never removed). 404 change_segment_not_found.',
  },
  {
    name: 'roll_back_change_segment',
    group: 'modules',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        segmentId: z.guid(),
        /** The ordinals of the rollback items `preview_roll_back_change_segment` classifies
         *  `authority_widening`, each confirmed by the person rolling back (I-A4) — a person
         *  only: from a service Principal, 403. */
        confirmedOrdinals: z.array(z.number().int().positive()).optional(),
      })
      .strict(),
    resultSchema: wire.ChangeSegmentWireSchema,
    description:
      'Roll back one applied ChangePlan segment in one transaction: each item, last first, is compared with what is there now and returned to its state before (an item retires the version it published — of an ontology family, a Skill or a Worker — so the family’s head is the one before it again, or the family is no longer installed; an Operation revision is followed by a further version with the content it replaced, since a retired Operation version is never published again; objects and Facts already written stay). Refuses, writing nothing: 409 change_rollback_conflict when an item cannot be rolled back now — its target changed after it (details.items names the later segment to roll back first), is no longer installed, what it restores is gone, it would restore a type name another family has taken, or an Operation it revised has a revision draft under review —, 409 change_segment_rolled_back when it already was, 400 change_confirmation_required when an authority-widening rollback item is not among confirmedOrdinals, 403 when confirmedOrdinals comes from a Principal that is not a person (a service API key), 404 change_segment_not_found. One change_item.roll_back audit row per item.',
  },
  {
    name: 'verify_change_segment',
    group: 'modules',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ segmentId: z.guid() }).strict(),
    resultSchema: wire.ChangeVerificationResultWireSchema,
    description:
      'Verify one applied ChangePlan segment now and record the result on it (S11 P1-E): whether what each item wrote is still in effect, and whether each system its source needs (a pack version’s requiredConnectors) is connected in this workspace — with each of its gates’ live health, probed through the gate’s own health endpoint, the probe get_gatekeeper makes; no Operation is run — and (S11 P1-F) whether each pack it builds on (requiredPacks) is still installed here at the version it needs (dependencies). Passes when every item is in effect, every needed system is connected with at least one healthy gate, every pack it builds on is installed at that version or later, and the source version is still in this deployment; the segment becomes verified or verification_failed. One change_segment.verify audit row. Refuses, probing and writing nothing: 409 change_segment_superseded when a later segment of the same source is in effect (details.supersededBy — verify that one), 409 change_segment_rolled_back, 429 change_verification_cooldown within 60 seconds of the segment’s last verification (details.retryAfterSeconds), 404 change_segment_not_found.',
  },
  // S11 P1-C / P1-D (Pack Contract v1, docs/s10-evolution-plan-2026-10-04.md §6;
  // `application/packs`): the packs this deployment ships — ontology families, Skills and `worker`
  // WorkerDefinitions —, this workspace's state of each — derived from its components, nothing
  // stored — and installing one as a ChangePlan segment the owner reviews first (I-A8: the dry
  // run's digest; I-A4: each authority-widening item confirmed by itself). A module is a pack with
  // one ontology component; the module capabilities above keep their own contract.
  {
    name: 'list_packs',
    group: 'modules',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    paramsSchema: noParams,
    resultSchema: listEnvelope(wire.PackWireSchema),
    description:
      'Every pack this deployment ships (Pack Contract v1, `packs/<name>/<version>/pack.yaml`) with its versions and components — ontology families, Skills and Workers (WorkerDefinitions) —, and this workspace’s state of it — not installed / up to date / outdated / customized — for the pack and for each component, with the change that installed each component’s current content; and the systems the latest version needs (requiredConnectors), each with where it stands here — connected (with the workspace’s gates on it) / an instance the platform offers to enable (with the instances) / needs a platform administrator — read without contacting any gate. Each Worker component carries the systems it acts on, the gates its published head may act on, and whether installing again would bind it (bindable: installed, no gates yet, a gate of one of its systems connected now). S11 P1-F: the packs the latest version builds on (requiredPacks), each in dependencies with how this workspace has it and whether that meets the version it needs.',
  },
  {
    name: 'preview_pack_install',
    group: 'modules',
    mode: 'observe',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        name: z.string().min(1),
        workerGates: PackWorkerGatesParamSchema.optional(),
      })
      .strict(),
    resultSchema: wire.PackInstallPreviewWireSchema,
    description:
      'Dry run of install_pack, writing nothing: per component of the latest version, what the family has now and would have after — for an ontology family the type names added / removed / changed, for a Skill or Worker the content it would publish and the fields that differ —, and the item’s authority classification; the versions the install moves through and whether one is breaking; how many objects and active Facts use a type it takes out (kept, never removed); and the digest to pass back as reviewedDigest. The systems the version needs are in pack.requirements: installing does not wait for them. The packs it builds on are in pack.dependencies: installing does wait for those (install_pack 409 pack_dependency_unmet); the dry run still answers while one is missing. A Worker’s gates and model are the workspace’s own: each Worker item keeps what its head has (binding.source workspace), and a Worker that names systems and has no gates yet is bound to the workspace’s connected gates of those systems (binding.source install, an authority_widening item) — every candidate unless workerGates keeps fewer; keeping none publishes gates: [] (binding.source none), so the Worker is no longer offered for binding; a Worker whose head has gates keeps them whatever workerGates says. 400 invalid_params when workerGates names a Worker the version does not have or a gate that is not one of its candidates; 404 pack_not_found; 409 ontology_namespace_conflict when a component declares an ObjectType or ActionType name another installed family already declares (I-P1); 409 skill_name_conflict when another Skill family already has a Skill component’s name published.',
  },
  {
    name: 'install_pack',
    group: 'modules',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z
      .object({
        name: z.string().min(1),
        /** The pack version the owner reviewed (`preview_pack_install`'s `targetVersion`). */
        version: z.number().int().positive(),
        /** The dry run's `digest` (I-A8). */
        reviewedDigest: z.string().min(1),
        /** The ordinals of the items the dry run classifies `authority_widening`, each confirmed
         *  by the person installing (I-A4) — a person only: from a service Principal, 403. */
        confirmedOrdinals: z.array(z.number().int().positive()).optional(),
        /** The gates the owner kept for a Worker the install binds — the dry run's own
         *  `workerGates`, since it is part of what the digest covers. */
        workerGates: PackWorkerGatesParamSchema.optional(),
      })
      .strict(),
    resultSchema: wire.PackInstallResultWireSchema,
    description:
      'Install a pack’s latest version into this workspace in one transaction, as one ChangePlan segment: each component whose content differs is published as its family’s next version — an ontology family, a Skill, a Worker (WorkerDefinition) — with this owner as proposer and publisher (installing, upgrading, or replacing a customized family alike — the dry run showed which); a Worker keeps the gates and model its head has, and one the dry run binds is bound to the gates it showed (pass the dry run’s own workerGates). Refuses, writing nothing: 409 version_changed when the latest version is not the reviewed one, 409 pack_dependency_unmet when a pack it builds on (requires.packs) is not installed here at the version it needs — details.unmet lists each, install those first —, 409 change_plan_changed when the dry run would differ from the reviewed digest now — a gate connected or cut off since counts (preview again), 400 invalid_params for workerGates as in preview_pack_install, 400 change_confirmation_required when an authority-widening item is not among confirmedOrdinals, 403 when confirmedOrdinals comes from a Principal that is not a person (a service API key), 409 ontology_namespace_conflict (I-P1), 409 skill_name_conflict, 404 pack_not_found. Already up to date: records nothing. One change_item.apply audit row per item. Right after the install commits, the segment is verified once as the person who installed (trigger system, as verify_change_segment does; its result is verification — null when the run could not be made, the install stands either way).',
  },
] as const satisfies readonly Capability[];

// -------------------------------------------------------------------------------------------
// goal (S11 GO5a; plan §4.3, §7) — reading GoalRuns. Visible to the workspace owner and the
// requester (the principal the run acts for, `onBehalfOf`); for anyone else a run is not found,
// exactly like an unknown id — the rule `get_task` applies (kernel `goalVisibleTo`). The owner sees
// every run on the human channel only: on the handle channel the viewer is the Handle's `obo`, who
// reads their own runs, an owner too (looking across the workspace is a person's, in the
// console — coordinator decision on review #493 of #680). The entry ceiling holds the four reads
// and `propose_goal` (S11 GO5c), no Worker's does: a step's Worker never proposes or reads goals
// (governance/capability/handles.ts). Each result is the one `wire/goal.ts` shape the console's
// goal pages (GO6) render.
//
// S11 GO5c — `propose_goal`: a goal, its plan v1 and budget, proposed for the caller (on a Handle,
// its obo) to confirm — the entry agent's way to start one, or a person's own. Nothing runs until
// the requester confirms it (`confirm_goal`, human channel): a GoalRun spends and acts while nobody
// watches (propose → authorize → execute). The budget is the proposal's and the confirmation
// cannot change it: what the card shows is what is confirmed.
//
// S11 GO5b — a person's operations on a run, human channel only (HUMAN_ONLY_CAPABILITY_NAMES; no
// Handle ceiling may ever carry them, scripts/check-membership-capabilities-not-in-handle-scope.sh):
// the requester's decisions — confirm, resume, revise, confirm the acceptance, end with an outcome,
// run an action again — and the stops the workspace owner may make too — reject a proposal, pause
// (on someone else's run: a hold), cancel, record what was found about an action — plus the owner's
// lifting of a hold. Who decides is the authenticated caller, role included, never a param (legacy
// 389): the database's guards do not know the role. A run the caller cannot read is 404 not_found,
// like `get_goal`; one they can read but may not act on this way is 403 forbidden; one whose state
// does not allow the call now is 409 illegal_transition. A call that finds the run where it asks
// for changes nothing (`changed: false`) — `confirm_goal` too: the revision it confirms is decided
// once (scenario S3, no idempotency key needed). Stopping is `write`, like `cancel_task`; a
// decision that lets the run spend and act, or records a person's Decision, is `execute`.
// -------------------------------------------------------------------------------------------

/** `list_goals`' page size when `limit` is absent, and its ceiling. */
export const GOAL_LIST_DEFAULT_LIMIT = 50;
export const GOAL_LIST_MAX_LIMIT = 200;

const goalRunId = z.guid();
const goalNote = z.string().max(MAX_GOAL_NOTE_CHARS).optional();
const GOAL_OPERATION_REFUSALS =
  ' Who cannot read the run gets 404 not_found (like get_goal); who can but may not do this, 403 forbidden.';
const GOAL_NOTE_RULE = `note (at most ${MAX_GOAL_NOTE_CHARS} characters) is kept with the Decision as written — refused when it carries a suspected credential (400 credentials_in_text).`;

const goalCapabilities = [
  {
    name: 'get_goal',
    group: 'goal',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ goalRunId: z.guid() }).strict(),
    resultSchema: wire.GoalDetailWireSchema,
    description:
      'Read one GoalRun: its status and budget with what it has spent, the plan revision in force (revision 1 until it is confirmed) with the suspected credentials in its parameters (step inputs, reconcile and observation params) redacted, its revision history, every StepRun with its attempts (the Tasks: each with why it failed, whether it redid one that ended without an accepted result, and the places its last refused output broke the step’s output schema), the output of its current attempt and its actions (the ActionRequests), its acceptance rounds, for each absence check (observe_absent) the platform’s look with the same call before the work it judges — before the first step, or for a check a revision added or re-called, before the run went on (absenceBaselines: pending, seen_present — only then can the check pass —, never_seen_present or unavailable, which pause the run for the requester, or superseded), and — while cancelling, or cancelled with cleanupPending — the Tasks and executing actions left. Visible to the workspace owner and the requester; for anyone else it is not found (404 not_found), exactly like an unknown id. A Handle reads as its obo, and only that principal’s own runs — an owner’s too.',
  },
  {
    name: 'list_goals',
    group: 'goal',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z
      .object({
        status: z.array(GoalRunStatusSchema).min(1).optional(),
        onBehalfOf: z.guid().optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.GoalRunWireSchema),
    description: `List GoalRuns, newest first, each with its budget, usage and StepRuns counted by status: the workspace owner sees every run, anyone else — and a Handle, whoever its obo — only the runs they requested; onBehalfOf filters by requester (for anyone who sees only their own, any other requester lists nothing), status by status. Keyset-paginated (limit, default ${GOAL_LIST_DEFAULT_LIMIT}, at most ${GOAL_LIST_MAX_LIMIT}; cursor → nextCursor; truncated when limit was above the ceiling).`,
  },
  {
    name: 'get_goal_revision',
    group: 'goal',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ goalRunId: z.guid(), revision: z.number().int().positive() }).strict(),
    resultSchema: wire.PlanRevisionWireSchema,
    description:
      'Read one revision of a GoalRun’s plan — the plan as that revision holds it (the suspected credentials in its parameters redacted), who made it and why, what it decided about the steps it removed, and its hints. Same visibility as get_goal; an unknown revision is 404 not_found too.',
  },
  {
    name: 'list_goal_unresolved_actions',
    group: 'goal',
    mode: 'observe',
    channel: 'handle',
    minRole: 'member',
    paramsSchema: z.object({ goalRunId: z.guid() }).strict(),
    resultSchema: listEnvelope(wire.UnresolvedGoalActionWireSchema),
    description:
      'List the actions of a GoalRun whose outcome is unknown and that still need a person — a finding (did it take effect?) or, found not to have, a decision (run it again or change the plan) — with the platform’s own check of each where its step declared one. Every step counts, revised-away and cancelled ones included. Same visibility as get_goal.',
  },
  {
    name: 'propose_goal',
    group: 'goal',
    mode: 'propose',
    channel: 'handle',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z
      .object({
        statement: z.string().max(MAX_GOAL_STATEMENT_CHARS).regex(/\S/, 'says nothing'),
        plan: GoalPlanSchema.optional(),
        // S11 GO5d-2 (plan §4.3): the plan made from a published Procedure instead of written out
        // (`application/goal/from-procedure.ts`) — exactly one of the two.
        fromProcedure: GoalFromProcedureSchema.optional(),
        budget: GoalBudgetSchema,
        idempotencyKey: z.string().min(1).max(MAX_GOAL_IDEMPOTENCY_KEY_CHARS).optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if ((value.plan === undefined) === (value.fromProcedure === undefined)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [value.plan === undefined ? 'plan' : 'fromProcedure'],
            message: 'give exactly one of plan and fromProcedure',
          });
        }
      }),
    resultSchema: wire.ProposeGoalResultWireSchema,
    description: `Propose a goal for you (on a Handle, the person you act for) to confirm — for a chain of delegated steps that has to go on without this conversation: a later step needs an earlier one's result, or can start only once an earlier step (or the approval it waits on) has finished. One delegated task stays invoke_worker, even a write that needs an approval, one that spans several gates or one that runs long: the approval flow handles its approval and its result comes back in a later turn. Prefer acceptance checks the platform makes and the person can read — an observe_predicate (an observe Operation and a predicate on what it returns), an observe_absent (an observe Operation that declares which answers mean "not there", met only when the gate answers the call that way — for a goal that deletes or removes something, its params naming exactly what the goal removes: before any step starts the platform makes the same call, and a thing already not there, or a call the platform cannot make, pauses the goal for the person) or a fact_predicate (a Fact of the graph a gate or a collector records, observed again after the check starts — never one this goal's own steps produced), each able to come out false; a requester_confirm check is only the person's word. The proposal: statement — what is wanted, in a sentence or two (at most ${MAX_GOAL_STATEMENT_CHARS} characters) — the plan, revision 1 — written out (plan: its steps, each a published Worker version, their dependencies, inputs and checks — a step may declare the output its Worker reports (outputSchema) and take input fields from earlier steps' outputs (bindings: to, from a step it depends on that declares an outputSchema, a JMESPath path) — and the acceptance checks of the goal) or made from a published Procedure (fromProcedure: procedureId, version — its latest published version when absent — and the parameters its parameters schema asks for: its worker steps become the plan's steps, each after the one before unless it says otherwise, its $params bindings filled in from the parameters, and its verify steps the goal's acceptance checks — the platform makes a check a verify step carries, and the requester confirms the others; a Procedure with an operation or approval step makes no plan), exactly one of the two — and the budget (tokens, step attempts, revisions, wall-clock seconds from confirmation). Nothing runs until the requester confirms it in the console (confirm_goal); the budget cannot be changed there — propose again to change it. The requester must be a person: a call for a service or agent Principal is refused (403). A requester has at most a deployment-set number of goals waiting to be confirmed or rejected (5 unless configured): one more is refused, nothing written (409 proposed_goal_limit with details.limit and details.proposed) — ask them to confirm or reject one first; a retry of a run already proposed is still answered. The plan is checked (400 invalid_params with details.problems — for fromProcedure, also an unknown or unpublished Procedure, parameters its schema refuses at fromProcedure.parameters.<field>, and a step it cannot make); a plan made from a Procedure is checked exactly like one written out, and the revision records the Procedure (fromProcedure on get_goal and get_goal_revision). The statement, the plan and the parameters must not carry credentials — refused, nothing written (400 credentials_in_text with details.field and, for the plan, details.suspectedSecretPaths: a gate authenticates with the credentials configured on it), nor the [redacted] mark a read shows where one stood (400 redacted_text_submitted with details.field and, for the plan, details.paths). Plan places read plan.steps.<i>.input.<field>, plan.acceptance.<i>.prompt and so on, i from 0. The result's hints say what the person confirming should know: a plan the platform checks nothing of, and any step the requester could not start now (a gate they cannot act on, a capability they do not hold, a Worker their profile excludes). idempotencyKey: the same key returns the run it first proposed, whatever its status (changed: false); without one, the same statement, plan (or fromProcedure) and budget from the same session return the run still proposed.`,
  },
  {
    name: 'confirm_goal',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        goalRunId,
        revision: z.number().int().positive(),
        /** S11 GO9a: what the goal planner may do when a step fails for a person (`propose`). */
        planner: GoalPlannerModeSchema.optional(),
      })
      .strict(),
    resultSchema: wire.ConfirmGoalResultWireSchema,
    description: `Confirm a proposed GoalRun — the requester alone, on the revision they read (its proposal, revision 1): the plan is checked again (400 invalid_params with details.problems when it no longer passes, e.g. a WorkerDefinition deprecated since), accepted and put in force; the run starts with every step pending, and from then on spends and acts with the requester’s authority. planner: 'propose' lets the workspace's goal planner propose a revision whenever a step fails in a way that pauses the run for the requester (its contract still broken after a rework, a transient failure past its attempts, an action refused, a verification failed): the planner acts for the requester, observes nothing, does nothing but propose, and its tokens count against the goal's budget; what it proposes waits for the requester (decide_plan_revision). Given once, with the confirmation; absent: no planner. Sent again once confirmed, it changes nothing (changed: false). 409 illegal_transition when the run is no longer proposed or the revision is not its proposal.${GOAL_OPERATION_REFUSALS}`,
  },
  {
    name: 'reject_goal',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ goalRunId, revision: z.number().int().positive() }).strict(),
    resultSchema: wire.GoalOperationResultWireSchema,
    description: `Turn a proposed GoalRun down — the requester, or the workspace owner — on the revision they read (revision 1): the proposal is rejected and the run cancelled; it never ran. Sent again, it changes nothing. 409 illegal_transition once the run was confirmed (cancel it instead).${GOAL_OPERATION_REFUSALS}`,
  },
  {
    name: 'pause_goal',
    group: 'goal',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ goalRunId }).strict(),
    resultSchema: wire.GoalOperationResultWireSchema,
    description: `Pause a running or verifying GoalRun — the requester, or the workspace owner: no new step attempt starts; attempts already running finish and are recorded, their requests still decided and run (cancel stops those). The owner pausing someone else’s run holds it: its requester cannot resume it until an owner lifts the hold (release_goal_hold); an owner pausing someone else’s run that is already paused places the hold. Already paused: changes nothing. 409 illegal_transition from any other status.${GOAL_OPERATION_REFUSALS}`,
  },
  {
    name: 'resume_goal',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        goalRunId,
        /** Failed steps to send back to `ready`, each by key — there is no "retry all". */
        retrySteps: z.array(StepKeySchema).min(1).max(MAX_PLAN_STEPS).optional(),
      })
      .strict(),
    resultSchema: wire.ResumeGoalResultWireSchema,
    description: `Resume a paused GoalRun — the requester alone, and not while the workspace owner holds it (409 illegal_transition until release_goal_hold): it is due at once, its budget and plan checked again. retrySteps lists failed steps to send back to ready, each by key (there is no "retry all"), each only with no request of it in flight or of unknown outcome, none of its Tasks running, and still in the current plan (409 illegal_transition otherwise); a failed step not listed stays failed. Resuming ends the goal planner's work on the pause: a planning round still running is abandoned and its Task stopped, and a revision it proposed and nobody decided is rejected. Already running, with no retrySteps: changes nothing.${GOAL_OPERATION_REFUSALS}`,
  },
  {
    name: 'cancel_goal',
    group: 'goal',
    mode: 'write',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ goalRunId }).strict(),
    resultSchema: wire.CancelGoalResultWireSchema,
    description: `Cancel a GoalRun — the requester, or the workspace owner: in one transaction every step not yet ended is cancelled, every request of its steps not yet started is withdrawn, and the goal planner's work ends (a running round abandoned, a proposal nobody decided rejected); the run is cancelling until its Tasks are terminated and its executing requests have ended. Already cancelling or cancelled: changes nothing. A proposed run is rejected (reject_goal), not cancelled, and an ended one is 409 illegal_transition.${GOAL_OPERATION_REFUSALS}`,
  },
  {
    name: 'release_goal_hold',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'owner',
    paramsSchema: z.object({ goalRunId }).strict(),
    resultSchema: wire.GoalOperationResultWireSchema,
    description:
      'Lift the workspace owner’s hold on a paused GoalRun — a workspace owner only. The run stays paused, for its requester to resume, revise or cancel. A run nobody holds: changes nothing.',
  },
  {
    name: 'revise_goal',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        goalRunId,
        /** The revision the new plan was made from — the run's current one (I-G3). */
        basedOnRevision: z.number().int().positive(),
        plan: GoalPlanSchema,
        reason: z.string().max(MAX_REVISION_REASON_CHARS).optional(),
        /** A new budget, in force with the revision; the current one when absent. */
        budget: GoalBudgetSchema.optional(),
        /** Per step the revision removes: `terminate` (the default) or `let_finish`, releasing the
         *  listed requests of a step let to finish. */
        removals: StepRemovalsSchema.optional(),
      })
      .strict(),
    resultSchema: wire.ReviseGoalResultWireSchema,
    description: `Revise the plan of a paused GoalRun — the requester alone — based on its current revision (409 illegal_transition when another was accepted since, I-G3) and within its revision budget, or the budget the revision brings: the new plan is checked (400 invalid_params with details.problems), accepted and in force at once. Every live step it drops or changes is superseded (removals, per step: terminate — the default — or let_finish, releasing listed requests), every new or changed key gets a pending StepRun, and the superseded steps’ requests not yet started are withdrawn. A revision the goal planner proposed and nobody decided is rejected, and a planning round still running is abandoned. The run stays paused for the requester to resume. reason (at most ${MAX_REVISION_REASON_CHARS} characters) is shown on the revision as written. The plan and the reason must not carry credentials — refused, nothing written (400 credentials_in_text with details.field and, for the plan, details.suspectedSecretPaths) — nor the [redacted] mark a read shows where one stood (400 redacted_text_submitted with details.field and, for the plan, details.paths): write that part again. A call sent exactly as get_goal_revision shows it is unchanged: it keeps what is stored (a masked value, an invisible character shown as \\u{XXXX}), and only what is written anew is checked. A call is a step's Worker with its input (same step key), a reconcile action or check (same step key, as many reconcile declarations as read, same place), an acceptance check (same key, the step's or the plan's), or a step's outputSchema or its bindings (same step key) — each whole, its target included; another key's read never brings that entry's value along. A call changed anywhere — another Worker, gate or operation, a value — keeps every value as sent, so a [redacted] left in it is refused; fields outside a call (maxAttempts, dependsOn, nested) do not decide it.${GOAL_OPERATION_REFUSALS}`,
  },
  // S11 GO9a (plan §4.3, I-P1, I-P5): the requester decides about a revision the goal planner
  // proposed — the planner proposes, only the person it acts for puts a plan in force.
  {
    name: 'decide_plan_revision',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        goalRunId,
        /** The proposed revision, as get_goal lists it. */
        revision: z.number().int().positive(),
        decision: PlanRevisionDecisionSchema,
        /** With accept: resume the run in the same transaction (resume_goal without retrySteps). */
        resume: z.boolean().optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.resume === true && value.decision !== 'accept') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['resume'],
            message: 'resumes only with decision accept',
          });
        }
      }),
    resultSchema: wire.DecidePlanRevisionResultWireSchema,
    description: `Decide about a revision the goal planner proposed for a paused GoalRun — the requester alone. accept: the proposal is checked again exactly like a revision the requester writes (400 invalid_params with details.problems when it no longer passes) and within the revision budget, then accepted and in force like revise_goal's (every live step it drops or changes superseded and terminated, its requests not yet started withdrawn, new or changed keys pending); resume: true also resumes the run, as resume_goal would — refused while the workspace owner holds it (409 illegal_transition). reject: the proposal is turned down and nothing else changes; the run stays paused, and the planner is not asked again about the same failed attempt. Only a proposed revision based on the revision in force (409 illegal_transition once another revision was accepted, the run left its pause or the proposal was decided), only while the run is paused. The same decision again changes nothing (changed: false).${GOAL_OPERATION_REFUSALS}`,
  },
  {
    name: 'confirm_goal_acceptance',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({ goalRunId, checkKey: StepKeySchema.optional(), note: goalNote })
      .strict(),
    resultSchema: wire.ConfirmGoalAcceptanceResultWireSchema,
    description: `Confirm the requester_confirm check of a verifying GoalRun’s current round — the requester alone, once every check of the round the platform makes has passed (409 illegal_transition before): their Decision (achieved) is recorded and the run completes on its next advance. checkKey names the confirmation; ${GOAL_NOTE_RULE} Already confirmed: changes nothing.${GOAL_OPERATION_REFUSALS}`,
  },
  {
    name: 'end_goal',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z.object({ goalRunId, outcome: ObjectiveOutcomeSchema, note: goalNote }).strict(),
    resultSchema: wire.EndGoalResultWireSchema,
    description: `End a paused or verifying GoalRun with an outcome on the requester’s word — the requester alone, also while the workspace owner holds the run (ending is not resuming): not_achieved from paused or verifying; achieved from paused only, every check it overrides named in the result, the Decision and the audit row. Nothing of the run may still run (409 illegal_transition while a step runs or waits, a Task is live or a request is in flight — cancel the run instead); steps not started are skipped. ${GOAL_NOTE_RULE} Already ended with this outcome on the requester’s word: changes nothing.${GOAL_OPERATION_REFUSALS}`,
  },
  {
    name: 'reconcile_goal_action',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'member',
    paramsSchema: z
      .object({
        goalRunId,
        actionRequestId: z.guid(),
        verdict: ActionRequestReconciliationSchema.optional(),
        reexecute: z.boolean().optional(),
        note: goalNote,
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.verdict === undefined && value.reexecute !== true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'names nothing to record: give a verdict, reexecute: true, or both',
          });
        }
      }),
    resultSchema: wire.ReconcileGoalActionResultWireSchema,
    description: `Settle an action of a GoalRun whose outcome is unknown: record what was found — verdict effect_seen (it took effect: counts as executed) or effect_absent (no effect) — the requester or the workspace owner, as a person, whatever became of the run; and/or decide to run it again (reexecute: true) — the requester alone, after or with effect_absent, while the run can still run and the step is still in the plan; the new request is approved like any other. Each is recorded once: the same again changes nothing, a different finding is 409 illegal_transition. The run is set due and stays paused until the requester resumes it. ${GOAL_NOTE_RULE} An action not of this run is 404 not_found.${GOAL_OPERATION_REFUSALS}`,
  },
  // S11 GO8b (plan §3.1, I-G8): a person approves one trial of a step whose WorkerSpec names draft
  // Skills — the decision that lets a draft run in a Worker before it is published, so made only by
  // a person who could publish it (`actsForPerson`: a service Principal's API key is refused too;
  // human channel and HUMAN_ONLY_CAPABILITY_NAMES: no Handle, hence no agent, ever carries it).
  {
    name: 'approve_step_trial',
    group: 'goal',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        goalRunId,
        stepKey: StepKeySchema,
        /** The step's WorkerSpec digest, as the `step_skill_draft` hint's `trial` gives it. */
        specDigest: z.string().min(1),
        /** Every draft the trial mounts, as that hint gives them. */
        drafts: z.array(StepTrialDraftSchema).min(1).max(MAX_WORKER_SPEC_LIST),
        credentialsReviewed: z.boolean().optional(),
      })
      .strict(),
    resultSchema: wire.ApproveStepTrialResultWireSchema,
    description: `Approve one trial of a GoalRun step whose WorkerSpec names Skills that are only drafts (the step_skill_draft hint): its first attempt then starts with those draft versions mounted, and its retries mount the same ones while each is unchanged. Only while the run is proposed (for the step of its proposal) or paused (for the step's StepRun in the revision in force, before its first attempt) — 409 illegal_transition while it runs, for a step not in the plan, one that has started, or one that names no draft now. specDigest and drafts are the hint's trial as you read it: a step whose WorkerSpec or drafts are another now — a draft discarded, proposed again or published since — is 409 draft_changed and nothing is written. Whoever approves could publish every draft now: its proposer, or the workspace owner (builder floor; another principal's draft is 403 not_proposer); a person, never a service Principal (403). When a draft carries suspected credentials, credentialsReviewed: true is required — 400 credentials_review_required (details: subject, suspectedSecretValues) otherwise. One trial is one StepRun: a revision that replaces the step, or a WorkerSpec that differs, needs another approval, and an approval a draft change made stale is never used. It does not resume the run: a paused run stays paused for its requester to resume. The same trial approved again changes nothing (changed: false).${GOAL_OPERATION_REFUSALS}`,
  },
] as const satisfies readonly Capability[];

// S10 E3-1a (docs/s10-evolution-plan-2026-10-04.md §3.1 EvalSuite, §3.3 I-E4, §5.5, §5.6): an
// evaluation suite's shell — the pinned WorkerDefinition version and the fixture gates its cases
// are answered through (E3-1b adds the cases, E3-2 the runs). Open to people, closed to agents
// (I-E4): human channel, `actsForPerson` (a service Principal's API key is refused too), in
// HUMAN_ONLY_CAPABILITY_NAMES; every workspace role reads (the auditor through
// AUDITOR_READ_CAPABILITIES), a builder or the owner changes. Every change
// names the suite version the person looked at (`suiteVersion`): another change since is 409
// version_changed and nothing is written.
const EVAL_SUITE_CHANGE_RULE =
  'suiteVersion is the suite version you looked at: when the suite has changed since, 409 version_changed and nothing is written. Each change is a new suite version, recorded in its history with who made it and when. A suite that is not there is 404 not_found.';
// S10 E3-1b: a case's content and its mechanism stay out of the audit copy of a case write
// (`auditWithheldParamKeys`); its partition and split, the reason and the ids are kept.
const EVAL_CASE_CONTENT_KEYS: readonly string[] = [
  'mechanism',
  ...Object.keys(evalCaseContentFields),
];
// S10 E3-1b: what every case write checks of the content.
const EVAL_CASE_CONTENT_RULE =
  'Whatever the suite’s state, 400 invalid_params for: a mechanism given without a mechanism partition or missing with one, a fixture rule naming a gate the suite does not have or an Operation it does not publish, an absent answer the Operation does not declare, a path that does not compile or (for an assertion) reads neither result nor calls, an invisible character, or a case larger than 64 KiB. No part of it may carry a credential (400 credentials_in_text) or a masked [redacted] mark (400 redacted_text_submitted).';
const evalSuiteId = z.guid();
const evalSuiteVersion = z.number().int().positive();
const evalReason = z.string().trim().min(1).max(500);

const evaluationCapabilities = [
  {
    name: 'list_eval_suites',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z.object({}).strict(),
    resultSchema: listEnvelope(wire.EvalSuiteSummaryWireSchema),
    description:
      'List this workspace’s evaluation suites, by name: each with the WorkerDefinition version it pins (and that version’s status now), its suite version, how many fixture gates it has and how many of them no longer match their gate. People only: an agent never reads an evaluation suite.',
  },
  {
    name: 'get_eval_suite',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z.object({ suiteId: evalSuiteId }).strict(),
    resultSchema: wire.EvalSuiteWireSchema,
    description:
      'Read one evaluation suite: its pinned WorkerDefinition version, its canary, its fixture gates — each with the gate’s name and published Operations as frozen when added, and whether the gate still matches (liveState same / changed / unavailable) — the cases it holds now, each in brief (title, partition, split, mechanism, how many fixture rules and assertions, fixtureOperations: the gate and operation pairs its rules answer, and fixtureProblems: rules a fixture gate sync left without a match) — and its history, every version’s change with who made it, when and why. People only. 404 not_found for a suite that is not there.',
  },
  {
    name: 'get_eval_case',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z.object({ suiteId: evalSuiteId, caseId: z.guid() }).strict(),
    resultSchema: wire.EvalCaseWireSchema,
    description:
      'Read one case of an evaluation suite whole — its input, fixture rules and assertions — whether the suite holds it now or an edit or a retirement took it out (retiredInVersion, retireReason, supersededBy). People only. 404 not_found for a suite or case that is not there.',
  },
  {
    name: 'create_eval_suite',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(2000).optional(),
        workerDefinitionId: z.guid(),
        workerDefinitionVersion: z.number().int().positive(),
      })
      .strict(),
    resultSchema: wire.EvalSuiteWireSchema,
    description:
      'Create an evaluation suite (version 1) that pins one published worker-kind WorkerDefinition version — the template its evaluation runs start from — and gets a random canary. It holds no fixture gate and no case yet. A version that is not a published worker-kind one is 400 invalid_params; a name another suite has (case and surrounding blanks ignored) is 409 eval_suite_name_taken. The name and description never change afterwards; neither may carry a credential (400 credentials_in_text) or a masked [redacted] mark (400 redacted_text_submitted).',
  },
  {
    name: 'repin_eval_suite',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        suiteId: evalSuiteId,
        suiteVersion: evalSuiteVersion,
        workerDefinitionVersion: z.number().int().positive(),
        reason: evalReason.optional(),
      })
      .strict(),
    resultSchema: wire.EvalSuiteWireSchema,
    description: `Pin another published version of the suite’s WorkerDefinition (never another WorkerDefinition: that is another suite). A version that is not published is 400 invalid_params; the version pinned now is 409 conflict. ${EVAL_SUITE_CHANGE_RULE}`,
  },
  {
    name: 'add_eval_fixture_gate',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        suiteId: evalSuiteId,
        suiteVersion: evalSuiteVersion,
        gatekeeperId: z.guid(),
      })
      .strict(),
    resultSchema: wire.EvalSuiteWireSchema,
    description: `Add a fixture gate: a stand-in for one of this workspace’s gates, freezing the gate’s name and its published Operations as an agent’s tool list shows them, so an evaluated Worker sees the same tool names and params. Evaluation never calls the gate: every call is answered from a case’s fixture. A gate that is not there or publishes no Operation is 400 invalid_params; a gate the suite already has is 409 conflict. ${EVAL_SUITE_CHANGE_RULE}`,
  },
  {
    name: 'sync_eval_fixture_gate',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        suiteId: evalSuiteId,
        suiteVersion: evalSuiteVersion,
        gatekeeperId: z.guid(),
      })
      .strict(),
    resultSchema: wire.EvalSuiteWireSchema,
    description: `Freeze a fixture gate again from the gate’s published Operations now, when they no longer match (liveState changed); the history records which Operations were added, removed or changed. A gate the suite does not have, or one that still matches, is 409 conflict; a gate that is gone or publishes nothing now is 400 invalid_params (remove it instead). ${EVAL_SUITE_CHANGE_RULE}`,
  },
  {
    name: 'remove_eval_fixture_gate',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        suiteId: evalSuiteId,
        suiteVersion: evalSuiteVersion,
        gatekeeperId: z.guid(),
        reason: evalReason,
      })
      .strict(),
    resultSchema: wire.EvalSuiteWireSchema,
    description: `Remove a fixture gate from the suite, with a reason (kept in its history). Earlier suite versions still hold it. A gate the suite does not have is 409 conflict; one a case the suite holds answers calls to is 409 fixture_gate_in_use, with details.caseCount and details.cases (id and title of each, the first 50, oldest first) — edit or retire those cases first. ${EVAL_SUITE_CHANGE_RULE}`,
  },
  {
    name: 'add_eval_case',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        suiteId: evalSuiteId,
        suiteVersion: evalSuiteVersion,
        ...evalCaseKindFields,
        ...evalCaseContentFields,
      })
      .strict(),
    resultSchema: wire.EvalSuiteWireSchema,
    auditWithheldParamKeys: EVAL_CASE_CONTENT_KEYS,
    description: `Add a case to the suite. partition (regression / mechanism / full), split (dev / holdout) and, for a mechanism case only, the mechanism it aims at are fixed for good. input is what the evaluated Worker is given. fixtures answer its calls: each rule names a fixture gate of the suite and one of its frozen Operations, optionally a when predicate on the call's params, and an answer — data, absent (only for an observe-class Operation that declares "not there" answers) or error; the first matching rule answers. assertions (at least one) are predicates on {result, calls}: result is the Worker's reported result contract, calls every fixture call it made ({gatekeeperId, gate, operation, mode, params, answer}); paths must read result or calls. ${EVAL_CASE_CONTENT_RULE} ${EVAL_SUITE_CHANGE_RULE}`,
  },
  {
    name: 'edit_eval_case',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        suiteId: evalSuiteId,
        suiteVersion: evalSuiteVersion,
        caseId: z.guid(),
        reason: evalReason,
        ...evalCaseContentFields,
      })
      .strict(),
    resultSchema: wire.EvalSuiteWireSchema,
    auditWithheldParamKeys: EVAL_CASE_CONTENT_KEYS,
    description: `Change a case the suite holds, with a reason: its row is retired and a new one, with the same partition, split and mechanism, takes its place (supersedes) — so earlier suite versions keep the case as it was. Content the same as now, or a case already retired, is 409 conflict; a case that is not in the suite is 404 not_found. ${EVAL_CASE_CONTENT_RULE} ${EVAL_SUITE_CHANGE_RULE}`,
  },
  {
    name: 'retire_eval_case',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        suiteId: evalSuiteId,
        suiteVersion: evalSuiteVersion,
        caseId: z.guid(),
        reason: evalReason,
      })
      .strict(),
    resultSchema: wire.EvalSuiteWireSchema,
    description: `Take a case out of the suite from the next version on, with a reason (kept in its history) — a person's decision, whatever its partition: a regression case is never dropped otherwise. Earlier suite versions still hold it; it is never deleted. A case the suite does not hold now is 409 conflict; one that is not there is 404 not_found. ${EVAL_SUITE_CHANGE_RULE}`,
  },
  // S10 E3-2a: evaluation runs — a person starts one, the kernel runs it as evaluation Tasks of
  // the workspace's evaluation service principal, every gate call answered from the case's fixtures
  // (I-E1); results stay in `eval_*` tables, read by people only (I-E4).
  {
    name: 'start_eval_case_trial',
    group: 'evaluation',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({ suiteId: evalSuiteId, suiteVersion: evalSuiteVersion, caseId: z.guid() })
      .strict(),
    resultSchema: wire.EvalRunWireSchema,
    description:
      'Try one case of the suite once, as it would run now (a case_trial run): the kernel starts an evaluation Task of the suite’s pinned WorkerDefinition version with the case’s input, for the workspace’s evaluation service principal — its Worker reads only its own Task, sees the suite’s fixture gates as its tools, and every call to them is answered from the case’s fixtures (no gate is ever called, nothing is executed); its egress is denied. When the Worker reports, the case’s assertions judge {result, calls} and the trial is scored passed or failed; a Task that ends without a report leaves it errored. Read the outcome with get_eval_run. suiteVersion is the suite version you looked at (409 version_changed when it has changed since). A case the suite does not hold now, or a pinned version no longer published, is 409 conflict; a suite or case that is not there is 404 not_found; once this UTC month’s evaluation spending has reached the evaluation budget (evaluation.monthly_cost_budget_usd, $10 unless the owner set it) 429 evaluation_budget_exhausted, with details.budgetUsd and details.spentUsd; the workspace’s Task quotas apply to evaluation Tasks as to any (429 concurrency_exceeded when as many evaluation Tasks run as one principal may run at once, 429 daily_cost_exceeded once the workspace’s daily cost budget is spent); while the evaluation seal has paused the evaluation Principal’s agents (list_eval_seal_holds), 403 evaluation_probe_hold. Nothing is started on any refusal. People only.',
  },
  {
    name: 'get_eval_run',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z.object({ runId: z.guid() }).strict(),
    resultSchema: wire.EvalRunWireSchema,
    description:
      'Read one evaluation run whole: the suite version and WorkerDefinition version it ran, and each trial — its status, verdict or error, each assertion’s outcome, the result its Worker reported, every fixture call it made with the rule that answered it, its cost and tokens, and its evaluation Task. People only. 404 not_found for a run that is not there — and for a draft evaluation’s stage you may not see (as get_draft_evaluation).',
  },
  {
    name: 'list_eval_runs',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z
      .object({
        suiteId: evalSuiteId,
        caseId: z.guid().optional(),
        kind: wire.EvalRunKindSchema.optional(),
      })
      .strict(),
    resultSchema: listEnvelope(wire.EvalRunSummaryWireSchema),
    description:
      'List a suite’s evaluation runs, newest first (the last 20), each in brief — its case rows and how many trials passed, failed, errored, still run or wait to start, and its cost; with caseId, only the runs that tried that case row; with kind, only runs of that kind (case_trial: single trials; draft: the stages of draft evaluations — those you may see, as get_draft_evaluation). People only. 404 not_found for a suite that is not there.',
  },
  {
    name: 'get_eval_budget',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z.object({}).strict(),
    resultSchema: wire.EvalBudgetWireSchema,
    description:
      'The workspace’s evaluation budget this UTC month: the budget (evaluation.monthly_cost_budget_usd — $10 unless the owner set it with set_quota), what evaluation runs have spent, the month’s start and end, what one trial has cost on average lately (null before any priced one) how many trials this month ran on a model with no price (not counted in spentUsd), and what the trials not ended yet are expected to cost (committedUsd: queued and running trials × that average, 0 before one is known). People only.',
  },
  // S10 E3-2b: draft evaluations — a Skill draft against what it would replace, through the
  // funnel's stages (regression, mechanism, confirm), judged by fixed rules (shared
  // draft-evaluation.ts). Evaluation is evidence for the person who publishes, never a gate.
  {
    name: 'start_draft_evaluation',
    group: 'evaluation',
    mode: 'execute',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z
      .object({
        skillId: z.guid(),
        version: z.number().int().positive(),
        // The draft as the caller read it (SkillSummaryWire.draftDigest).
        draftDigest: z.string().min(1),
        suiteId: evalSuiteId,
        suiteVersion: evalSuiteVersion,
        // One of the suite's mechanism cases' mechanisms; omitted, the mechanism stage is skipped.
        mechanism: z.string().trim().min(1).max(EVAL_CASE_MECHANISM_MAX).optional(),
      })
      .strict(),
    resultSchema: wire.DraftEvaluationWireSchema,
    description:
      'Evaluate a Skill draft against a suite: the candidate (the draft) and the baseline (the published version of its family it would replace; for a new Skill, the suite’s pinned WorkerDefinition without it) run the suite’s cases as evaluation Tasks — every gate call answered from fixtures, egress denied — through three stages in order: regression (each regression case twice per arm: the candidate must pass each as often as the baseline, else regressed), mechanism (the cases aimed at mechanism, 10 tries per arm in all: the candidate must pass all and the baseline at most 4 in 10, else refuted; skipped without mechanism), confirm (each full case 3 times per arm: dev pass rates against δ = 0.1 → worse, better, non_inferior or inconclusive; holdout must agree). A trial that could not start, was lost, terminated or crashed has no outcome: a verdict must hold whichever way it would have gone, else inconclusive (errored_trials), as is an arm with over a quarter of a stage’s trials without one. Both arms load the same other Skills, pinned now. Read progress and the verdict with get_draft_evaluation. Before anything runs the draft is checked: a credential-like value, a platform-shaped id, text over 20000 characters, no change from the baseline, more than 200 changed lines, or a canary or held-out case text refuses the start with 400 draft_check_failed (details.problems: [{check, count, limit}]). A stage the month’s evaluation budget cannot cover — after what is spent and what the trials not ended yet, of any evaluation, are expected to cost (get_eval_budget committedUsd) — is not run (the verdict is inconclusive, reason budget); when even the first stage’s estimate does not fit, 429 evaluation_budget_insufficient (details: budgetUsd, spentUsd, committedUsd, estimateUsd) and nothing starts; a spent budget is 429 evaluation_budget_exhausted. Refused too: a draft that is not there or not visible (404 not_found), one that is no longer a draft (409 not_a_draft), one changed since it was read (409 draft_changed), one already being evaluated (409 draft_evaluating), a suite at another version (409 version_changed), a mechanism the suite’s cases do not name, a suite with no case to run or a draft whose name another loaded Skill has (409 conflict), the evaluation seal having paused the evaluation Principal’s agents (403 evaluation_probe_hold; list_eval_seal_holds). A stage whose trials are waiting while such a pause opens keeps them waiting until the owner releases it. While it runs the draft cannot be published, discarded, rejected or expired. People only.',
  },
  {
    name: 'get_draft_evaluation',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z.object({ evaluationId: z.guid() }).strict(),
    resultSchema: wire.DraftEvaluationWireSchema,
    description:
      'Read one draft evaluation whole: what it compares (suite version, WorkerDefinition version, the draft and the baseline, the other Skills, both contents), each stage — its state, its run (get_eval_run reads its trials), its estimate, each arm’s trials and cost, the case × arm matrix and what it measured — the verdict, why and which stage decided it, and every environment its trials ran in. People who may see the draft only — the draft’s proposer and the workspace’s draft reviewers (owner, builders), or anyone once that draft is published as it was evaluated: 404 not_found otherwise, as for an evaluation that is not there.',
  },
  {
    name: 'list_draft_evaluations',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z
      .object({ skillId: z.guid().optional(), suiteId: evalSuiteId.optional() })
      .strict(),
    resultSchema: listEnvelope(wire.DraftEvaluationSummaryWireSchema),
    description:
      'List draft evaluations, newest first (the last 50), each in brief — what it compares, its state, the stage running, the verdict and why, its cost; with skillId, those of one Skill family; with suiteId, those against one suite. Only those whose draft the caller may see (as get_draft_evaluation). People only.',
  },
  {
    name: 'cancel_draft_evaluation',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'builder',
    actsForPerson: true,
    paramsSchema: z.object({ evaluationId: z.guid() }).strict(),
    resultSchema: wire.DraftEvaluationWireSchema,
    description:
      'Cancel a running draft evaluation: its trials not started yet are cancelled, its running evaluation Tasks are terminated, no later stage starts, and it ends cancelled, with no verdict. What its trials already measured stays readable. One that has ended is 409 conflict; one that is not there or whose draft the caller may not see is 404 not_found. People only.',
  },
  // S10 E3-3 (§5.6 发布审阅): what a Skill draft's evaluations say to whoever publishes it.
  {
    name: 'get_skill_publish_evidence',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'member',
    actsForPerson: true,
    paramsSchema: z
      .object({
        skillId: z.guid(),
        version: z.number().int().positive(),
        draftDigest: z.string().min(1),
      })
      .strict(),
    resultSchema: wire.SkillPublishEvidenceWireSchema,
    description:
      'What a Skill draft’s evaluations say to whoever publishes it, for the draft as read (skillId, version, draftDigest — list_skills / get_skill give the digest), so each evaluated exactly this content: its finished evaluations, newest first — the first is the evidence publish_skill names (evaluationReview.evaluationId) — each with the stage that decided its verdict (each case’s tries, what the rule measured) and both arms’ trials, cost and tokens over every stage; the one running now, if any (publish_skill waits for it); every failure to acknowledge when publishing — each case a regressed evaluation lost, or a worse one’s confirmation passed less often than the baseline, with both arms’ tries; and the family’s other drafts an evaluation found refuted, regressed or worse (the last 10). Only evaluations whose draft the caller may see (as get_draft_evaluation). People only.',
  },
  // S10 E3-2c (legacy 514): the pauses the evaluation seal puts on the agents of a Principal it
  // keeps refusing — the pattern of an agent probing which texts are held out.
  {
    name: 'list_eval_seal_holds',
    group: 'evaluation',
    mode: 'observe',
    channel: 'human',
    minRole: 'auditor',
    actsForPerson: true,
    paramsSchema: z.object({ status: wire.EvalSealHoldStatusSchema.optional() }).strict(),
    resultSchema: listEnvelope(wire.EvalSealHoldWireSchema),
    description:
      'List the pauses the evaluation seal opened, newest first (the last 50); with status, only active or only released ones. The seal refuses to hand an agent a suite’s canary or a verbatim run of a held-out case’s text, and counts the refusals an agent could have provoked (a capability’s result or error, what a Worker would start with) per Principal they acted for: 5 within 24 hours, since its last release, pause every agent acting for that Principal — every call, Worker start and entry Turn is refused with 403 evaluation_probe_hold — until the workspace owner releases it (release_eval_seal_hold). Each says whose agents (principal.evaluation marks the evaluation Principal every evaluation Task acts for), how many refusals opened it and where, when, and once released by whom and why. The workspace owner and auditors only. People only.',
  },
  {
    name: 'release_eval_seal_hold',
    group: 'evaluation',
    mode: 'write',
    channel: 'human',
    minRole: 'owner',
    actsForPerson: true,
    paramsSchema: z
      .object({ holdId: z.guid(), reason: z.string().trim().min(1).max(500) })
      .strict(),
    resultSchema: wire.EvalSealHoldWireSchema,
    description:
      'Release an active pause of the evaluation seal (list_eval_seal_holds) — the workspace owner only, with a reason (required, kept with the pause and in the audit record). The agents acting for its Principal run again, and the seal counts that Principal’s refusals afresh from now. One already released is 409 conflict; one that is not there is 404 not_found. People only.',
  },
] as const satisfies readonly Capability[];

/**
 * The registry's groups, each with its literal names kept (`as const`), for `CapabilityName`. The
 * annotation names each group's type rather than letting the compiler infer the whole tuple: the
 * inferred type — every entry's schema and description, as literals — is longer than the compiler
 * writes into the declaration file (TS7056). A group in the value and not in the annotation (or in
 * a different place) does not compile.
 */
const GROUPS: readonly [
  typeof chatCapabilities,
  typeof ontologyCapabilities,
  typeof graphCapabilities,
  typeof gateCapabilities,
  typeof connectionCapabilities,
  typeof metaCapabilities,
  typeof epistemicCapabilities,
  typeof governanceCapabilities,
  typeof taskCapabilities,
  typeof workerCapabilities,
  typeof ingestCapabilities,
  typeof auditCapabilities,
  typeof membersCapabilities,
  typeof agentProfileCapabilities,
  typeof platformCapabilities,
  typeof modulesCapabilities,
  typeof goalCapabilities,
  typeof evaluationCapabilities,
] = [
  chatCapabilities,
  ontologyCapabilities,
  graphCapabilities,
  gateCapabilities,
  connectionCapabilities,
  metaCapabilities,
  epistemicCapabilities,
  governanceCapabilities,
  taskCapabilities,
  workerCapabilities,
  ingestCapabilities,
  auditCapabilities,
  membersCapabilities,
  agentProfileCapabilities,
  platformCapabilities,
  modulesCapabilities,
  goalCapabilities,
  evaluationCapabilities,
];

/** The complete capability registry (design doc §9.3). */
export const CAPABILITY_REGISTRY: readonly Capability[] = GROUPS.flat();

/** Every registered capability name, as a type: a hand-typed name that is not in the registry
 *  (a typo, a name that was never registered) fails at compile time wherever one is expected —
 *  the console's role checks and nav entries first of all (#541 review M1). */
export type CapabilityName = (typeof GROUPS)[number][number]['name'];

/** Narrows a runtime string to `CapabilityName`. */
export function isCapabilityName(name: string): name is CapabilityName {
  return getCapability(name) !== undefined;
}

/** Capability names that must always be on the human channel (I16/I17/§9.3), never handle. */
const HUMAN_ONLY_CAPABILITY_NAMES: ReadonlySet<string> = new Set<CapabilityName>([
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
  'discard_operation_draft',
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
  // Legacy 145: adopting a platform template is the people's decision.
  'get_entry_template_status',
  'propose_entry_template_upgrade',
  'discard_draft',
  // S11 W1a E2-0b (review #493 on #772, N1): a reviewer's transition — never an agent's.
  'reject_draft',
  // Legacy 491: the reviewer's words go to the person whose draft it was.
  'list_draft_rejections',
  // S10 E3-1a (I-E4): an evaluation suite is open to people, closed to agents.
  'list_eval_suites',
  'get_eval_suite',
  'create_eval_suite',
  'repin_eval_suite',
  'add_eval_fixture_gate',
  'sync_eval_fixture_gate',
  'remove_eval_fixture_gate',
  // S10 E3-1b: so is every case.
  'get_eval_case',
  'add_eval_case',
  'edit_eval_case',
  'retire_eval_case',
  // S10 E3-2a: and every run.
  'start_eval_case_trial',
  'get_eval_run',
  'list_eval_runs',
  'get_eval_budget',
  // S10 E3-2b: and every draft evaluation.
  'start_draft_evaluation',
  'get_draft_evaluation',
  'list_draft_evaluations',
  'cancel_draft_evaluation',
  'get_skill_publish_evidence',
  // S10 E3-2c: and the seal's pauses.
  'list_eval_seal_holds',
  'release_eval_seal_hold',
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
  // S11 W1a E2-1 / E2-2: workspace-wide numbers for the people who maintain Skills and Procedures.
  'get_skill_stats',
  'get_procedure_stats',
  'get_workspace',
  'list_models',
  // S3.13 (docs/development-tasks.md "每用户智能体配置") — AgentProfile/AgentPolicy management and
  // its read side: a principal's own agent configuration, never a legitimate Handle-scope member
  // (same reasoning as the S3.11 membership names right above).
  'get_agent_profile',
  'set_agent_profile',
  'get_agent_policy',
  'set_agent_policy',
  // S11 GO5b: a person's operations on a GoalRun — the requester's decisions and the owner's stops
  // (the `goal` group comment). Never a Handle-scope member: an agent proposes a goal (GO5c), a
  // person confirms, steers and judges it.
  'confirm_goal',
  'reject_goal',
  'pause_goal',
  'resume_goal',
  'cancel_goal',
  'release_goal_hold',
  'revise_goal',
  // S11 GO9a: the requester decides about the goal planner's proposal.
  'decide_plan_revision',
  'confirm_goal_acceptance',
  'end_goal',
  'reconcile_goal_action',
  // S11 GO8b: a person who could publish the drafts approves a step's trial of them.
  'approve_step_trial',
  // S11 P1-B: a workspace's ChangePlan records and their rollback — the owner's configuration
  // management (§5.4: a workspace segment's contents are read and acted on only by people in that
  // workspace; the admin agent proposes, I-A1). Never a Handle-scope member.
  'list_change_segments',
  'get_change_segment',
  'preview_roll_back_change_segment',
  'roll_back_change_segment',
  // S11 P1-C: packs and installing one as a ChangePlan segment — the same configuration management.
  'list_packs',
  'preview_pack_install',
  'install_pack',
  // P-A1: the platform plane, plus a few workspace-scope members that belong next to it. The
  // `scope: 'platform'` names here are never callable by a Principal at all (the gateway admits
  // only a platform-admin console session); the workspace-scope ones — `list_available_gate_instances`,
  // `enable_gate_instance`, `preview_gate_instance_enable`, `refresh_operation_governance`,
  // `issue_service_handle`, `issue_gate_credential_token` — are a workspace's own connection and
  // credential management, human-only for the same reason as the S3.11 names above. None is ever a
  // Handle-scope member.
  ...([
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
    'list_connector_presets',
    'list_gate_instances',
    'get_gate_instance',
    'update_gate_instance',
    'confirm_gate_manifest',
    'test_gate_instance',
    'list_external_runtimes',
    'revoke_external_runtime',
    'list_self_connections',
    'suspend_self_connection',
    'resume_self_connection',
    'list_available_gate_instances',
    'enable_gate_instance',
    'preview_gate_instance_enable',
    'preview_gatekeeper_resync',
    'refresh_operation_governance',
    'issue_service_handle',
    'create_gate_instance',
    'delete_gate_instance',
    'issue_gate_host_token',
    'issue_gate_credential_token',
    'issue_llm_admin_token',
  ] as const),
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

    // S11 GO5c: a platform-scope call has no Principal to act for.
    if (capability.actsForPerson && capability.scope === 'platform') {
      throw new Error(
        `capability registry: "${capability.name}" is scope:platform but declares actsForPerson`,
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
