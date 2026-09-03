import { describe, expect, it } from 'vitest';
import {
  buildActionPendingContent,
  buildActionUpdateContent,
  buildTaskUpdateContent,
} from './content.js';

/**
 * application/linkage/content.test: unit tests (no IO) for the three `SystemMessageContent`
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

describe('buildActionPendingContent', () => {
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
      actionKind: 'docker.container_restart',
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
    expect(content.actionKind).toBe('docker.container_restart');
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
