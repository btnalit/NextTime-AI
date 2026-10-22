import { z } from 'zod';

/**
 * Domain enums (design doc §5.1, §5.5, §5.6, §7.4, §9.2, §9.3). Every enum is exported three
 * ways: a `readonly [...] as const` values array (the single source of truth), a derived union
 * type of the same name, and a Zod schema (`<Name>Schema`) for runtime validation at process
 * boundaries (DB rows, HTTP/WS/MCP payloads). Pure data — no IO, no business logic.
 */

function asEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values);
}

// ---------------------------------------------------------------------------------------------
// §5.1.1 Tenancy & principals
// ---------------------------------------------------------------------------------------------

/** Principal kind (§5.1.1): human / agent (one WorkerRun or one entry agent instance) / service. */
export const PRINCIPAL_KIND_VALUES = ['human', 'agent', 'service'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KIND_VALUES)[number];
export const PrincipalKindSchema = asEnum(PRINCIPAL_KIND_VALUES);

/**
 * Role (§5.1.1): coarse "which door can you enter" gate — capability range narrows further via
 * Grant. owner = authorization & policy; builder = propose ontology & WorkerDefinition; operator
 * = enters the approval queue; member = converse, invoke, observe; auditor = read-only incl.
 * secret metadata — an explicit allowlist of side-effect-free reads plus audit and provenance
 * tools, no Gatekeeper access, no `invoke_worker`; it may still talk to its own entry agent,
 * which carries the same ceiling (review 2026-10-02 D-07, kernel `governance/capability/roles.ts`).
 */
export const ROLE_VALUES = ['owner', 'builder', 'operator', 'member', 'auditor'] as const;
export type Role = (typeof ROLE_VALUES)[number];
export const RoleSchema = asEnum(ROLE_VALUES);

/** Session kind (§9.2 `sessions.kind` CHECK constraint). */
export const SESSION_KIND_VALUES = [
  'web',
  'entry',
  'worker_run',
  'mcp_session',
  'service',
] as const;
export type SessionKind = (typeof SESSION_KIND_VALUES)[number];
export const SessionKindSchema = asEnum(SESSION_KIND_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.6 Epistemic status & §3.2 / reference-projects Conflict taxonomy
// ---------------------------------------------------------------------------------------------

/**
 * Epistemic status (§5.6): how a Fact came to be believed, independent of its lifecycle
 * (`recorded|superseded|invalidated`, see transitions.ts). `confidence` is a separate continuous
 * value, not modeled here.
 */
export const EPISTEMIC_STATUS_VALUES = [
  'observed',
  'extracted',
  'inferred',
  'asserted',
  'verified',
  'contradicted',
] as const;
export type EpistemicStatus = (typeof EPISTEMIC_STATUS_VALUES)[number];
export const EpistemicStatusSchema = asEnum(EPISTEMIC_STATUS_VALUES);

/**
 * STATUS leftover 89 (maintainer decision 2026-09-27, "做成单独标注的'人工确认'证据"): the one
 * reserved Evidence kind (`evidence.kind`, §5.1.3 / §5.3 item 6) meaning "a person's own
 * confirmation" — written only by the human-channel `attest_fact` capability, never by a Worker's
 * result contract (`WorkerResultEvidenceSchema` refuses it) or any other Evidence writer
 * (`substrate/epistemic/evidence.ts`'s `attachEvidence` refuses it too). Every other Evidence
 * kind is machine evidence (command output, a document excerpt, a gate result) the writer names
 * freely. A human's word must never read as machine evidence, nor machine evidence as a human's.
 */
export const HUMAN_ATTESTATION_EVIDENCE_KIND = 'human_attestation' as const;

/**
 * Conflict type. The design doc (§5.1.3, §5.5) carries `Conflict` over from Semantica "as-is"
 * without re-listing its type taxonomy; Semantica's own taxonomy is
 * `VALUE / TYPE / RELATIONSHIP / TEMPORAL / LOGICAL` (docs/reference-projects-and-oss-landscape.md
 * §"Conflict"). Assumption (see PR body "假设"): adopted verbatim, lower-cased to match this
 * codebase's snake_case enum convention.
 */
export const CONFLICT_TYPE_VALUES = [
  'value',
  'type',
  'relationship',
  'temporal',
  'logical',
] as const;
export type ConflictType = (typeof CONFLICT_TYPE_VALUES)[number];
export const ConflictTypeSchema = asEnum(CONFLICT_TYPE_VALUES);

/** Conflict status (§5.5): `open → resolved | accepted_both | dismissed`. */
export const CONFLICT_STATUS_VALUES = ['open', 'resolved', 'accepted_both', 'dismissed'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUS_VALUES)[number];
export const ConflictStatusSchema = asEnum(CONFLICT_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.5 Decision
// ---------------------------------------------------------------------------------------------

/**
 * Decision status (§5.5): `proposed → approved | rejected → executed → verified | failed →
 * superseded | archived`. See transitions.ts for the edge-level reading of this chain (a rejected
 * Decision is terminal; it does not proceed to `executed`).
 */
export const DECISION_STATUS_VALUES = [
  'proposed',
  'approved',
  'rejected',
  'executed',
  'verified',
  'failed',
  'superseded',
  'archived',
] as const;
export type DecisionStatus = (typeof DECISION_STATUS_VALUES)[number];
export const DecisionStatusSchema = asEnum(DECISION_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.5 ActionRequest — the 13 states of §9.2, plus `withdrawn` (S11 GO1)
// ---------------------------------------------------------------------------------------------

/** ActionRequest status: the 13 states of the v0.1 §9.2 state graph, carried forward by v0.3 §5.5,
 *  plus `withdrawn` (S11 GO1, docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md I-G9): a
 *  request that had not started executing and was taken back because the step it belongs to was
 *  cancelled or revised away. Terminal; nothing ran. */
export const ACTION_REQUEST_STATUS_VALUES = [
  'proposed',
  'policy_evaluated',
  'auto_approved',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'denied',
  'executing',
  'executed',
  'failed',
  'verified',
  'compensated',
  'withdrawn',
] as const;
export type ActionRequestStatus = (typeof ACTION_REQUEST_STATUS_VALUES)[number];
export const ActionRequestStatusSchema = asEnum(ACTION_REQUEST_STATUS_VALUES);

/**
 * Why a `failed` ActionRequest failed (S11 GO1, plan §4.7) — a column on the row
 * (`action_requests.failure_kind`, migrations/governance/0021), never read out of an audit payload,
 * so whatever acts on a failure (the goal advancer, the console, an agent) splits on one value:
 *
 *   - `not_delivered` (发送前失败): the request never reached the gate, so nothing ran — the
 *     connection could not be set up, the kernel could not authenticate to or address the gate, or
 *     the gate later confirmed it holds no record of the request (`apply_not_received`). Making the
 *     same request again is safe.
 *   - `refused` (明确拒绝): a definitive "no" — the platform refused to send it at execution time
 *     (the Operation was disabled, its approved definition is gone, the gate is no longer
 *     registered, the gate endpoint is refused), or the gate answered in its own protocol that the
 *     call will not run or failed (refused, invalid params, definition mismatch, no credential, the
 *     target answered with an error). Asking again unchanged gets the same answer.
 *   - `outcome_unknown` (结果不明): it may or may not have run, and nobody can confirm which. Never
 *     re-run automatically: someone checks the target system first.
 *
 * Set exactly when the row is `failed` or `compensated` (a DB CHECK). A writer that does not name a
 * kind — code from before this column — gets `outcome_unknown`, the safe reading (the 0021 trigger).
 */
export const ACTION_REQUEST_FAILURE_KIND_VALUES = [
  'not_delivered',
  'refused',
  'outcome_unknown',
] as const;
export type ActionRequestFailureKind = (typeof ACTION_REQUEST_FAILURE_KIND_VALUES)[number];
export const ActionRequestFailureKindSchema = asEnum(ACTION_REQUEST_FAILURE_KIND_VALUES);

/**
 * What a person (S11 GO3c) or a reconcile observation (GO3d) found about a `failed` +
 * `outcome_unknown` ActionRequest (`action_requests.reconciliation`, migrations/governance/0023):
 *
 *   - `effect_seen` (已生效): its effect is there — the request counts as executed;
 *   - `effect_absent` (未见效果): no effect was found — the step needs a person, who may decide to
 *     run the same request again (a re-execute Decision) or change the plan.
 *
 * Recorded once, with the Decision behind it (`reconciliation_decision_id`); a finding that turns
 * out wrong is answered by a later decision about the step (re-execute, retry, revise), never by
 * rewriting this one.
 */
export const ACTION_REQUEST_RECONCILIATION_VALUES = ['effect_seen', 'effect_absent'] as const;
export type ActionRequestReconciliation = (typeof ACTION_REQUEST_RECONCILIATION_VALUES)[number];
export const ActionRequestReconciliationSchema = asEnum(ACTION_REQUEST_RECONCILIATION_VALUES);

/**
 * S11 GO3d (plan §4.7 "结果未知"): where the platform's reconcile check of an outcome-unknown
 * ActionRequest stands — an observation the request's goal step declared, and a predicate over its
 * result (`action_request_reconcile_checks`, governance/0024):
 *   - `pending` (平台核对中): not observed yet, or observed without an answer and tried again;
 *   - `seen` (平台已见效果): the observation satisfied the predicate — the platform recorded
 *     `effect_seen` on the request;
 *   - `not_seen` (平台未见效果): it did not — a person records what they find; never re-run on its own;
 *   - `unavailable` (平台无法核对): the observation could not be made (refused, or no answer after the
 *     last try) — a person records what they find;
 *   - `preempted` (已由人核对): a person recorded a finding first; nothing was recorded from the check.
 * Only `pending` moves, once, to one of the others.
 */
export const ACTION_REQUEST_RECONCILE_CHECK_STATUS_VALUES = [
  'pending',
  'seen',
  'not_seen',
  'unavailable',
  'preempted',
] as const;
export type ActionRequestReconcileCheckStatus =
  (typeof ACTION_REQUEST_RECONCILE_CHECK_STATUS_VALUES)[number];
export const ActionRequestReconcileCheckStatusSchema = asEnum(
  ACTION_REQUEST_RECONCILE_CHECK_STATUS_VALUES,
);

// ---------------------------------------------------------------------------------------------
// §5.5 Task, WorkerRun, EntryAgent session
// ---------------------------------------------------------------------------------------------

/** Task status (§5.5): `created → queued → running ⇄ waiting_approval → completed|failed|cancelled`. */
export const TASK_STATUS_VALUES = [
  'created',
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];
export const TaskStatusSchema = asEnum(TASK_STATUS_VALUES);

/** WorkerRun status (§5.5): `provisioning → running → suspended → terminated`. */
export const WORKER_RUN_STATUS_VALUES = [
  'provisioning',
  'running',
  'suspended',
  'terminated',
] as const;
export type WorkerRunStatus = (typeof WORKER_RUN_STATUS_VALUES)[number];
export const WorkerRunStatusSchema = asEnum(WORKER_RUN_STATUS_VALUES);

/**
 * Why a Task failed (`tasks.failure_reason`, legacy 324) — every value the kernel writes
 * (`application/task`'s `failTaskRow` takes only these): `timeout` (its run outlived the duration
 * limit), `no_result` (the run ended without handing back a result), `worker_failed` (the run
 * failed and its retry is used up, or the retry could not start), `spawn_failed` (the first run
 * could not start), `spawn_lost` (stuck queued — the kernel died before the run started),
 * `run_lost` (running, but every run of it is gone), `budget_exhausted` (the token budget ran
 * out), `terminated` (the runtime ended its run). The column is free text, so a row an earlier
 * release wrote may carry something else; readers keep a fallback.
 */
export const TASK_FAILURE_REASON_VALUES = [
  'timeout',
  'no_result',
  'worker_failed',
  'spawn_failed',
  'spawn_lost',
  'run_lost',
  'budget_exhausted',
  'terminated',
] as const;
export type TaskFailureReason = (typeof TASK_FAILURE_REASON_VALUES)[number];
export const TaskFailureReasonSchema = asEnum(TASK_FAILURE_REASON_VALUES);

/**
 * Why a member-management capability refused a well-formed request (`PrincipalOperationRefusedError`,
 * sent as 409 `conflict` with `details.reason`): `last_owner` (it would leave the workspace with no
 * active human owner), `self_disable` (disabling yourself), `platform_managed` (an agent or a
 * platform service account), `human_api_key` (a person signs in with a password, not an API key),
 * `reserved_name` (a display name reserved for platform identities). The console's copy is keyed
 * by this type, so a new reason does not compile until it has copy.
 */
export const PRINCIPAL_REFUSAL_REASON_VALUES = [
  'last_owner',
  'self_disable',
  'platform_managed',
  'human_api_key',
  'reserved_name',
] as const;
export type PrincipalRefusalReason = (typeof PRINCIPAL_REFUSAL_REASON_VALUES)[number];
export const PrincipalRefusalReasonSchema = asEnum(PRINCIPAL_REFUSAL_REASON_VALUES);

/**
 * EntryAgent session status (§5.5): `starting → ready → busy → ready …`; `crashed → starting`
 * (host auto-recovery, §7.2); `stopped` (idle timeout).
 */
export const ENTRY_AGENT_SESSION_STATUS_VALUES = [
  'starting',
  'ready',
  'busy',
  'crashed',
  'stopped',
] as const;
export type EntryAgentSessionStatus = (typeof ENTRY_AGENT_SESSION_STATUS_VALUES)[number];
export const EntryAgentSessionStatusSchema = asEnum(ENTRY_AGENT_SESSION_STATUS_VALUES);

/**
 * Turn status (design doc §9.2 DDL `activities(kind='agent_turn', status in (...))`, §13 "Turn 非法
 * 转移被拒"): `running → completed | interrupted | failed`, every end state terminal. The same three
 * end states a `turnEnded` runtime event and the `TurnCompleted` outbox event carry.
 */
export const TURN_STATUS_VALUES = ['running', 'completed', 'interrupted', 'failed'] as const;
export type TurnStatus = (typeof TURN_STATUS_VALUES)[number];
export const TurnStatusSchema = asEnum(TURN_STATUS_VALUES);

/**
 * Objective outcome (S10 E1, docs/s10-evolution-plan-2026-10-04.md §3.4): "做对了吗", kept apart
 * from the execution status above ("跑完了吗"). Only the two given values are stored; `unknown` is
 * the absence of a record (`null` on the wire), the default for every Turn and Task. Lifecycle:
 * `unknown → achieved | not_achieved`, correctable once by the same giver (migrations/task/0006).
 */
export const OBJECTIVE_OUTCOME_VALUES = ['achieved', 'not_achieved'] as const;
export type ObjectiveOutcome = (typeof OBJECTIVE_OUTCOME_VALUES)[number];
export const ObjectiveOutcomeSchema = asEnum(OBJECTIVE_OUTCOME_VALUES);

// ---------------------------------------------------------------------------------------------
// S11 GoalRun, PlanRevision, StepRun (docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
// §3.1–§3.4; migrations/goal/0001). Execution state and objective outcome stay apart, as for Task.
// ---------------------------------------------------------------------------------------------

/**
 * GoalRun execution status (§3.4): `proposed → running ⇄ paused → verifying → completed`;
 * `running | paused | verifying → cancelling → cancelled`; `proposed → cancelled` (rejected or
 * expired before confirmation); any non-terminal status → `failed` (an unrecoverable engine error).
 * Terminal: `completed`, `cancelled`, `failed`.
 */
export const GOAL_RUN_STATUS_VALUES = [
  'proposed',
  'running',
  'paused',
  'verifying',
  'completed',
  'cancelling',
  'cancelled',
  'failed',
] as const;
export type GoalRunStatus = (typeof GOAL_RUN_STATUS_VALUES)[number];
export const GoalRunStatusSchema = asEnum(GOAL_RUN_STATUS_VALUES);

/**
 * Why a GoalRun is `paused` (§3.4, §4.7, §4.9) — set exactly while it is paused: the requester asked
 * (`requested`), its budget ran out (`budget_exhausted`, I-G6 — a pause, never a failure), no step
 * made progress for K decision points (`no_progress`), the requester no longer holds the authority
 * a next step needs (`authority_lost`, I-G7), a person must choose (`needs_decision`: verification
 * failed, an action was rejected or expired, a reconcile saw no effect), or someone has to check a
 * target system by hand before anything else runs (`awaiting_reconcile`).
 */
export const GOAL_RUN_PAUSE_REASON_VALUES = [
  'requested',
  'budget_exhausted',
  'no_progress',
  'authority_lost',
  'needs_decision',
  'awaiting_reconcile',
] as const;
export type GoalRunPauseReason = (typeof GOAL_RUN_PAUSE_REASON_VALUES)[number];
export const GoalRunPauseReasonSchema = asEnum(GOAL_RUN_PAUSE_REASON_VALUES);

/**
 * The authority a person's pause of a GoalRun carries (S11 GO3b, goal/0004 `paused_by_authority`):
 * the requester paused their own run (`requester` — they may resume it), or a workspace owner
 * paused someone else's (`owner` — a hold: the requester cannot resume until an owner lifts it).
 * Absent when the advancer paused the run (budget, lost authority, a decision needed).
 */
export const GOAL_RUN_PAUSE_AUTHORITY_VALUES = ['requester', 'owner'] as const;
export type GoalRunPauseAuthority = (typeof GOAL_RUN_PAUSE_AUTHORITY_VALUES)[number];
export const GoalRunPauseAuthoritySchema = asEnum(GOAL_RUN_PAUSE_AUTHORITY_VALUES);

/**
 * What a `completed` GoalRun's objective outcome (`achieved` / `not_achieved`,
 * {@link OBJECTIVE_OUTCOME_VALUES}) rests on (I-G5): a platform-run acceptance check the requester
 * confirmed (`verified_by_check`), the requester's own word (`requester`), or an independent review
 * (`reviewer_assessed`, W4). `agent_reported` — a Task outcome's basis in `wire/attribution.ts` —
 * is deliberately not one of them: neither a step's Worker nor the entry agent can declare a goal
 * achieved. Kept to these three by a DB CHECK.
 */
export const GOAL_OUTCOME_BASIS_VALUES = [
  'verified_by_check',
  'requester',
  'reviewer_assessed',
] as const;
export type GoalOutcomeBasis = (typeof GOAL_OUTCOME_BASIS_VALUES)[number];
export const GoalOutcomeBasisSchema = asEnum(GOAL_OUTCOME_BASIS_VALUES);

/**
 * S11 GO4a (plan §4.6, I-G5; `goal_acceptance_checks`, goal/0005): the kinds of a goal's acceptance
 * check — what the platform verifies, or the requester confirms, before a GoalRun is achieved:
 *   - `observe_predicate` (平台观察): an observe-class Operation, its params and a predicate over its
 *     result (`ObservationCheck`), observed by the platform for the requester;
 *   - `requester_confirm` (请求人确认): the requester says the goal is achieved — asked once every
 *     observation of the round passed. A plan with no acceptance check has one implicitly.
 * GO4b adds `fact_predicate`; W4 `review`.
 */
export const GOAL_ACCEPTANCE_CHECK_KIND_VALUES = [
  'observe_predicate',
  'requester_confirm',
] as const;
export type GoalAcceptanceCheckKind = (typeof GOAL_ACCEPTANCE_CHECK_KIND_VALUES)[number];
export const GoalAcceptanceCheckKindSchema = asEnum(GOAL_ACCEPTANCE_CHECK_KIND_VALUES);

/**
 * S11 GO4a (goal/0005): where one acceptance check of a verification round stands:
 *   - `pending` (验收中): not settled — an observation not made yet or tried again, a confirmation
 *     the requester has not given;
 *   - `passed` (通过): the observation satisfied the predicate, or the requester confirmed;
 *   - `failed` (未通过): no observation satisfied the predicate by the last try;
 *   - `unavailable` (无法验收): the observation could not be made — refused, or no answer by the
 *     last try;
 *   - `superseded` (已作废): the round ended before the check settled — the run left verification
 *     (paused, cancelled, ended by the requester) or a newer round began.
 * Only `pending` moves, once, to one of the others.
 */
export const GOAL_ACCEPTANCE_CHECK_STATUS_VALUES = [
  'pending',
  'passed',
  'failed',
  'unavailable',
  'superseded',
] as const;
export type GoalAcceptanceCheckStatus = (typeof GOAL_ACCEPTANCE_CHECK_STATUS_VALUES)[number];
export const GoalAcceptanceCheckStatusSchema = asEnum(GOAL_ACCEPTANCE_CHECK_STATUS_VALUES);

/**
 * PlanRevision status: `proposed → accepted | rejected`. A revision's content never changes; which
 * accepted revision is in force is the GoalRun's `current_revision`, so "superseded" is derived
 * (an accepted revision older than the current one), not a status. Accepting requires the revision
 * to be based on the current one (I-G3's optimistic concurrency, a DB trigger).
 */
export const PLAN_REVISION_STATUS_VALUES = ['proposed', 'accepted', 'rejected'] as const;
export type PlanRevisionStatus = (typeof PLAN_REVISION_STATUS_VALUES)[number];
export const PlanRevisionStatusSchema = asEnum(PLAN_REVISION_STATUS_VALUES);

/**
 * StepRun status (§3.4): `pending` (dependencies not met) `→ ready → running` (a Task runs an
 * attempt) `⇄ waiting → succeeded | failed`; `failed → ready` for a retryable failure under the
 * attempt limit; `superseded` (a revision removed or redefined the step), `cancelled` (its GoalRun
 * was cancelled), `skipped`. Terminal: `succeeded`, `superseded`, `cancelled`, `skipped`.
 */
export const STEP_RUN_STATUS_VALUES = [
  'pending',
  'ready',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'superseded',
  'cancelled',
  'skipped',
] as const;
export type StepRunStatus = (typeof STEP_RUN_STATUS_VALUES)[number];
export const StepRunStatusSchema = asEnum(STEP_RUN_STATUS_VALUES);

/**
 * What a `waiting` StepRun waits on (§3.4, §4.8) — set exactly while it waits: an ActionRequest's
 * decision or execution (`approval`), a reconcile observation after an outcome-unknown action
 * (`reconcile`, §4.7), or something outside the platform (`external`).
 */
export const STEP_RUN_WAITING_REASON_VALUES = ['approval', 'reconcile', 'external'] as const;
export type StepRunWaitingReason = (typeof STEP_RUN_WAITING_REASON_VALUES)[number];
export const StepRunWaitingReasonSchema = asEnum(STEP_RUN_WAITING_REASON_VALUES);

/**
 * Why a StepRun is `failed` (§4.7's failure classification) — set exactly while it is failed:
 *   - `transient`: the attempt's Task could not run or died (spawn failure, container crash), or
 *     an action of the step was not delivered (ActionRequest `failure_kind = not_delivered`) — a
 *     new attempt is safe;
 *   - `authority_lost`: the requester no longer holds what the step needs (Handle mint failed, 403);
 *   - `contract_violation`: the output failed its schema, or no result was reported;
 *   - `verification_failed`: the step's acceptance check came back false;
 *   - `outcome_unknown`: an action may have run and the reconcile observation could not confirm
 *     it either way — never retried automatically;
 *   - `action_refused`: an action was refused by the gate or its target, rejected, expired or
 *     denied — asking again unchanged gets the same answer.
 * Only `transient` is retried without a decision; the others pause the GoalRun for one.
 */
export const STEP_RUN_FAILURE_CATEGORY_VALUES = [
  'transient',
  'authority_lost',
  'contract_violation',
  'verification_failed',
  'outcome_unknown',
  'action_refused',
] as const;
export type StepRunFailureCategory = (typeof STEP_RUN_FAILURE_CATEGORY_VALUES)[number];
export const StepRunFailureCategorySchema = asEnum(STEP_RUN_FAILURE_CATEGORY_VALUES);

// ---------------------------------------------------------------------------------------------
// S11 P1 ChangePlan (docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1, §3.4, §5.4)
// ---------------------------------------------------------------------------------------------

/**
 * A workspace ChangeSegment's status (§3.4, P1's first cut — §5.4 "第一版收窄"). The owner previews a
 * segment (dry run, classification, digest — nothing stored) and applies it in one transaction, so a
 * segment row exists from `applied` on; verification can be re-run (`verified ⇄
 * verification_failed`); `rolled_back` is final. The states before application (`submitted`,
 * `validated`, `approved`, …) belong to segments whose proposer is not their approver, which AA3
 * brings.
 */
export const CHANGE_SEGMENT_STATUS_VALUES = [
  'applied',
  'verified',
  'verification_failed',
  'rolled_back',
] as const;
export type ChangeSegmentStatus = (typeof CHANGE_SEGMENT_STATUS_VALUES)[number];
export const ChangeSegmentStatusSchema = asEnum(CHANGE_SEGMENT_STATUS_VALUES);

/** What a ChangeItem is an intent to do (§5.4: a call of an existing publish / configuration
 *  capability). P1-A has one: publish a version of an ontology family. */
export const CHANGE_ITEM_KIND_VALUES = ['ontology_version'] as const;
export type ChangeItemKind = (typeof CHANGE_ITEM_KIND_VALUES)[number];
export const ChangeItemKindSchema = asEnum(CHANGE_ITEM_KIND_VALUES);

/**
 * I-A4: a ChangeItem is `not_widening` only when every field it changes is on its kind's list of
 * changes proven not to widen authority; anything else is `authority_widening` and needs a person to
 * confirm that item by itself.
 */
export const CHANGE_ITEM_CLASSIFICATION_VALUES = ['not_widening', 'authority_widening'] as const;
export type ChangeItemClassification = (typeof CHANGE_ITEM_CLASSIFICATION_VALUES)[number];
export const ChangeItemClassificationSchema = asEnum(CHANGE_ITEM_CLASSIFICATION_VALUES);

/** Why one change of an item widens authority (I-A4; the kernel's whitelist classifier,
 *  `application/change-plan/classify.ts`, says where and which of these). */
export const CHANGE_WIDENING_REASON_VALUES = [
  /** A governance declaration that did not exist before (e.g. a new ActionType). */
  'added',
  /** A governance declaration that no longer exists: what it held in place falls back to a
   *  default nobody reviewed here, so its removal is not proven to narrow anything. */
  'removed',
  /** A field with a known order of strictness moved to a looser value. */
  'loosened',
  /** A field whose direction is not proven changed (any change to it needs confirmation). */
  'changed',
  /** A field no rule covers (whitelist: unknown is widening). */
  'unrecognized',
] as const;
export type ChangeWideningReasonCode = (typeof CHANGE_WIDENING_REASON_VALUES)[number];
export const ChangeWideningReasonCodeSchema = asEnum(CHANGE_WIDENING_REASON_VALUES);

/** How a segment was applied: `human` — the applier's own capability call; `platform` — the
 *  platform applied it on the workspace's behalf (workspace creation's default modules). */
export const CHANGE_CHANNEL_VALUES = ['human', 'platform'] as const;
export type ChangeChannelValue = (typeof CHANGE_CHANNEL_VALUES)[number];
export const ChangeChannelSchema = asEnum(CHANGE_CHANNEL_VALUES);

/** Where a segment's intent came from (§5.4 "一个核心，两种来源"): P1 has packs (a module is a pack
 *  with one ontology component); the platform admin agent's proposals come with AA3. */
export const CHANGE_SOURCE_KIND_VALUES = ['pack'] as const;
export type ChangeSourceKind = (typeof CHANGE_SOURCE_KIND_VALUES)[number];
export const ChangeSourceKindSchema = asEnum(CHANGE_SOURCE_KIND_VALUES);

/**
 * An applied item's target now (S11 P1-B, read at the time of the call): `in_effect` — what the item
 * wrote is still there (for an ontology item: the version it published is the family's head);
 * `replaced` — something written later took its place; `not_installed` — the target no longer
 * exists (an ontology family with no published version).
 */
export const CHANGE_ITEM_STATE_VALUES = ['in_effect', 'replaced', 'not_installed'] as const;
export type ChangeItemState = (typeof CHANGE_ITEM_STATE_VALUES)[number];
export const ChangeItemStateSchema = asEnum(CHANGE_ITEM_STATE_VALUES);

/**
 * Why an item of a segment cannot be rolled back now (S11 P1-B, §3.4 "逆操作遇到中间被别人改过的版本
 * 时停下不覆盖"): `replaced` — its target was changed after it (roll that change back first, or it was
 * made outside the ChangePlan core); `not_installed` — its target no longer exists; `restored_
 * version_missing` — the state it would return to is gone; `namespace_conflict` — what it would
 * restore declares a type name another ontology family has taken since (I-P1).
 */
export const CHANGE_ROLLBACK_BLOCKER_VALUES = [
  'replaced',
  'not_installed',
  'restored_version_missing',
  'namespace_conflict',
] as const;
export type ChangeRollbackBlocker = (typeof CHANGE_ROLLBACK_BLOCKER_VALUES)[number];
export const ChangeRollbackBlockerSchema = asEnum(CHANGE_ROLLBACK_BLOCKER_VALUES);

/**
 * Which ChangeItem put an ontology family's installed version there (S11 §3.2 `Object changed_by
 * ChangeItem`): `recorded` — an item of an applied segment; `provenance_unknown` — installed before
 * P1, or published outside the ChangePlan core (`publish_ontology_version`, `seed-domain-pack`), so
 * nothing records it and it cannot be rolled back from here; `not_installed` — no published version.
 */
export const ONTOLOGY_PROVENANCE_STATUS_VALUES = [
  'recorded',
  'provenance_unknown',
  'not_installed',
] as const;
export type OntologyProvenanceStatus = (typeof ONTOLOGY_PROVENANCE_STATUS_VALUES)[number];
export const OntologyProvenanceStatusSchema = asEnum(ONTOLOGY_PROVENANCE_STATUS_VALUES);

/**
 * What a workspace has of a pack, or of one of its components (S11 P1-C, Pack Contract v1; derived
 * from each component's current content, never stored): `not_installed` — nothing; `up_to_date` —
 * the latest version's content; `outdated` — an older version's; `customized` — content no version
 * of the pack has (published outside it, or only part of a version). The same four as a module's
 * (`ModuleInstallStatusWireSchema`, a module being a pack with one component).
 */
export const PACK_INSTALL_STATUS_VALUES = [
  'not_installed',
  'up_to_date',
  'outdated',
  'customized',
] as const;
export type PackInstallStatus = (typeof PACK_INSTALL_STATUS_VALUES)[number];
export const PackInstallStatusSchema = asEnum(PACK_INSTALL_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.5 Publishable lifecycle (OntologyVersion / WorkerDefinition / Skill / Procedure / Manifest)
// ---------------------------------------------------------------------------------------------

/**
 * Publishable status (§5.5, §5.1.4, I12, I16): `draft → published → deprecated`, shared by every
 * platform meta-object that can only be published over the human channel.
 */
export const PUBLISHABLE_STATUS_VALUES = ['draft', 'published', 'deprecated'] as const;
export type PublishableStatus = (typeof PUBLISHABLE_STATUS_VALUES)[number];
export const PublishableStatusSchema = asEnum(PUBLISHABLE_STATUS_VALUES);

/**
 * Operation status (legacy 278, UX acceptance of #577): the publishable lifecycle plus one terminal
 * state, `discarded` — a draft the workspace decided not to publish (`discard_operation_draft`).
 * Unlike the other registries' drafts (`DRAFT_KIND_VALUES` below, deleted outright), an Operation
 * draft is a graph Object with an `exposes` Fact and provenance pointing at it, so it is never
 * deleted: the row stays, marked, and every directory read leaves it out. A discarded row's
 * `version` is never reused — the identity's next draft takes the version above it.
 */
export const OPERATION_STATUS_VALUES = [...PUBLISHABLE_STATUS_VALUES, 'discarded'] as const;
export type OperationStatus = (typeof OPERATION_STATUS_VALUES)[number];
export const OperationStatusSchema = asEnum(OPERATION_STATUS_VALUES);

/**
 * Draft kind (S8 W3 K2, leftover 82; `ontology_version` added by leftover 99): the
 * `Publishable`-lifecycle registries whose `draft` rows are proposer-private (I16) and can be
 * discarded (`discard_draft`, manual). The periodic expiry sweep covers only the first three
 * (`ontology_version` drafts are discard-only) — see `packages/kernel/src/application/worker/draft-lifecycle.ts`. Not
 * a fourth `PublishableStatus` value: discard/expiry delete the row outright rather than adding a
 * `discarded`/`expired` terminal status. Operation drafts are not one of these kinds: they are
 * discarded as a status (`OPERATION_STATUS_VALUES` above, `discard_operation_draft`).
 */
export const DRAFT_KIND_VALUES = [
  'worker_definition',
  'skill',
  'procedure',
  'ontology_version',
] as const;
export type DraftKind = (typeof DRAFT_KIND_VALUES)[number];
export const DraftKindSchema = asEnum(DRAFT_KIND_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.5 CapabilityGrant
// ---------------------------------------------------------------------------------------------

/** Grant status (§5.5): `active → revoked | expired`. */
export const GRANT_STATUS_VALUES = ['active', 'revoked', 'expired'] as const;
export type GrantStatus = (typeof GRANT_STATUS_VALUES)[number];
export const GrantStatusSchema = asEnum(GRANT_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.1.4 Connection (S2.13): `requested → completed | cancelled`.
// ---------------------------------------------------------------------------------------------

/** ConnectionRequest status (S2.13, docs/development-tasks.md S2.13; design doc §5.1.4
 *  Connection "建立"): a human-facing card produced by `request_connection`, resolved by the
 *  owner's `create_connection` (this repo's implementation of the task brief's
 *  `complete_connection`, see governance/connections/service.ts's own doc comment). */
export const CONNECTION_REQUEST_STATUS_VALUES = ['requested', 'completed', 'cancelled'] as const;
export type ConnectionRequestStatus = (typeof CONNECTION_REQUEST_STATUS_VALUES)[number];
export const ConnectionRequestStatusSchema = asEnum(CONNECTION_REQUEST_STATUS_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.1.4 Operation / Capability metadata
// ---------------------------------------------------------------------------------------------

/** Operation / capability mode (§5.1.4, §9.3): observe (read-only) vs execute (governed write). */
export const OPERATION_MODE_VALUES = ['observe', 'execute'] as const;
export type OperationMode = (typeof OPERATION_MODE_VALUES)[number];
export const OperationModeSchema = asEnum(OPERATION_MODE_VALUES);

/** Blast radius (§5.1.4, §11): low auto-approves by default; medium/high require a human. */
export const BLAST_RADIUS_VALUES = ['low', 'medium', 'high'] as const;
export type BlastRadius = (typeof BLAST_RADIUS_VALUES)[number];
export const BlastRadiusSchema = asEnum(BLAST_RADIUS_VALUES);

/**
 * Policy decision (§5.1.4 Policy "allow / require_approval / deny", §5.4 I7/I8; §9.2
 * `action_requests.policy_decision` CHECK, migrations/governance/0003_action_requests.sql). Gap
 * flagged by S2.1 (see that migration's own header comment and
 * packages/kernel/src/adapters/db/governance-schema.test.ts's `KNOWN_UNMAPPED_CHECKS`): this is
 * the `packages/shared` counterpart the policy engine (S2.2) owns.
 */
export const POLICY_DECISION_VALUES = ['allow', 'require_approval', 'deny'] as const;
export type PolicyDecision = (typeof POLICY_DECISION_VALUES)[number];
export const PolicyDecisionSchema = asEnum(POLICY_DECISION_VALUES);

/** Capability channel (§5.3, §9.3): human (web/API-key) vs handle (agent Handle, MCP/tool calls). */
export const CAPABILITY_CHANNEL_VALUES = ['human', 'handle'] as const;
export type CapabilityChannel = (typeof CAPABILITY_CHANNEL_VALUES)[number];
export const CapabilityChannelSchema = asEnum(CAPABILITY_CHANNEL_VALUES);

/** WorkerDefinition kind (§5.1.4, §9.2 `worker_definitions.kind` CHECK): entry vs worker. */
export const WORKER_DEFINITION_KIND_VALUES = ['entry', 'worker'] as const;
export type WorkerDefinitionKind = (typeof WORKER_DEFINITION_KIND_VALUES)[number];
export const WorkerDefinitionKindSchema = asEnum(WORKER_DEFINITION_KIND_VALUES);

/** Platform extension mode (§7.4 `NEXTTIME_MODE`): entry / worker / interactive (your local pi). */
export const EXTENSION_MODE_VALUES = ['entry', 'worker', 'interactive'] as const;
export type ExtensionMode = (typeof EXTENSION_MODE_VALUES)[number];
export const ExtensionModeSchema = asEnum(EXTENSION_MODE_VALUES);

// ---------------------------------------------------------------------------------------------
// §5.1.2 Platform meta-ontology (S2.6): the ObjectTypes that "对象化平台自身" — WorkerDefinition,
// Gatekeeper, Operation, Capability, Skill, Procedure are all `objects` rows, and I16 ("平台元本体
// 对象只能经 human 通道发布；Handle 通道只能写对提议者私有的草稿") applies uniformly to all six. Kept
// here (domain layer) rather than kernel-local so both `application/gateway` (the I16 guard on the
// graph write path) and `substrate/ontology` (the object-projection helpers, e.g.
// `registerGatekeeperObject`) can import the same list without either depending on the other.
// ---------------------------------------------------------------------------------------------

export const META_ONTOLOGY_OBJECT_TYPE_VALUES = [
  'WorkerDefinition',
  'Gatekeeper',
  'Operation',
  'Capability',
  'Skill',
  'Procedure',
] as const;
export type MetaOntologyObjectType = (typeof META_ONTOLOGY_OBJECT_TYPE_VALUES)[number];
export const MetaOntologyObjectTypeSchema = asEnum(META_ONTOLOGY_OBJECT_TYPE_VALUES);

/** Whether `objectType` names one of the six platform meta-ontology ObjectTypes (I16 scope). */
export function isMetaOntologyObjectType(objectType: string): objectType is MetaOntologyObjectType {
  return (META_ONTOLOGY_OBJECT_TYPE_VALUES as readonly string[]).includes(objectType);
}
