import {
  GOAL_OUTCOME_BASIS_VALUES,
  GOAL_RUN_CHANGE_VALUES,
  GOAL_RUN_PAUSE_REASON_VALUES,
  GOAL_RUN_STATUS_VALUES,
  type GoalOutcomeBasis,
  type GoalRunChange,
  type GoalRunPauseReason,
  type GoalRunStatus,
  LLM_REFUSAL_SCOPE_VALUES,
  type LlmRefusalScope,
  OBJECTIVE_OUTCOME_VALUES,
  type ObjectiveOutcome,
} from '@nexttime/shared';
import { formatDateTime } from './format.js';
import type { Translate } from './i18n.js';
import type { ChatMessage } from './ws-client.js';

/**
 * lib/system-status: formats the "compact status line" system-message kinds (docs/development-
 * tasks.md S2.10 deliverable 2: "system.action_update 和 system.task_update 作为紧凑状态行"; S11
 * GO5e-2 adds a goal's milestones, `system.goal_update`) — `system.action_pending` renders as a
 * full card instead (lib/action-card.ts), and so does a goal's proposal (`chat/GoalProposalCard`),
 * which is the `goal_update` line whose `change` is `propose`.
 *
 * Kept deliberately thin: unlike a pending card, a status line has no synthesis step (no title, no
 * Markdown block, no buttons) — it is `content.text` (the kernel's own one-line summary, packages/
 * shared/src/chat-message-content.ts) plus whatever structured fields are worth a small badge next
 * to it.
 */

export interface ActionUpdateStatusLine {
  readonly variant: 'action_update';
  readonly text: string;
  readonly actionRequestId: string;
  readonly status: string;
  readonly isHolder: boolean;
  /** S11 GO1: on a failed / compensated update, which kind of failure (shared
   *  `ActionRequestFailureKind`); `null` otherwise or on an older message. */
  readonly failureKind?: string | null;
}

export interface TaskUpdateStatusLine {
  readonly variant: 'task_update';
  readonly text: string;
  readonly taskId: string;
  readonly status: string;
  readonly failureReason: string | null | undefined;
  readonly summary: string | null | undefined;
  /** S11 GO5e-2: the goal step the Task ran for; absent for any other Task or an older message. */
  readonly goalStep?: { readonly goalRunId: string; readonly stepKey: string };
}

/** S11 GO5e-2: one change of a goal, in the chat it was proposed from. The kernel's `text` (English)
 *  is kept but not shown — `lib/goals`'s `goalMilestoneText` words the line in the reader's
 *  language from the fields below. */
export interface GoalUpdateStatusLine {
  readonly variant: 'goal_update';
  readonly text: string;
  readonly goalRunId: string;
  /** What happened; `null` on a message whose event predates it (read by `status` alone). */
  readonly change: GoalRunChange | null;
  /** The goal's status right after the change. */
  readonly status: GoalRunStatus;
  readonly pauseReason: GoalRunPauseReason | null;
  readonly heldByOwner: boolean;
  readonly outcome: ObjectiveOutcome | null;
  readonly outcomeBasis: GoalOutcomeBasis | null;
  readonly cleanupPending: boolean;
  readonly revision: number | null;
}

/** Legacy 589: the platform refused every model call of a Turn (a workspace's daily budget was
 *  spent), so the Turn ended with no reply. Worded in the reader's language from `scope` and
 *  `resetsAt` (`modelRefusedText`); the kernel's English `text` is kept for a kind this console
 *  cannot read. */
export interface ModelRefusedStatusLine {
  readonly variant: 'model_refused';
  readonly text: string;
  readonly turnId: string;
  /** Which budget; `null` for a value this console does not know. */
  readonly scope: LlmRefusalScope | null;
  /** When it resets (ISO 8601); `null` when missing. */
  readonly resetsAt: string | null;
}

export type SystemStatusLineData =
  | ActionUpdateStatusLine
  | TaskUpdateStatusLine
  | GoalUpdateStatusLine
  | ModelRefusedStatusLine;

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** Parses `message.content` into a status line, or `undefined` if `message` is not one of the two
 *  status-line kinds (including `system.action_pending`, handled by `lib/action-card.ts` instead). */
export function systemStatusLineFromMessage(
  message: ChatMessage,
): SystemStatusLineData | undefined {
  const content = message.content;
  if (!content) return undefined;

  if (content.kind === 'system.action_update') {
    const actionRequestId = content.actionRequestId;
    const status = content.status;
    const isHolder = content.isHolder;
    if (
      typeof actionRequestId !== 'string' ||
      typeof status !== 'string' ||
      typeof isHolder !== 'boolean'
    ) {
      return undefined;
    }
    return {
      variant: 'action_update',
      text: typeof content.text === 'string' ? content.text : message.text,
      actionRequestId,
      status,
      isHolder,
      failureKind: typeof content.failureKind === 'string' ? content.failureKind : null,
    };
  }

  if (content.kind === 'system.task_update') {
    const taskId = content.taskId;
    const status = content.status;
    if (typeof taskId !== 'string' || typeof status !== 'string') return undefined;
    return {
      variant: 'task_update',
      text: typeof content.text === 'string' ? content.text : message.text,
      taskId,
      status,
      failureReason: typeof content.failureReason === 'string' ? content.failureReason : null,
      summary: typeof content.summary === 'string' ? content.summary : null,
      ...(typeof content.goalRunId === 'string' && typeof content.stepKey === 'string'
        ? { goalStep: { goalRunId: content.goalRunId, stepKey: content.stepKey } }
        : {}),
    };
  }

  if (content.kind === 'system.goal_update') {
    const goalRunId = content.goalRunId;
    const status = oneOf(GOAL_RUN_STATUS_VALUES, content.status);
    if (typeof goalRunId !== 'string' || status === null) return undefined;
    return {
      variant: 'goal_update',
      text: typeof content.text === 'string' ? content.text : message.text,
      goalRunId,
      change: oneOf(GOAL_RUN_CHANGE_VALUES, content.change),
      status,
      pauseReason: oneOf(GOAL_RUN_PAUSE_REASON_VALUES, content.pauseReason),
      heldByOwner: content.heldByOwner === true,
      outcome: oneOf(OBJECTIVE_OUTCOME_VALUES, content.outcome),
      outcomeBasis: oneOf(GOAL_OUTCOME_BASIS_VALUES, content.outcomeBasis),
      cleanupPending: content.cleanupPending === true,
      revision: typeof content.revision === 'number' ? content.revision : null,
    };
  }

  if (content.kind === 'system.model_refused') {
    const turnId = content.turnId;
    if (typeof turnId !== 'string') return undefined;
    return {
      variant: 'model_refused',
      text: typeof content.text === 'string' ? content.text : message.text,
      turnId,
      scope: oneOf(LLM_REFUSAL_SCOPE_VALUES, content.scope),
      resetsAt: typeof content.resetsAt === 'string' ? content.resetsAt : null,
    };
  }

  return undefined;
}

/** Legacy 589: why a Turn has no reply, in the reader's language — which budget ran out and when
 *  it resets (local time, zone labelled). */
export function modelRefusedText(line: ModelRefusedStatusLine, t: Translate): string {
  const [budgetZh, budgetEn] =
    line.scope === 'workspace_daily_cost'
      ? ['当天的模型费用预算', 'daily model cost budget']
      : line.scope === 'workspace_daily_tokens'
        ? ['当天的模型 token 预算', 'daily model token budget']
        : ['当天的模型预算', 'daily model budget'];
  const resets = line.resetsAt ? formatDateTime(line.resetsAt) : null;
  return resets
    ? t(
        `工作区${budgetZh}用完了，平台拒绝了这条消息的模型调用，所以没有回复。预算在 ${resets} 重置，管理员也可以提高预算。`,
        `The workspace’s ${budgetEn} is spent, so the platform refused the model calls for this message and there is no reply. It resets at ${resets}, or an administrator can raise it.`,
      )
    : t(
        `工作区${budgetZh}用完了，平台拒绝了这条消息的模型调用，所以没有回复。预算每天 UTC 0 点重置，管理员也可以提高预算。`,
        `The workspace’s ${budgetEn} is spent, so the platform refused the model calls for this message and there is no reply. It resets at 00:00 UTC, or an administrator can raise it.`,
      );
}

/** A goal's status, and how it ended once it has, as its latest milestone in a chat says. */
export interface LatestGoalStatus {
  readonly status: GoalRunStatus;
  readonly outcome: ObjectiveOutcome | null;
}

/** S11 GO5e-2: each goal's status as the latest of its milestones in `messages` says — what a
 *  proposal card in the same chat shows once the goal has moved on. */
export function latestGoalStatuses(
  messages: readonly ChatMessage[],
): ReadonlyMap<string, LatestGoalStatus> {
  const map = new Map<string, LatestGoalStatus>();
  for (const message of messages) {
    const line = systemStatusLineFromMessage(message);
    if (line?.variant === 'goal_update') {
      map.set(line.goalRunId, { status: line.status, outcome: line.outcome });
    }
  }
  return map;
}

/** S11 GO5e-2 (#737 UX P2-2): every goal this chat's messages are about — its proposals, its
 *  milestones and the Tasks its steps ran — each once, in the order the chat first names it. */
export function goalRunIdsIn(messages: readonly ChatMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    const line = systemStatusLineFromMessage(message);
    if (line?.variant === 'goal_update') ids.add(line.goalRunId);
    else if (line?.variant === 'task_update' && line.goalStep) ids.add(line.goalStep.goalRunId);
  }
  return [...ids];
}
