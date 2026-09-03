import type {
  ActionRequestStatus,
  ConflictStatus,
  DecisionStatus,
  EntryAgentSessionStatus,
  EpistemicStatus,
  GrantStatus,
  PublishableStatus,
  TaskStatus,
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
// EntryAgent session (§5.5, §7.2): `starting → ready → busy → ready …`; `crashed → starting`
// (host auto-recovery); `stopped` (idle timeout, only while `ready` — §7.2 "空闲超时停容器").
// ---------------------------------------------------------------------------------------------

export const ENTRY_AGENT_SESSION_EVENT_VALUES = [
  'become_ready',
  'start_turn',
  'end_turn',
  'crash',
  'restart',
  'stop',
] as const;
export type EntryAgentSessionEvent = (typeof ENTRY_AGENT_SESSION_EVENT_VALUES)[number];

export const ENTRY_AGENT_SESSION_EDGES: readonly StateTransition<
  EntryAgentSessionStatus,
  EntryAgentSessionEvent
>[] = [
  { from: 'starting', event: 'become_ready', to: 'ready' },
  { from: 'ready', event: 'start_turn', to: 'busy' },
  { from: 'busy', event: 'end_turn', to: 'ready' },
  { from: 'starting', event: 'crash', to: 'crashed' },
  { from: 'ready', event: 'crash', to: 'crashed' },
  { from: 'busy', event: 'crash', to: 'crashed' },
  { from: 'crashed', event: 'restart', to: 'starting' },
  { from: 'ready', event: 'stop', to: 'stopped' },
];

export const ENTRY_AGENT_SESSION_TRANSITIONS: TransitionTable<
  EntryAgentSessionStatus,
  EntryAgentSessionEvent
> = {
  machine: 'EntryAgentSession',
  edges: ENTRY_AGENT_SESSION_EDGES,
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

/** Every transition table, for generic iteration (e.g. exhaustive tests, doc generation). */
export const ALL_TRANSITION_TABLES = [
  FACT_LIFECYCLE_TRANSITIONS,
  EPISTEMIC_PROMOTION_TRANSITIONS,
  CONFLICT_TRANSITIONS,
  DECISION_TRANSITIONS,
  ACTION_REQUEST_TRANSITIONS,
  TASK_TRANSITIONS,
  WORKER_RUN_TRANSITIONS,
  ENTRY_AGENT_SESSION_TRANSITIONS,
  PUBLISHABLE_TRANSITIONS,
  GRANT_TRANSITIONS,
] as const;
