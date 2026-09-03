import type {
  ActionRequestStatus,
  BlastRadius,
  SystemMessageContent,
  TaskStatus,
} from '@nexttime/shared';

/**
 * application/linkage/content: pure builders for the three `SystemMessageContent` shapes
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
}

type SystemTaskUpdateContent = Extract<SystemMessageContent, { kind: 'system.task_update' }>;
type SystemActionPendingContent = Extract<SystemMessageContent, { kind: 'system.action_pending' }>;
type SystemActionUpdateContent = Extract<SystemMessageContent, { kind: 'system.action_update' }>;

export function buildTaskUpdateContent(input: TaskUpdateContentInput): SystemTaskUpdateContent {
  const verb = TASK_STATUS_TEXT[input.status] ?? `is now "${input.status}"`;
  const reasonSuffix = input.failureReason ? ` (${input.failureReason})` : '';
  return {
    kind: 'system.task_update',
    text: `Task ${input.taskId} ${verb}${reasonSuffix}`,
    taskId: input.taskId,
    status: input.status,
    failureReason: input.failureReason ?? null,
    summary: input.summary ?? null,
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
}

function humanizeActionKind(actionKind: string): string {
  return actionKind.replace(/[._-]+/g, ' ').trim() || actionKind;
}

export function buildActionPendingContent(
  input: ActionPendingContentInput,
): SystemActionPendingContent {
  const label = humanizeActionKind(input.actionKind);
  const scopeSuffix = input.resourceScope ? ` on ${input.resourceScope}` : '';
  const text = input.isHolder
    ? `Approval needed: ${label}${scopeSuffix}`
    : `Waiting for approval: ${label}${scopeSuffix}`;
  return {
    kind: 'system.action_pending',
    text,
    actionRequestId: input.actionRequestId,
    gatekeeperId: input.gatekeeperId,
    actionKind: input.actionKind,
    resourceScope: input.resourceScope ?? null,
    blastRadius: input.blastRadius,
    awaitDecision: input.awaitDecision,
    isHolder: input.isHolder,
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
};

export interface ActionUpdateContentInput {
  readonly actionRequestId: string;
  readonly actionKind: string;
  readonly status: ActionRequestStatus;
  readonly isHolder: boolean;
}

export function buildActionUpdateContent(
  input: ActionUpdateContentInput,
): SystemActionUpdateContent {
  const label = humanizeActionKind(input.actionKind);
  const verb = ACTION_REQUEST_STATUS_TEXT[input.status] ?? `is now "${input.status}"`;
  return {
    kind: 'system.action_update',
    text: `${label}: ${verb}`,
    actionRequestId: input.actionRequestId,
    status: input.status,
    actionKind: input.actionKind,
    isHolder: input.isHolder,
  };
}
