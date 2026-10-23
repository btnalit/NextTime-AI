import { GOAL_RUN_CHANGE_VALUES, SystemMessageContentSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  type GoalUpdateRunState,
  buildActionPendingContent,
  buildActionUpdateContent,
  buildGoalUpdateContent,
  buildTaskUpdateContent,
} from './content.js';

/**
 * application/linkage/content.test: unit tests (no IO) for the `SystemMessageContent`
 * builders — docs/development-tasks.md S2.11 deliverable 5 "unit tests for the context
 * formatting".
 */

describe('buildTaskUpdateContent', () => {
  it('completed: text mentions the task id and includes summary/failureReason', () => {
    const content = buildTaskUpdateContent({
      taskId: 'task-1',
      status: 'completed',
      summary: 'found the leak',
      failureReason: null,
    });
    expect(content).toMatchObject({
      kind: 'system.task_update',
      taskId: 'task-1',
      status: 'completed',
      summary: 'found the leak',
      failureReason: null,
    });
    expect(content.text).toContain('task-1');
    expect(content.text).toContain('completed');
  });

  it('failed: text includes the failure reason', () => {
    const content = buildTaskUpdateContent({
      taskId: 'task-2',
      status: 'failed',
      failureReason: 'budget_exhausted',
    });
    expect(content.text).toContain('failed');
    expect(content.text).toContain('budget_exhausted');
    expect(content).toMatchObject({ status: 'failed', failureReason: 'budget_exhausted' });
  });

  it('waiting_approval: text says the task is waiting', () => {
    const content = buildTaskUpdateContent({ taskId: 'task-3', status: 'waiting_approval' });
    expect(content.text.toLowerCase()).toContain('waiting');
  });

  it('an unmapped status still produces a readable fallback text', () => {
    const content = buildTaskUpdateContent({
      taskId: 'task-4',
      status: 'queued' as never,
    });
    expect(content.text).toContain('task-4');
    expect(content.text).toContain('queued');
  });
});

describe('buildTaskUpdateContent — a goal step (S11 GO5e-2)', () => {
  it('names the step and carries the goal and step key; without one, neither', () => {
    const content = buildTaskUpdateContent({
      taskId: 'task-9',
      status: 'failed',
      failureReason: 'contract_violation',
      goalStep: { goalRunId: 'goal-1', stepKey: 'collect' },
    });
    expect(content).toMatchObject({
      text: 'Goal step "collect": task task-9 failed (contract_violation)',
      goalRunId: 'goal-1',
      stepKey: 'collect',
    });
    const plain = buildTaskUpdateContent({ taskId: 'task-9', status: 'completed', goalStep: null });
    expect(plain).not.toHaveProperty('goalRunId');
    expect(plain).not.toHaveProperty('stepKey');
    expect(SystemMessageContentSchema.parse(content)).toEqual(content);
  });
});

describe('buildActionPendingContent', () => {
  it('legacy 232: a long or hidden-character action kind is bounded and shown in the line; the tag stays raw', () => {
    const actionKind = `wipe\u202E.${'x'.repeat(300)}`;
    const content = buildActionPendingContent({
      actionRequestId: 'ar-9',
      gatekeeperId: 'gk-1',
      actionKind,
      resourceScope: 'host\n-1',
      blastRadius: 'high',
      awaitDecision: false,
      isHolder: true,
    });
    expect(content.text).not.toMatch(/[\u202E\n]/);
    expect(content.text).toContain('wipe\\u{202E}');
    expect(content.text).toContain('host\\u{A}-1');
    expect([...content.text].length).toBeLessThan(200);
    expect(content.actionKindTag).toBe(actionKind);
  });

  it('isHolder=true reads as an action item ("Approval needed")', () => {
    const content = buildActionPendingContent({
      actionRequestId: 'ar-1',
      gatekeeperId: 'gk-1',
      actionKind: 'docker.container_restart',
      resourceScope: 'host-1',
      blastRadius: 'medium',
      awaitDecision: false,
      isHolder: true,
    });
    expect(content.kind).toBe('system.action_pending');
    expect(content.text).toMatch(/approval needed/i);
    expect(content.text).toContain('host-1');
    expect(content).toMatchObject({
      actionRequestId: 'ar-1',
      gatekeeperId: 'gk-1',
      actionKindTag: 'docker.container_restart',
      resourceScope: 'host-1',
      isHolder: true,
    });
  });

  it('isHolder=false reads as status-only ("Waiting for approval"), no action-oriented wording', () => {
    const content = buildActionPendingContent({
      actionRequestId: 'ar-2',
      gatekeeperId: 'gk-1',
      actionKind: 'docker.container_restart',
      isHolder: false,
    });
    expect(content.text).toMatch(/waiting for approval/i);
    expect(content.text).not.toMatch(/approval needed/i);
    expect(content).toMatchObject({ isHolder: false, resourceScope: null });
  });

  it('humanizes actionKind (dots/underscores → spaces) without mutating the raw actionKind field', () => {
    const content = buildActionPendingContent({
      actionRequestId: 'ar-3',
      gatekeeperId: 'gk-1',
      actionKind: 'docker.container_restart',
      isHolder: true,
    });
    expect(content.actionKindTag).toBe('docker.container_restart');
    expect(content.text).toContain('docker container restart');
  });
});

describe('buildActionUpdateContent', () => {
  it.each([
    ['approved', /approved/i],
    ['rejected', /rejected/i],
    ['expired', /expired/i],
    ['denied', /denied/i],
    ['executed', /executed/i],
    ['failed', /fail/i],
    ['compensated', /rolled back|compensated/i],
    ['auto_approved', /auto-approved/i],
    ['withdrawn', /withdrawn before it ran/i],
  ] as const)('status=%s produces readable text', (status, pattern) => {
    const content = buildActionUpdateContent({
      actionRequestId: 'ar-1',
      actionKind: 'docker.container_restart',
      status,
      isHolder: true,
    });
    expect(content.kind).toBe('system.action_update');
    expect(content.text).toMatch(pattern);
    expect(content.status).toBe(status);
  });

  it.each([
    ['not_delivered', /never reached the gate, so nothing ran/],
    ['refused', /refused by the platform or the gate/],
    ['outcome_unknown', /unknown outcome: it may have run — check the target system/],
  ] as const)(
    'S11 GO1: a failed update says its kind (%s) in the text and the content',
    (failureKind, pattern) => {
      const content = buildActionUpdateContent({
        actionRequestId: 'ar-1',
        actionKind: 'docker.container_restart',
        status: 'failed',
        isHolder: true,
        failureKind,
      });
      expect(content.text).toMatch(pattern);
      expect(content.failureKind).toBe(failureKind);
    },
  );

  it('S11 GO1: a kind on a status that is not a failure is not carried', () => {
    const content = buildActionUpdateContent({
      actionRequestId: 'ar-1',
      actionKind: 'docker.container_restart',
      status: 'executed',
      isHolder: true,
      failureKind: 'refused',
    });
    expect(content).not.toHaveProperty('failureKind');
    expect(content.text).toMatch(/executed/i);
  });

  it('carries isHolder through unchanged', () => {
    const content = buildActionUpdateContent({
      actionRequestId: 'ar-1',
      actionKind: 'docker.container_restart',
      status: 'approved',
      isHolder: false,
    });
    expect(content.isHolder).toBe(false);
  });
});

describe('buildGoalUpdateContent (S11 GO5e-2)', () => {
  const RUN: GoalUpdateRunState = {
    status: 'running',
    pauseReason: null,
    pausedByAuthority: null,
    outcome: null,
    outcomeBasis: null,
    cleanupPending: false,
    currentRevision: 1,
  };

  it('every change reads as itself, never as the default, and fits the wire schema', () => {
    for (const change of GOAL_RUN_CHANGE_VALUES) {
      const content = buildGoalUpdateContent({
        goalRunId: 'goal-1',
        change,
        status: 'running',
        run: RUN,
      });
      expect(content.text, change).toContain('goal-1');
      expect(content.text, change).not.toContain('is now');
      expect(content.change).toBe(change);
      expect(SystemMessageContentSchema.parse(content)).toEqual(content);
    }
  });

  it('a pause says why; an owner-held one says so; both only while the run is still paused', () => {
    const paused: GoalUpdateRunState = {
      ...RUN,
      status: 'paused',
      pauseReason: 'budget_exhausted',
      pausedByAuthority: 'owner',
    };
    expect(
      buildGoalUpdateContent({ goalRunId: 'g', change: 'pause', status: 'paused', run: paused }),
    ).toEqual({
      kind: 'system.goal_update',
      text: 'Goal g paused: its budget ran out',
      goalRunId: 'g',
      change: 'pause',
      status: 'paused',
      pauseReason: 'budget_exhausted',
      heldByOwner: true,
    });
    // Read after the run resumed: the pause's own sub-state is gone, so none is claimed.
    const after = buildGoalUpdateContent({
      goalRunId: 'g',
      change: 'pause',
      status: 'paused',
      run: { ...RUN, status: 'running' },
    });
    expect(after).not.toHaveProperty('pauseReason');
    expect(after).not.toHaveProperty('heldByOwner');
    expect(after.text).toBe('Goal g paused');
    // A change that is not a pause does not take the pause's sub-state even while paused.
    const confirm = buildGoalUpdateContent({
      goalRunId: 'g',
      change: 'confirm',
      status: 'paused',
      run: paused,
    });
    expect(confirm).not.toHaveProperty('pauseReason');
  });

  it('completion carries its outcome and basis; a cancel its pending cleanup; a revision its number', () => {
    const done = buildGoalUpdateContent({
      goalRunId: 'g',
      change: 'complete',
      status: 'completed',
      run: { ...RUN, status: 'completed', outcome: 'achieved', outcomeBasis: 'verified_by_check' },
    });
    expect(done).toMatchObject({
      text: "Goal g completed: achieved, on the platform's checks",
      outcome: 'achieved',
      outcomeBasis: 'verified_by_check',
    });
    const cancelled = { ...RUN, status: 'cancelled' as const, cleanupPending: true };
    expect(
      buildGoalUpdateContent({
        goalRunId: 'g',
        change: 'finish_cancel',
        status: 'cancelled',
        run: cancelled,
      }),
    ).toMatchObject({ cleanupPending: true, text: expect.stringContaining('cleaned up') });
    expect(
      buildGoalUpdateContent({
        goalRunId: 'g',
        change: 'cleanup_finished',
        status: 'cancelled',
        run: cancelled,
      }),
    ).not.toHaveProperty('cleanupPending');
    expect(
      buildGoalUpdateContent({
        goalRunId: 'g',
        change: 'revise',
        status: 'paused',
        run: { ...RUN, status: 'paused', pauseReason: 'requested', currentRevision: 3 },
      }),
    ).toMatchObject({ revision: 3, text: expect.stringContaining('revision 3') });
  });

  it('an event with no change reads by its status', () => {
    const content = buildGoalUpdateContent({
      goalRunId: 'g',
      change: undefined,
      status: 'verifying',
      run: { ...RUN, status: 'verifying' },
    });
    expect(content).toEqual({
      kind: 'system.goal_update',
      text: 'Goal g is now "verifying"',
      goalRunId: 'g',
      status: 'verifying',
    });
  });
});
