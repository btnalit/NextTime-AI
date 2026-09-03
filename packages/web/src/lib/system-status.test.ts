import { describe, expect, it } from 'vitest';
import { systemStatusLineFromMessage } from './system-status.js';
import type { ChatMessage } from './ws-client.js';

function chatMessage(content: Record<string, unknown> | undefined, text = 'fallback'): ChatMessage {
  return {
    id: 'm1',
    role: 'system',
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
    sequence: 1,
    kind: typeof content?.kind === 'string' ? content.kind : undefined,
    content,
  };
}

describe('systemStatusLineFromMessage', () => {
  it('parses system.action_update', () => {
    const line = systemStatusLineFromMessage(
      chatMessage({
        kind: 'system.action_update',
        text: 'ActionRequest approved',
        actionRequestId: 'ar-1',
        status: 'approved',
        actionKind: 'docker.container_restart',
        isHolder: true,
      }),
    );
    expect(line).toEqual({
      variant: 'action_update',
      text: 'ActionRequest approved',
      actionRequestId: 'ar-1',
      status: 'approved',
      isHolder: true,
    });
  });

  it('parses system.task_update including failureReason/summary', () => {
    const line = systemStatusLineFromMessage(
      chatMessage({
        kind: 'system.task_update',
        text: 'Task failed',
        taskId: 'task-1',
        status: 'failed',
        failureReason: 'worker_failed',
        summary: null,
      }),
    );
    expect(line).toEqual({
      variant: 'task_update',
      text: 'Task failed',
      taskId: 'task-1',
      status: 'failed',
      failureReason: 'worker_failed',
      summary: null,
    });
  });

  it('falls back to message.text when content.text is missing', () => {
    const line = systemStatusLineFromMessage(
      chatMessage(
        { kind: 'system.task_update', taskId: 'task-1', status: 'completed' },
        'plain fallback text',
      ),
    );
    expect(line?.text).toBe('plain fallback text');
  });

  it('returns undefined for system.action_pending (handled by lib/action-card.ts instead)', () => {
    expect(
      systemStatusLineFromMessage(
        chatMessage({
          kind: 'system.action_pending',
          actionRequestId: 'ar-1',
          actionKind: 'docker.container_restart',
          isHolder: true,
        }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined for a plain user/assistant message with no content', () => {
    expect(systemStatusLineFromMessage(chatMessage(undefined))).toBeUndefined();
  });

  it('returns undefined when a required field is missing', () => {
    expect(
      systemStatusLineFromMessage(chatMessage({ kind: 'system.task_update', taskId: 'task-1' })),
    ).toBeUndefined();
  });
});
