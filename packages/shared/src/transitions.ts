import type {
  ActionRequestStatus,
  ChangeSegmentStatus,
  ConflictStatus,
  ConnectionRequestStatus,
  DecisionStatus,
  EpistemicStatus,
  GoalRunStatus,
  GrantStatus,
  OperationStatus,
  PlanRevisionStatus,
  PublishableStatus,
  StepRunStatus,
  TaskStatus,
  TurnStatus,
  WorkerRunStatus,
} from './enums.js';

/**
 * State machines (design doc §5.5), transition-table-driven per docs/development-tasks.md §0.3
 * ("状态机一律转移表驱动，非法转移抛 `IllegalTransition`"). Pure data + pure functions — no IO.
 */

/** One legal edge in a state machine: applying `event` while in `from` yields `to`. */
export interface StateTransition<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
}

/**
 * A named transition table: `edges` is exactly the `{from, event, to}[]` data the design doc
 * calls for; `machine` is carried alongside so `IllegalTransition` can report which state machine
 * rejected the transition without every edge having to repeat that name.
 */
export interface TransitionTable<S extends string, E extends string> {
  readonly machine: string;
  readonly edges: readonly StateTransition<S, E>[];
}

/** Thrown by `transition()` when no edge matches `(from, event)` in the given table. */
export class IllegalTransition extends Error {
  readonly machine: string;
  readonly from: string;
  readonly event: string;

  constructor(machine: string, from: string, event: string) {
    super(`${machine}: illegal transition — no edge from "${from}" on event "${event}"`);
    this.name = 'IllegalTransition';
    this.machine = machine;
    this.from = from;
    this.event = event;
  }
}

/** Applies `event` to `from` per `table`; returns the resulting state or throws `IllegalTransition`. */
export function transition<S extends string, E extends string>(
  table: TransitionTable<S, E>,
  from: S,
  event: E,
): S {
  const edge = table.edges.find(
    (candidate) => candidate.from === from && candidate.event === event,
  );
  if (!edge) {
    throw new IllegalTransition(table.machine, from, event);
  }
  return edge.to;
}

/** Same lookup as `transition()` but returns a boolean instead of throwing. */
export function canTransition<S extends string, E extends string>(
  table: TransitionTable<S, E>,
  from: S,
  event: E,
): boolean {
  return table.edges.some((candidate) => candidate.from === from && candidate.event === event);
}

// ---------------------------------------------------------------------------------------------
// Fact lifecycle (§5.5): `recorded → superseded | invalidated`. Kept separate from epistemic
// promotion below — lifecycle and epistemic status are independent columns per §5.5/§5.6.
// ---------------------------------------------------------------------------------------------

export const FACT_LIFECYCLE_STATUS_VALUES = ['recorded', 'superseded', 'invalidated'] as const;
export type FactLifecycleStatus = (typeof FACT_LIFECYCLE_STATUS_VALUES)[number];

export const FACT_LIFECYCLE_EVENT_VALUES = ['supersede', 'invalidate'] as const;
export type FactLifecycleEvent = (typeof FACT_LIFECYCLE_EVENT_VALUES)[number];

export const FACT_LIFECYCLE_EDGES: readonly StateTransition<
  FactLifecycleStatus,
  FactLifecycleEvent
>[] = [
  { from: 'recorded', event: 'supersede', to: 'superseded' },
  { from: 'recorded', event: 'invalidate', to: 'invalidated' },
];

export const FACT_LIFECYCLE_TRANSITIONS: TransitionTable<FactLifecycleStatus, FactLifecycleEvent> =
  {
    machine: 'FactLifecycle',
    edges: FACT_LIFECYCLE_EDGES,
  };

// ---------------------------------------------------------------------------------------------
// Epistemic promotion (§5.5/§5.6): `observed|extracted|inferred|asserted → verified`;
// `any → contradicted` (read as: any of the five non-`contradicted` states).
// ---------------------------------------------------------------------------------------------

export const EPISTEMIC_PROMOTION_EVENT_VALUES = ['verify', 'contradict'] as const;
export type EpistemicPromotionEvent = (typeof EPISTEMIC_PROMOTION_EVENT_VALUES)[number];

const EPISTEMIC_SOURCES_FOR_VERIFY: readonly EpistemicStatus[] = [
  'observed',
  'extracted',
  'inferred',
  'asserted',
];
const EPISTEMIC_SOURCES_FOR_CONTRADICT: readonly EpistemicStatus[] = [
  'observed',
  'extracted',
  'inferred',
  'asserted',
  'verified',
];

export const EPISTEMIC_PROMOTION_EDGES: readonly StateTransition<
  EpistemicStatus,
  EpistemicPromotionEvent
>[] = [
  ...EPISTEMIC_SOURCES_FOR_VERIFY.map((from) => ({
    from,
    event: 'verify' as const,
    to: 'verified' as const,
  })),
  ...EPISTEMIC_SOURCES_FOR_CONTRADICT.map((from) => ({
    from,
    event: 'contradict' as const,
    to: 'contradicted' as const,
  })),
];

export const EPISTEMIC_PROMOTION_TRANSITIONS: TransitionTable<
  EpistemicStatus,
  EpistemicPromotionEvent
> = {
  machine: 'EpistemicPromotion',
  edges: EPISTEMIC_PROMOTION_EDGES,
};

// ---------------------------------------------------------------------------------------------
// Conflict (§5.5): `open → resolved | accepted_both | dismissed`.
// ---------------------------------------------------------------------------------------------

export const CONFLICT_EVENT_VALUES = ['resolve', 'accept_both', 'dismiss'] as const;
export type ConflictEvent = (typeof CONFLICT_EVENT_VALUES)[number];

export const CONFLICT_EDGES: readonly StateTransition<ConflictStatus, ConflictEvent>[] = [
  { from: 'open', event: 'resolve', to: 'resolved' },
  { from: 'open', event: 'accept_both', to: 'accepted_both' },
  { from: 'open', event: 'dismiss', to: 'dismissed' },
];

export const CONFLICT_TRANSITIONS: TransitionTable<ConflictStatus, ConflictEvent> = {
  machine: 'Conflict',
  edges: CONFLICT_EDGES,
};

// ---------------------------------------------------------------------------------------------
// Decision (§5.5): `proposed → approved | rejected → executed → verified | failed → superseded |
// archived`. Reading (see PR body "假设"): the chain is stage-wise, not "rejected also executes" —
// `rejected` is terminal; `approved` is the only path into `executed`; `verified` and `failed`
// both terminate into `superseded` or `archived`.
// ---------------------------------------------------------------------------------------------

export const DECISION_EVENT_VALUES = [
  'approve',
  'reject',
  'execute',
  'verify',
  'fail',
  'supersede',
  'archive',
] as const;
export type DecisionEvent = (typeof DECISION_EVENT_VALUES)[number];

export const DECISION_EDGES: readonly StateTransition<DecisionStatus, DecisionEvent>[] = [
  { from: 'proposed', event: 'approve', to: 'approved' },
  { from: 'proposed', event: 'reject', to: 'rejected' },
  { from: 'approved', event: 'execute', to: 'executed' },
  { from: 'executed', event: 'verify', to: 'verified' },
  { from: 'executed', event: 'fail', to: 'failed' },
  { from: 'verified', event: 'supersede', to: 'superseded' },
  { from: 'verified', event: 'archive', to: 'archived' },
  { from: 'failed', event: 'supersede', to: 'superseded' },
  { from: 'failed', event: 'archive', to: 'archived' },
];

export const DECISION_TRANSITIONS: TransitionTable<DecisionStatus, DecisionEvent> = {
  machine: 'Decision',
  edges: DECISION_EDGES,
};

// ---------------------------------------------------------------------------------------------
// ActionRequest (§5.5, §9.2 v0.1 13-state graph; policy engine §7.1/I8, approval §S2.3, execution
// §8.1, compensation §13). Reading (see PR body "假设"): the design doc gives the state list and
// the surrounding prose (policy.evaluate → allow|require_approval|deny; double-signal
// auto-approval I8; approval per I14; apply/revert/compensate §13) but not a literal edge list —
// the edges below are the smallest graph consistent with that prose and with every one of the 13
// states being reachable and (except the deliberately terminal ones) able to progress.
// ---------------------------------------------------------------------------------------------

export const ACTION_REQUEST_EVENT_VALUES = [
  'evaluate_policy',
  'auto_approve',
  'require_approval',
  'deny',
  'approve',
  'reject',
  'expire',
  'start_execution',
  'complete',
  'fail',
  'verify',
  'compensate',
  'withdraw',
] as const;
export type ActionRequestEvent = (typeof ACTION_REQUEST_EVENT_VALUES)[number];

export const ACTION_REQUEST_EDGES: readonly StateTransition<
  ActionRequestStatus,
  ActionRequestEvent
>[] = [
  { from: 'proposed', event: 'evaluate_policy', to: 'policy_evaluated' },
  { from: 'policy_evaluated', event: 'auto_approve', to: 'auto_approved' },
  { from: 'policy_evaluated', event: 'require_approval', to: 'pending_approval' },
  { from: 'policy_evaluated', event: 'deny', to: 'denied' },
  { from: 'pending_approval', event: 'approve', to: 'approved' },
  { from: 'pending_approval', event: 'reject', to: 'rejected' },
  { from: 'pending_approval', event: 'expire', to: 'expired' },
  { from: 'auto_approved', event: 'start_execution', to: 'executing' },
  { from: 'approved', event: 'start_execution', to: 'executing' },
  { from: 'executing', event: 'complete', to: 'executed' },
  { from: 'executing', event: 'fail', to: 'failed' },
  { from: 'executed', event: 'verify', to: 'verified' },
  { from: 'failed', event: 'compensate', to: 'compensated' },
  // S11 GO1 (plan I-G9): a request whose step was cancelled or revised away is taken back before it
  // runs — while it awaits a decision, or once approved (by a person or by policy) and still queued
  // behind its Gatekeeper's earlier requests (R-50). `auto_approved` is withdrawn for the same
  // reason as `approved`: both are "approved, not yet executing", and leaving it out would let a
  // cancelled step's queued action run. `executing` is never withdrawn: the call may already be
  // with the gate, so it ends the R-48 way instead.
  { from: 'pending_approval', event: 'withdraw', to: 'withdrawn' },
  { from: 'approved', event: 'withdraw', to: 'withdrawn' },
  { from: 'auto_approved', event: 'withdraw', to: 'withdrawn' },
];

export const ACTION_REQUEST_TRANSITIONS: TransitionTable<ActionRequestStatus, ActionRequestEvent> =
  {
    machine: 'ActionRequest',
    edges: ACTION_REQUEST_EDGES,
  };

// ---------------------------------------------------------------------------------------------
// Task (§5.5): `created → queued → running ⇄ waiting_approval → completed | failed | cancelled`.
// ---------------------------------------------------------------------------------------------

export const TASK_EVENT_VALUES = [
  'queue',
  'start',
  'await_approval',
  'resume',
  'complete',
  'fail',
  'cancel',
] as const;
export type TaskEvent = (typeof TASK_EVENT_VALUES)[number];

export const TASK_EDGES: readonly StateTransition<TaskStatus, TaskEvent>[] = [
  { from: 'created', event: 'queue', to: 'queued' },
  { from: 'queued', event: 'start', to: 'running' },
  { from: 'running', event: 'await_approval', to: 'waiting_approval' },
  { from: 'waiting_approval', event: 'resume', to: 'running' },
  { from: 'running', event: 'complete', to: 'completed' },
  { from: 'running', event: 'fail', to: 'failed' },
  { from: 'running', event: 'cancel', to: 'cancelled' },
  // P1-6 fix (review job 652a4abc): a Task's own WorkerRun can die (exit/crash/terminate) while
  // the Task itself is `waiting_approval` — the ActionRequest it is blocked on has nothing more to
  // say about whether that WorkerRun is still alive. Before this edge, `application/task/
  // lifecycle.ts`'s `failTaskRow` had to synthesize a `resume` hop first (never externally
  // observable — the same "single write already at the resolved state" convention this table's
  // own `queued`/`waiting_approval` multi-hop callers already use) to reach `running` before
  // `fail` was legal; a direct edge makes the real, always-legal transition explicit in the table
  // itself rather than only in a caller-local hop list.
  { from: 'waiting_approval', event: 'fail', to: 'failed' },
];

export const TASK_TRANSITIONS: TransitionTable<TaskStatus, TaskEvent> = {
  machine: 'Task',
  edges: TASK_EDGES,
};

// ---------------------------------------------------------------------------------------------
// WorkerRun (§5.5): `provisioning → running → suspended → terminated`; terminated revokes every
// Handle. Reading (see PR body "假设"): `suspended` mirrors Task's `waiting_approval` (a WorkerRun
// suspends while its ActionRequest awaits approval, then resumes), so it round-trips with
// `running`, and `terminated` is reachable directly from `running` (the normal completion path)
// as well as from `suspended` (terminated while awaiting approval).
//
// S2.7 addition: `{from: 'provisioning', event: 'terminate', to: 'terminated'}` — a WorkerRun row
// is created (`provisioning`) *before* `invoke_worker` calls the supervisor's `/task/spawn` (the
// row needs an id to hand the supervisor); if that call fails (network error, image not
// allowlisted, quota race) the row must still reach a terminal state without ever having been
// `running` — the pre-existing table had no edge out of `provisioning` other than `start`, which
// would make a failed spawn an illegal transition. See governance/capability/handles.ts's own
// worker-ceiling doc comment for the invoke_worker flow this closes a gap for.
// ---------------------------------------------------------------------------------------------

export const WORKER_RUN_EVENT_VALUES = ['start', 'suspend', 'resume', 'terminate'] as const;
export type WorkerRunEvent = (typeof WORKER_RUN_EVENT_VALUES)[number];

export const WORKER_RUN_EDGES: readonly StateTransition<WorkerRunStatus, WorkerRunEvent>[] = [
  { from: 'provisioning', event: 'start', to: 'running' },
  { from: 'provisioning', event: 'terminate', to: 'terminated' },
  { from: 'running', event: 'suspend', to: 'suspended' },
  { from: 'suspended', event: 'resume', to: 'running' },
  { from: 'running', event: 'terminate', to: 'terminated' },
  { from: 'suspended', event: 'terminate', to: 'terminated' },
];

export const WORKER_RUN_TRANSITIONS: TransitionTable<WorkerRunStatus, WorkerRunEvent> = {
  machine: 'WorkerRun',
  edges: WORKER_RUN_EDGES,
};

// ---------------------------------------------------------------------------------------------
// Turn (§9.2 `activities(kind='agent_turn')`, §13 "Turn 非法转移被拒"): `running → completed |
// interrupted | failed`; every end state is terminal — a late `completed` never overwrites an
// `interrupted` or `failed` Turn (2026-10-02 review R-55). The one table every kernel writer of a
// Turn's status goes through (`application/chat`'s `endTurn`). Replaces the EntryAgent session
// table that stood here: no code ever moved an entry session through it (the kernel's `entry`
// session rows carry no lifecycle; the resident container's state lives in agent-host and
// worker-supervisor), so it described nothing the system enforced.
// ---------------------------------------------------------------------------------------------

export const TURN_EVENT_VALUES = ['complete', 'interrupt', 'fail'] as const;
export type TurnEvent = (typeof TURN_EVENT_VALUES)[number];

export const TURN_EDGES: readonly StateTransition<TurnStatus, TurnEvent>[] = [
  { from: 'running', event: 'complete', to: 'completed' },
  { from: 'running', event: 'interrupt', to: 'interrupted' },
  { from: 'running', event: 'fail', to: 'failed' },
];

export const TURN_TRANSITIONS: TransitionTable<TurnStatus, TurnEvent> = {
  machine: 'Turn',
  edges: TURN_EDGES,
};

// ---------------------------------------------------------------------------------------------
// Publishable lifecycle (§5.5, I12, I16): `draft → published → deprecated`. Shared by
// OntologyVersion, WorkerDefinition, Skill, Procedure, and InterfaceManifest — one machine, reused
// across every ObjectType that carries `PublishableStatus`.
// ---------------------------------------------------------------------------------------------

export const PUBLISHABLE_EVENT_VALUES = ['publish', 'deprecate'] as const;
export type PublishableEvent = (typeof PUBLISHABLE_EVENT_VALUES)[number];

export const PUBLISHABLE_EDGES: readonly StateTransition<PublishableStatus, PublishableEvent>[] = [
  { from: 'draft', event: 'publish', to: 'published' },
  { from: 'published', event: 'deprecate', to: 'deprecated' },
];

export const PUBLISHABLE_TRANSITIONS: TransitionTable<PublishableStatus, PublishableEvent> = {
  machine: 'Publishable',
  edges: PUBLISHABLE_EDGES,
};

// ---------------------------------------------------------------------------------------------
// Operation (legacy 278): the publishable lifecycle plus `draft → discarded` — a draft the
// workspace decided not to publish, kept as a marked row rather than deleted (enums.ts's
// `OPERATION_STATUS_VALUES`). `discarded` is terminal.
// ---------------------------------------------------------------------------------------------

export const OPERATION_EVENT_VALUES = [...PUBLISHABLE_EVENT_VALUES, 'discard'] as const;
export type OperationEvent = (typeof OPERATION_EVENT_VALUES)[number];

export const OPERATION_EDGES: readonly StateTransition<OperationStatus, OperationEvent>[] = [
  ...PUBLISHABLE_EDGES,
  { from: 'draft', event: 'discard', to: 'discarded' },
];

export const OPERATION_TRANSITIONS: TransitionTable<OperationStatus, OperationEvent> = {
  machine: 'Operation',
  edges: OPERATION_EDGES,
};

// ---------------------------------------------------------------------------------------------
// CapabilityGrant (§5.5): `active → revoked | expired`.
// ---------------------------------------------------------------------------------------------

export const GRANT_EVENT_VALUES = ['revoke', 'expire'] as const;
export type GrantEvent = (typeof GRANT_EVENT_VALUES)[number];

export const GRANT_EDGES: readonly StateTransition<GrantStatus, GrantEvent>[] = [
  { from: 'active', event: 'revoke', to: 'revoked' },
  { from: 'active', event: 'expire', to: 'expired' },
];

export const GRANT_TRANSITIONS: TransitionTable<GrantStatus, GrantEvent> = {
  machine: 'Grant',
  edges: GRANT_EDGES,
};

// ---------------------------------------------------------------------------------------------
// ConnectionRequest (S2.13, §5.1.4 Connection "建立"): `requested → completed | cancelled`.
// ---------------------------------------------------------------------------------------------

export const CONNECTION_REQUEST_EVENT_VALUES = ['complete', 'cancel'] as const;
export type ConnectionRequestEvent = (typeof CONNECTION_REQUEST_EVENT_VALUES)[number];

export const CONNECTION_REQUEST_EDGES: readonly StateTransition<
  ConnectionRequestStatus,
  ConnectionRequestEvent
>[] = [
  { from: 'requested', event: 'complete', to: 'completed' },
  { from: 'requested', event: 'cancel', to: 'cancelled' },
];

export const CONNECTION_REQUEST_TRANSITIONS: TransitionTable<
  ConnectionRequestStatus,
  ConnectionRequestEvent
> = {
  machine: 'ConnectionRequest',
  edges: CONNECTION_REQUEST_EDGES,
};

// ---------------------------------------------------------------------------------------------
// GoalRun (S11 GO1; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.4). The whole
// graph is also enforced by the database (migrations/goal/0001 `goal_runs_status_guard`; a test
// compares the two edge sets pair by pair) — these are new tables no earlier release writes, so
// the guard costs no reversibility.
//
// Two edges beyond the §3.4 sketch: `verifying → cancelling` (a person may cancel while the
// platform runs the acceptance checks — otherwise a cancel during a long observation would be an
// illegal transition with nothing to wait for), and `cancelling → failed` (an unrecoverable error
// can happen while cleaning up too: "任意非终态 → failed").
// ---------------------------------------------------------------------------------------------

export const GOAL_RUN_EVENT_VALUES = [
  'confirm',
  'reject',
  'pause',
  'resume',
  'verify',
  'complete',
  'cancel',
  'finish_cancel',
  'fail',
] as const;
export type GoalRunEvent = (typeof GOAL_RUN_EVENT_VALUES)[number];

/**
 * What happened to a GoalRun (S11 GO5e-2): an event of the transition table below, or a change
 * that is not a transition — its proposal (`propose`: the row is created `proposed`), a workspace
 * owner taking over a person's pause or lifting that hold (`hold` / `release_hold`, GO3b), a
 * revision accepted while it is paused (`revise`), or the leftovers of a cancel gone
 * (`cleanup_finished`). `GoalRunUpdated` carries it and the audit action names it
 * (`goal_run.<change>`), so a consumer knows which change it reads without comparing rows.
 */
export const GOAL_RUN_CHANGE_VALUES = [
  ...GOAL_RUN_EVENT_VALUES,
  'propose',
  'hold',
  'release_hold',
  'revise',
  'cleanup_finished',
] as const;
export type GoalRunChange = (typeof GOAL_RUN_CHANGE_VALUES)[number];

export const GOAL_RUN_EDGES: readonly StateTransition<GoalRunStatus, GoalRunEvent>[] = [
  // The requester confirms plan + acceptance checks + budget; or it is rejected / expires unconfirmed.
  { from: 'proposed', event: 'confirm', to: 'running' },
  { from: 'proposed', event: 'reject', to: 'cancelled' },
  // Pause reasons are a column (`GOAL_RUN_PAUSE_REASON_VALUES`); a paused run that fails
  // verification is paused for `needs_decision`.
  { from: 'running', event: 'pause', to: 'paused' },
  { from: 'verifying', event: 'pause', to: 'paused' },
  { from: 'paused', event: 'resume', to: 'running' },
  // Every step is done: the platform runs the goal's acceptance checks.
  { from: 'running', event: 'verify', to: 'verifying' },
  // `completed` carries the objective outcome: `achieved` only from verification (I-G5);
  // `not_achieved` when the requester ends a paused run that way.
  { from: 'verifying', event: 'complete', to: 'completed' },
  { from: 'paused', event: 'complete', to: 'completed' },
  // Cancel: no new step starts; `cancelling` lasts until Tasks are terminated, pending and approved
  // actions withdrawn, and executing actions terminal — or the deadline passes
  // (`cleanup_pending`).
  { from: 'running', event: 'cancel', to: 'cancelling' },
  { from: 'paused', event: 'cancel', to: 'cancelling' },
  { from: 'verifying', event: 'cancel', to: 'cancelling' },
  { from: 'cancelling', event: 'finish_cancel', to: 'cancelled' },
  { from: 'proposed', event: 'fail', to: 'failed' },
  { from: 'running', event: 'fail', to: 'failed' },
  { from: 'paused', event: 'fail', to: 'failed' },
  { from: 'verifying', event: 'fail', to: 'failed' },
  { from: 'cancelling', event: 'fail', to: 'failed' },
];

export const GOAL_RUN_TRANSITIONS: TransitionTable<GoalRunStatus, GoalRunEvent> = {
  machine: 'GoalRun',
  edges: GOAL_RUN_EDGES,
};

// ---------------------------------------------------------------------------------------------
// PlanRevision (S11 GO1): `proposed → accepted | rejected`. Content is immutable from creation; the
// DB guard also refuses accepting a revision not based on the GoalRun's current one (I-G3).
// ---------------------------------------------------------------------------------------------

export const PLAN_REVISION_EVENT_VALUES = ['accept', 'reject'] as const;
export type PlanRevisionEvent = (typeof PLAN_REVISION_EVENT_VALUES)[number];

export const PLAN_REVISION_EDGES: readonly StateTransition<
  PlanRevisionStatus,
  PlanRevisionEvent
>[] = [
  { from: 'proposed', event: 'accept', to: 'accepted' },
  { from: 'proposed', event: 'reject', to: 'rejected' },
];

export const PLAN_REVISION_TRANSITIONS: TransitionTable<PlanRevisionStatus, PlanRevisionEvent> = {
  machine: 'PlanRevision',
  edges: PLAN_REVISION_EDGES,
};

// ---------------------------------------------------------------------------------------------
// StepRun (S11 GO1, §3.4). Attempts live only here: each attempt is one Task the advancer creates
// (I-G1), and a retry is `failed → ready`, never a Task-internal retry. Waiting reasons and failure
// categories are columns. A StepRun's definition is the plan entry of the revision that introduced
// it, for its whole life: a revision that drops or changes a step supersedes it (a changed step
// comes back as a new StepRun under the same key), so a live StepRun is always part of the current
// plan (I-G2). Also enforced by the database (`step_runs_status_guard`).
// ---------------------------------------------------------------------------------------------

export const STEP_RUN_EVENT_VALUES = [
  'unblock',
  'start',
  'wait',
  'resume',
  'succeed',
  'fail',
  'retry',
  'supersede',
  'cancel',
  'skip',
] as const;
export type StepRunEvent = (typeof STEP_RUN_EVENT_VALUES)[number];

export const STEP_RUN_EDGES: readonly StateTransition<StepRunStatus, StepRunEvent>[] = [
  { from: 'pending', event: 'unblock', to: 'ready' },
  { from: 'ready', event: 'start', to: 'running' },
  { from: 'running', event: 'wait', to: 'waiting' },
  { from: 'waiting', event: 'resume', to: 'running' },
  // Success needs a valid output, every ActionRequest of the step terminal and the step's
  // acceptance passed (§4.5) — possibly reached while waiting, after the Worker already exited.
  { from: 'running', event: 'succeed', to: 'succeeded' },
  { from: 'waiting', event: 'succeed', to: 'succeeded' },
  { from: 'running', event: 'fail', to: 'failed' },
  { from: 'waiting', event: 'fail', to: 'failed' },
  // A new attempt: retryable category under the attempt limit, or a person's decision.
  { from: 'failed', event: 'retry', to: 'ready' },
  // A revision dropped or redefined it. A step that already succeeded keeps its history instead.
  { from: 'pending', event: 'supersede', to: 'superseded' },
  { from: 'ready', event: 'supersede', to: 'superseded' },
  { from: 'running', event: 'supersede', to: 'superseded' },
  { from: 'waiting', event: 'supersede', to: 'superseded' },
  { from: 'failed', event: 'supersede', to: 'superseded' },
  { from: 'pending', event: 'cancel', to: 'cancelled' },
  { from: 'ready', event: 'cancel', to: 'cancelled' },
  { from: 'running', event: 'cancel', to: 'cancelled' },
  { from: 'waiting', event: 'cancel', to: 'cancelled' },
  { from: 'failed', event: 'cancel', to: 'cancelled' },
  { from: 'pending', event: 'skip', to: 'skipped' },
  { from: 'ready', event: 'skip', to: 'skipped' },
];

export const STEP_RUN_TRANSITIONS: TransitionTable<StepRunStatus, StepRunEvent> = {
  machine: 'StepRun',
  edges: STEP_RUN_EDGES,
};

// ---------------------------------------------------------------------------------------------
// ChangeSegment (S11 P1, §3.4; workspace segments only — §5.4 "第一版收窄"). Created `applied` by
// the transaction that applies it. Verification can be re-run, so a verified segment can fail a
// later run and a failed one can pass; a re-run with the same result keeps the status. Rolling
// back runs every item's inverse (compare before writing) in one transaction; `rolled_back` is
// final. Also enforced by the database (`change_segments_guard`, migrations/change/0001).
// ---------------------------------------------------------------------------------------------

export const CHANGE_SEGMENT_EVENT_VALUES = ['verify_pass', 'verify_fail', 'roll_back'] as const;
export type ChangeSegmentEvent = (typeof CHANGE_SEGMENT_EVENT_VALUES)[number];

export const CHANGE_SEGMENT_EDGES: readonly StateTransition<
  ChangeSegmentStatus,
  ChangeSegmentEvent
>[] = [
  { from: 'applied', event: 'verify_pass', to: 'verified' },
  { from: 'applied', event: 'verify_fail', to: 'verification_failed' },
  { from: 'verified', event: 'verify_fail', to: 'verification_failed' },
  { from: 'verification_failed', event: 'verify_pass', to: 'verified' },
  { from: 'applied', event: 'roll_back', to: 'rolled_back' },
  { from: 'verified', event: 'roll_back', to: 'rolled_back' },
  { from: 'verification_failed', event: 'roll_back', to: 'rolled_back' },
];

export const CHANGE_SEGMENT_TRANSITIONS: TransitionTable<ChangeSegmentStatus, ChangeSegmentEvent> =
  {
    machine: 'ChangeSegment',
    edges: CHANGE_SEGMENT_EDGES,
  };

/** Every transition table, for generic iteration (e.g. exhaustive tests, doc generation). */
export const ALL_TRANSITION_TABLES = [
  FACT_LIFECYCLE_TRANSITIONS,
  EPISTEMIC_PROMOTION_TRANSITIONS,
  CONFLICT_TRANSITIONS,
  DECISION_TRANSITIONS,
  ACTION_REQUEST_TRANSITIONS,
  TASK_TRANSITIONS,
  WORKER_RUN_TRANSITIONS,
  TURN_TRANSITIONS,
  PUBLISHABLE_TRANSITIONS,
  OPERATION_TRANSITIONS,
  GRANT_TRANSITIONS,
  CONNECTION_REQUEST_TRANSITIONS,
  GOAL_RUN_TRANSITIONS,
  PLAN_REVISION_TRANSITIONS,
  STEP_RUN_TRANSITIONS,
  CHANGE_SEGMENT_TRANSITIONS,
] as const;
