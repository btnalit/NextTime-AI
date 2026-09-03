import type { ChatMessage } from './ws-client.js';

/**
 * lib/system-status: formats the two "compact status line" system-message kinds (docs/development-
 * tasks.md S2.10 deliverable 2: "system.action_update 和 system.task_update 作为紧凑状态行") —
 * `system.action_pending` is the one kind that renders as a full card instead (lib/action-card.ts).
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
}

export interface TaskUpdateStatusLine {
  readonly variant: 'task_update';
  readonly text: string;
  readonly taskId: string;
  readonly status: string;
  readonly failureReason: string | null | undefined;
  readonly summary: string | null | undefined;
}

export type SystemStatusLineData = ActionUpdateStatusLine | TaskUpdateStatusLine;

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
    };
  }

  return undefined;
}
