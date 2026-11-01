import { describe, expect, it } from 'vitest';
import { formatDateTime } from './format.js';
import type { Translate } from './i18n.js';
import { localTimeOfUtcMidnight } from './model-refused.js';
import {
  type ModelRefusedStatusLine,
  goalRunIdsIn,
  latestGoalStatuses,
  modelRefusedText,
  systemStatusLineFromMessage,
} from './system-status.js';
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
        actionKindTag: 'docker.container_restart',
        isHolder: true,
      }),
    );
    expect(line).toEqual({
      variant: 'action_update',
      text: 'ActionRequest approved',
      actionRequestId: 'ar-1',
      status: 'approved',
      isHolder: true,
      failureKind: null,
    });
  });

  it('parses a failed system.action_update with its failure kind (S11 GO1)', () => {
    const line = systemStatusLineFromMessage(
      chatMessage({
        kind: 'system.action_update',
        text: 'ActionRequest failed',
        actionRequestId: 'ar-1',
        status: 'failed',
        actionKindTag: 'docker.container_restart',
        isHolder: true,
        failureKind: 'outcome_unknown',
      }),
    );
    expect(line).toMatchObject({ status: 'failed', failureKind: 'outcome_unknown' });
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
          actionKindTag: 'docker.container_restart',
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

  it('S11 GO5e-2: parses system.goal_update; a value it does not know reads as absent', () => {
    const line = systemStatusLineFromMessage(
      chatMessage({
        kind: 'system.goal_update',
        text: 'Goal g-1 paused: its budget ran out',
        goalRunId: 'g-1',
        change: 'pause',
        status: 'paused',
        pauseReason: 'budget_exhausted',
        heldByOwner: true,
      }),
    );
    expect(line).toEqual({
      variant: 'goal_update',
      text: 'Goal g-1 paused: its budget ran out',
      goalRunId: 'g-1',
      change: 'pause',
      status: 'paused',
      pauseReason: 'budget_exhausted',
      heldByOwner: true,
      outcome: null,
      outcomeBasis: null,
      cleanupPending: false,
      revision: null,
    });
    const newer = systemStatusLineFromMessage(
      chatMessage({
        kind: 'system.goal_update',
        goalRunId: 'g-1',
        change: 'rebalance',
        status: 'running',
        pauseReason: 'cosmic_rays',
      }),
    );
    expect(newer).toMatchObject({ change: null, status: 'running', pauseReason: null });
    // A status it does not know is not a goal line at all.
    expect(
      systemStatusLineFromMessage(
        chatMessage({ kind: 'system.goal_update', goalRunId: 'g-1', status: 'teleported' }),
      ),
    ).toBeUndefined();
  });

  it("S11 GO5e-2: a goal step's Task carries its goal and step; another Task carries neither", () => {
    expect(
      systemStatusLineFromMessage(
        chatMessage({
          kind: 'system.task_update',
          text: 'Goal step "report": task t-1 completed',
          taskId: 't-1',
          status: 'completed',
          goalRunId: 'g-1',
          stepKey: 'report',
        }),
      ),
    ).toMatchObject({ goalStep: { goalRunId: 'g-1', stepKey: 'report' } });
    expect(
      systemStatusLineFromMessage(
        chatMessage({ kind: 'system.task_update', taskId: 't-2', status: 'completed' }),
      ),
    ).not.toHaveProperty('goalStep');
  });
});

describe('system.model_refused (legacy 589)', () => {
  const RESETS_AT = '2026-11-02T00:00:00.000Z';

  it('parses the Turn, the budget and when it resets; a value it does not know reads as absent', () => {
    expect(
      systemStatusLineFromMessage(
        chatMessage({
          kind: 'system.model_refused',
          text: 'The platform refused the model calls for this message',
          turnId: 'turn-1',
          scope: 'workspace_daily_cost',
          resetsAt: RESETS_AT,
        }),
      ),
    ).toEqual({
      variant: 'model_refused',
      text: 'The platform refused the model calls for this message',
      turnId: 'turn-1',
      scope: 'workspace_daily_cost',
      resetsAt: RESETS_AT,
    });
    expect(
      systemStatusLineFromMessage(
        chatMessage({ kind: 'system.model_refused', turnId: 'turn-1', scope: 'monthly' }, 'kept'),
      ),
    ).toEqual({
      variant: 'model_refused',
      text: 'kept',
      turnId: 'turn-1',
      scope: null,
      resetsAt: null,
    });
  });

  it('returns undefined without the Turn it is about', () => {
    expect(
      systemStatusLineFromMessage(
        chatMessage({ kind: 'system.model_refused', scope: 'workspace_daily_tokens' }),
      ),
    ).toBeUndefined();
  });

  const zh: Translate = (text) => text;
  const en: Translate = (_zh, text) => text;
  const line = (overrides: Partial<ModelRefusedStatusLine>): ModelRefusedStatusLine => ({
    variant: 'model_refused',
    text: 'kernel text',
    turnId: 'turn-1',
    scope: 'workspace_daily_tokens',
    resetsAt: RESETS_AT,
    ...overrides,
  });

  it('says which budget ran out, when it resets and who can raise it where, in the reader’s language', () => {
    const resets = formatDateTime(RESETS_AT);
    expect(modelRefusedText(line({}), zh)).toBe(
      `工作区当天的模型 token 预算用完了，平台拒绝了这条消息的模型调用，所以没有回复。预算在 ${resets} 重置；平台管理员也可以调高它。`,
    );
    expect(modelRefusedText(line({ scope: 'workspace_daily_cost' }), zh)).toBe(
      `工作区当天的模型费用预算用完了，平台拒绝了这条消息的模型调用，所以没有回复。预算在 ${resets} 重置；工作区所有者也可以在「模型与配额」里调高「每工作区日成本」。`,
    );
    expect(modelRefusedText(line({ scope: 'workspace_daily_cost' }), en)).toBe(
      `The workspace’s daily model cost budget is spent, so the platform refused the model calls for this message and there is no reply. It resets at ${resets}. A workspace owner can also raise the daily cost budget under Models.`,
    );
    // Never the kernel's English text.
    expect(modelRefusedText(line({}), zh)).not.toContain('kernel text');
  });

  it('without a reset time a daily budget names 00:00 UTC on the reader’s clock', () => {
    const local = localTimeOfUtcMidnight();
    expect(modelRefusedText(line({ resetsAt: null }), zh)).toBe(
      `工作区当天的模型 token 预算用完了，平台拒绝了这条消息的模型调用，所以没有回复。预算每天 UTC 0 点（本地 ${local}）重置；平台管理员也可以调高它。`,
    );
    expect(modelRefusedText(line({ resetsAt: null }), en)).toContain(
      `It resets every day at 00:00 UTC (${local} local). A platform administrator can also raise it.`,
    );
  });

  it('a budget this console does not know names no period and no setting', () => {
    expect(modelRefusedText(line({ scope: null, resetsAt: null }), zh)).toBe(
      '工作区的模型预算用完了，平台拒绝了这条消息的模型调用，所以没有回复。等预算重置，或者管理员调高它之后再发。',
    );
    expect(modelRefusedText(line({ scope: null, resetsAt: null }), en)).toBe(
      'The workspace’s model budget is spent, so the platform refused the model calls for this message and there is no reply. Send it again once the budget resets or an administrator raises it.',
    );
    const resets = formatDateTime(RESETS_AT);
    expect(modelRefusedText(line({ scope: null }), zh)).toBe(
      `工作区的模型预算用完了，平台拒绝了这条消息的模型调用，所以没有回复。预算在 ${resets} 重置；管理员也可以调高它。`,
    );
  });
});

describe('latestGoalStatuses (S11 GO5e-2)', () => {
  it("keeps each goal's last milestone status, in message order", () => {
    const goal = (sequence: number, goalRunId: string, status: string): ChatMessage => ({
      ...chatMessage({ kind: 'system.goal_update', goalRunId, status }),
      sequence,
    });
    const map = latestGoalStatuses([
      goal(1, 'g-1', 'proposed'),
      goal(2, 'g-2', 'proposed'),
      goal(3, 'g-1', 'running'),
      chatMessage({ kind: 'system.task_update', taskId: 't-1', status: 'completed' }),
      goal(5, 'g-1', 'verifying'),
    ]);
    expect([...map]).toEqual([
      ['g-1', { status: 'verifying', outcome: null }],
      ['g-2', { status: 'proposed', outcome: null }],
    ]);
  });

  it('carries how a goal ended with its last status', () => {
    const map = latestGoalStatuses([
      chatMessage({
        kind: 'system.goal_update',
        goalRunId: 'g-1',
        status: 'completed',
        outcome: 'not_achieved',
      }),
    ]);
    expect(map.get('g-1')).toEqual({ status: 'completed', outcome: 'not_achieved' });
  });
});

describe('goalRunIdsIn (#737 UX P2-2)', () => {
  it('names each goal a proposal, milestone or goal step names, once, in first-named order', () => {
    expect(
      goalRunIdsIn([
        chatMessage({ kind: 'system.goal_update', goalRunId: 'g-2', status: 'proposed' }),
        chatMessage({
          kind: 'system.task_update',
          taskId: 't-1',
          status: 'completed',
          goalRunId: 'g-1',
          stepKey: 'scan',
        }),
        chatMessage({ kind: 'system.task_update', taskId: 't-2', status: 'completed' }),
        chatMessage({ kind: 'system.goal_update', goalRunId: 'g-2', status: 'running' }),
        chatMessage({ kind: 'system.action_update', actionRequestId: 'a-1', status: 'approved' }),
      ]),
    ).toEqual(['g-2', 'g-1']);
  });
});
