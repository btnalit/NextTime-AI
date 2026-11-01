import type {
  ActionRequestFailureKind,
  ActionRequestStatus,
  BlastRadius,
  GoalOutcomeBasis,
  GoalRunChange,
  GoalRunPauseAuthority,
  GoalRunPauseReason,
  GoalRunStatus,
  ObjectiveOutcome,
  SystemMessageContent,
  TaskStatus,
} from '@nexttime/shared';
import { boundedEcho } from '@nexttime/shared';

/**
 * application/linkage/content: pure builders for the `SystemMessageContent` shapes
 * (`@nexttime/shared`'s `chat-message-content.ts`) this module writes into `chat_messages.content`
 * — no IO, unit-testable with no database. One human-readable `text` field is always included
 * (`chatMessageText`'s fallback path, and `packages/platform-extension`'s `renderSection`, both
 * only ever need *a* string — the richer structured fields are for a client that knows the shape).
 */

const TASK_STATUS_TEXT: Partial<Record<TaskStatus, string>> = {
  waiting_approval: 'is waiting on an approval',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'was cancelled',
};

export interface TaskUpdateContentInput {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly failureReason?: string | null;
  readonly summary?: string | null;
  /** S11 GO5e-2: the goal step the Task runs for, when it runs for one. */
  readonly goalStep?: { readonly goalRunId: string; readonly stepKey: string } | null;
}

type SystemTaskUpdateContent = Extract<SystemMessageContent, { kind: 'system.task_update' }>;
type SystemActionPendingContent = Extract<SystemMessageContent, { kind: 'system.action_pending' }>;
type SystemActionUpdateContent = Extract<SystemMessageContent, { kind: 'system.action_update' }>;
type SystemGoalUpdateContent = Extract<SystemMessageContent, { kind: 'system.goal_update' }>;

export function buildTaskUpdateContent(input: TaskUpdateContentInput): SystemTaskUpdateContent {
  const verb = TASK_STATUS_TEXT[input.status] ?? `is now "${input.status}"`;
  const reasonSuffix = input.failureReason ? ` (${input.failureReason})` : '';
  const goalStep = input.goalStep ?? null;
  return {
    kind: 'system.task_update',
    text: goalStep
      ? `Goal step "${goalStep.stepKey}": task ${input.taskId} ${verb}${reasonSuffix}`
      : `Task ${input.taskId} ${verb}${reasonSuffix}`,
    taskId: input.taskId,
    status: input.status,
    failureReason: input.failureReason ?? null,
    summary: input.summary ?? null,
    ...(goalStep ? { goalRunId: goalStep.goalRunId, stepKey: goalStep.stepKey } : {}),
  };
}

export interface ActionPendingContentInput {
  readonly actionRequestId: string;
  readonly gatekeeperId: string;
  readonly actionKind: string;
  readonly resourceScope?: string | null;
  readonly blastRadius?: BlastRadius;
  readonly awaitDecision?: boolean;
  readonly isHolder: boolean;
  /** Suspected credential values in the request's params (0 or absent: none). */
  readonly suspectedSecretValues?: number;
}

/** The action kind as a chat line names it: humanized, then bounded and made visible (legacy
 *  232: an Operation name is the caller's own, so the line never carries it whole or with a hidden
 *  character; the card's own title shows the whole name, and `actionKindTag` stays raw). */
function humanizeActionKind(actionKind: string): string {
  return boundedEcho(actionKind.replace(/[._-]+/g, ' ').trim() || actionKind);
}

export function buildActionPendingContent(
  input: ActionPendingContentInput,
): SystemActionPendingContent {
  const label = humanizeActionKind(input.actionKind);
  const scopeSuffix = input.resourceScope ? ` on ${boundedEcho(input.resourceScope)}` : '';
  const text = input.isHolder
    ? `Approval needed: ${label}${scopeSuffix}`
    : `Waiting for approval: ${label}${scopeSuffix}`;
  return {
    kind: 'system.action_pending',
    text,
    actionRequestId: input.actionRequestId,
    gatekeeperId: input.gatekeeperId,
    actionKindTag: input.actionKind,
    resourceScope: input.resourceScope ?? null,
    blastRadius: input.blastRadius,
    awaitDecision: input.awaitDecision,
    isHolder: input.isHolder,
    ...(input.suspectedSecretValues !== undefined && input.suspectedSecretValues > 0
      ? { suspectedSecretValues: input.suspectedSecretValues }
      : {}),
  };
}

const ACTION_REQUEST_STATUS_TEXT: Partial<Record<ActionRequestStatus, string>> = {
  auto_approved: 'was auto-approved',
  approved: 'was approved',
  rejected: 'was rejected',
  expired: 'expired without a decision',
  denied: 'was denied by policy',
  executed: 'was executed',
  failed: 'failed to execute',
  compensated: 'was rolled back (compensated)',
  withdrawn: 'was withdrawn before it ran',
};

/** S11 GO1: a failed update says which kind of failure it was — the one thing a reader must know
 *  before doing anything about it (`ACTION_REQUEST_FAILURE_KIND_VALUES`). */
const ACTION_REQUEST_FAILURE_TEXT: Record<ActionRequestFailureKind, string> = {
  not_delivered: 'failed: it never reached the gate, so nothing ran',
  refused: 'failed: refused by the platform or the gate, or its target answered with an error',
  outcome_unknown:
    'failed with an unknown outcome: it may have run — check the target system before requesting it again',
};

export interface ActionUpdateContentInput {
  readonly actionRequestId: string;
  readonly actionKind: string;
  readonly status: ActionRequestStatus;
  readonly isHolder: boolean;
  /** The row's `failure_kind` (S11 GO1): read on a `failed` / `compensated` update only. */
  readonly failureKind?: ActionRequestFailureKind | null;
}

export function buildActionUpdateContent(
  input: ActionUpdateContentInput,
): SystemActionUpdateContent {
  const label = humanizeActionKind(input.actionKind);
  const failureKind =
    (input.status === 'failed' || input.status === 'compensated') && input.failureKind
      ? input.failureKind
      : undefined;
  const verb =
    input.status === 'failed' && failureKind
      ? ACTION_REQUEST_FAILURE_TEXT[failureKind]
      : (ACTION_REQUEST_STATUS_TEXT[input.status] ?? `is now "${input.status}"`);
  return {
    kind: 'system.action_update',
    text: `${label}: ${verb}`,
    actionRequestId: input.actionRequestId,
    status: input.status,
    actionKindTag: input.actionKind,
    isHolder: input.isHolder,
    ...(failureKind ? { failureKind } : {}),
  };
}

/** The sub-state of a GoalRun row a milestone reads (`application/goal`'s `GoalRunRow`). */
export interface GoalUpdateRunState {
  readonly status: GoalRunStatus;
  readonly pauseReason: GoalRunPauseReason | null;
  readonly pausedByAuthority: GoalRunPauseAuthority | null;
  readonly outcome: ObjectiveOutcome | null;
  readonly outcomeBasis: GoalOutcomeBasis | null;
  readonly cleanupPending: boolean;
  readonly currentRevision: number | null;
}

export interface GoalUpdateContentInput {
  readonly goalRunId: string;
  /** `GoalRunUpdated.change`; `undefined` on an event written before it. */
  readonly change: GoalRunChange | undefined;
  /** `GoalRunUpdated.status`: the run's status right after the change. */
  readonly status: GoalRunStatus;
  /** The run as it is now — read when the message is written, maybe after later changes. */
  readonly run: GoalUpdateRunState;
}

const PAUSE_REASON_TEXT: Record<GoalRunPauseReason, string> = {
  requested: 'a person asked for it',
  budget_exhausted: 'its budget ran out',
  no_progress: 'no step made progress',
  authority_lost: 'the requester no longer holds what a step needs',
  needs_decision: 'a decision is needed',
  awaiting_reconcile: 'a target system has to be checked by hand',
  model_refused:
    "the platform refused its Worker's model calls: the workspace's daily model budget is spent",
};

const OUTCOME_BASIS_TEXT: Record<GoalOutcomeBasis, string> = {
  verified_by_check: "the platform's checks",
  requester: "the requester's word",
  reviewer_assessed: 'a review',
};

/** The changes whose sub-state is the pause (`pauseReason`, `heldByOwner`). */
const PAUSE_CHANGES: ReadonlySet<GoalRunChange> = new Set([
  'pause',
  'hold',
  'release_hold',
  'revise',
]);

/**
 * S11 GO5e-2: a GoalRun's milestone. `status` is the event's; a sub-state field is copied from
 * `run` only while `run` is still in that status, i.e. still describes this change (the consumer
 * may run after later changes — those write their own messages). The text never names the goal's
 * statement: it is free text a read masks (`get_goal`), and a chat message is not re-read through
 * that mask.
 */
export function buildGoalUpdateContent(input: GoalUpdateContentInput): SystemGoalUpdateContent {
  const { change, status, run } = input;
  const current = run.status === status;
  const pause =
    current && status === 'paused' && (change === undefined || PAUSE_CHANGES.has(change));
  const pauseReason = pause ? run.pauseReason : null;
  const heldByOwner = pause && run.pausedByAuthority === 'owner';
  const ended = current && status === 'completed';
  const outcome = ended ? run.outcome : null;
  const outcomeBasis = ended ? run.outcomeBasis : null;
  const cleanupPending =
    current && status === 'cancelled' && change !== 'cleanup_finished' ? run.cleanupPending : false;
  const revision = current && change === 'revise' ? run.currentRevision : null;
  const goal = `Goal ${input.goalRunId}`;
  const reasonSuffix = pauseReason ? `: ${PAUSE_REASON_TEXT[pauseReason]}` : '';
  let text: string;
  switch (change) {
    case 'propose':
      text = `${goal} was proposed and waits for the requester to confirm it on the Goals page`;
      break;
    case 'confirm':
      text = `${goal} was confirmed; its steps are starting`;
      break;
    case 'reject':
      text = `${goal} was rejected before it ran`;
      break;
    case 'pause':
      text = `${goal} paused${reasonSuffix}`;
      break;
    case 'hold':
      text = `${goal} is held by a workspace owner; only an owner can lift the hold`;
      break;
    case 'release_hold':
      text = `The hold on goal ${input.goalRunId} was lifted; the requester can resume it`;
      break;
    case 'resume':
      text = `${goal} resumed`;
      break;
    case 'revise':
      text = `${goal}'s plan was revised${revision ? ` (revision ${revision})` : ''}; it stays paused until it is resumed`;
      break;
    case 'verify':
      text = `${goal}: every step is done; the platform is checking whether it was achieved`;
      break;
    case 'complete':
      text = outcome
        ? `${goal} completed: ${outcome === 'achieved' ? 'achieved' : 'not achieved'}${outcomeBasis ? `, on ${OUTCOME_BASIS_TEXT[outcomeBasis]}` : ''}`
        : `${goal} completed`;
      break;
    case 'cancel':
      text = `${goal} is being cancelled: no new step starts, running ones are stopped`;
      break;
    case 'finish_cancel':
      text = cleanupPending
        ? `${goal} was cancelled; some of what it started still has to be cleaned up`
        : `${goal} was cancelled`;
      break;
    case 'cleanup_finished':
      text = `The leftovers of cancelled goal ${input.goalRunId} are gone`;
      break;
    case 'fail':
      text = `${goal} stopped on a platform error`;
      break;
    default:
      text = `${goal} is now "${status}"${reasonSuffix}`;
  }
  return {
    kind: 'system.goal_update',
    text,
    goalRunId: input.goalRunId,
    ...(change ? { change } : {}),
    status,
    ...(pauseReason ? { pauseReason } : {}),
    ...(heldByOwner ? { heldByOwner } : {}),
    ...(outcome ? { outcome } : {}),
    ...(outcomeBasis ? { outcomeBasis } : {}),
    ...(cleanupPending ? { cleanupPending } : {}),
    ...(revision ? { revision } : {}),
  };
}
