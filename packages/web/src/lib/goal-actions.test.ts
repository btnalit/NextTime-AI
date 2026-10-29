import type { AuditRecordWire, GoalDetailWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { goalDetail, stepRun } from '../components/goals/goal-fixtures.test-helpers.js';
import {
  goalOperations,
  holdPlacedAt,
  reconcileOptions,
  retryableStepKeys,
  revisionsSince,
} from './goal-actions.js';
import type { Translate } from './i18n.js';

const zh: Translate = (zhText) => zhText;
const ALICE = { principalId: 'p-alice', isOwner: false };
const OWNER = { principalId: 'p-owner', isOwner: true };
const BOB = { principalId: 'p-bob', isOwner: false };

const ops = (detail: GoalDetailWire, viewer: typeof ALICE) =>
  Object.keys(goalOperations(detail, viewer, zh)).sort();

describe('lib/goal-actions', () => {
  it('a proposal: the requester confirms or rejects it, an owner may only reject it', () => {
    const proposed = goalDetail({ status: 'proposed', currentRevision: null, confirmedAt: null });
    expect(ops(proposed, ALICE)).toEqual(['confirm', 'reject']);
    expect(ops(proposed, OWNER)).toEqual(['reject']);
    expect(ops(proposed, BOB)).toEqual([]);
  });

  it('a running goal: the requester pauses or cancels it; an owner’s pause on it is a hold', () => {
    const running = goalDetail();
    expect(ops(running, ALICE)).toEqual(['cancel', 'pause']);
    expect(goalOperations(running, ALICE, zh).pause?.holds).toBe(false);
    expect(goalOperations(running, OWNER, zh).pause?.holds).toBe(true);
  });

  it('a held goal: its requester’s resume waits for the hold, an owner lifts it', () => {
    const held = goalDetail({
      status: 'paused',
      pauseReason: 'requested',
      pausedBy: 'p-owner',
      pausedByAuthority: 'owner',
      steps: [stepRun({ status: 'pending', attempts: [], attemptCount: 0 })],
    });
    const mine = goalOperations(held, ALICE, zh);
    expect(mine.resume?.disabledReason).toMatch(/要等所有者解除锁定/);
    expect(mine.end?.disabledReason).toBeNull();
    expect(mine.release).toBeUndefined();
    expect(ops(held, OWNER)).toEqual(['cancel', 'release']);
    // A requester who is an owner too, held by another owner: they lift it themselves.
    const ownerToo = goalOperations(held, { principalId: 'p-alice', isOwner: true }, zh);
    expect(ownerToo.release?.disabledReason).toBeNull();
    expect(ownerToo.resume?.disabledReason).toMatch(/先点「解除锁定」/);
  });

  it('an owner places a hold on someone else’s paused goal; its requester resumes it', () => {
    const paused = goalDetail({ status: 'paused', pauseReason: 'needs_decision' });
    expect(ops(paused, OWNER)).toEqual(['cancel', 'hold']);
    expect(goalOperations(paused, ALICE, zh).resume?.disabledReason).toBeNull();
  });

  it('ending waits for the steps that still run; achieved only from paused', () => {
    const paused = goalDetail({ status: 'paused', pauseReason: 'requested' });
    const end = goalOperations(paused, ALICE, zh).end;
    expect(end?.achieved).toBe(true);
    expect(end?.disabledReason).toMatch(/fetch/);
    const verifying = goalDetail({
      status: 'verifying',
      steps: [stepRun({ status: 'succeeded' })],
    });
    expect(goalOperations(verifying, ALICE, zh).end).toEqual({
      achieved: false,
      disabledReason: null,
    });
  });

  it('confirming the acceptance waits for the platform’s checks of the current round', () => {
    const check = (
      checkKey: string,
      kind: 'requester_confirm' | 'observe_predicate',
      status: 'pending' | 'passed',
    ) => ({
      checkKey,
      kind,
      status,
      check: null,
      fact: null,
      prompt: kind === 'requester_confirm' ? '证书都换好了吗？' : null,
      attempts: 0,
      lastError: null,
      observationId: null,
      factId: null,
      decisionId: null,
      nextAttemptAt: null,
      settledAt: null,
      overridden: false,
    });
    const verifying = (platform: 'pending' | 'passed') =>
      goalDetail({
        status: 'verifying',
        steps: [stepRun({ status: 'succeeded' })],
        acceptance: {
          rounds: [
            {
              round: 1,
              planRevision: 1,
              openedAt: '2026-10-20T01:00:00.000Z',
              checks: [
                check('certs', 'observe_predicate', platform),
                check('ok', 'requester_confirm', 'pending'),
              ],
            },
          ],
          steps: [],
          absenceBaselines: [],
          overriddenChecks: [],
        },
      });
    const waiting = goalOperations(verifying('pending'), ALICE, zh).confirmAcceptance;
    expect(waiting?.check.checkKey).toBe('ok');
    expect(waiting?.disabledReason).toMatch(/还没全部通过/);
    expect(
      goalOperations(verifying('passed'), ALICE, zh).confirmAcceptance?.disabledReason,
    ).toBeNull();
    expect(goalOperations(verifying('passed'), OWNER, zh).confirmAcceptance).toBeUndefined();
  });

  it('offers failed steps of the plan in force for retry, never superseded ones', () => {
    const detail = goalDetail({
      steps: [
        stepRun({ status: 'failed', failureCategory: 'transient' }),
        stepRun({ id: 'sr-old', stepKey: 'old', status: 'superseded', supersededInRevision: 2 }),
        stepRun({ id: 'sr-apply', stepKey: 'apply', status: 'succeeded' }),
      ],
    });
    expect(retryableStepKeys(detail)).toEqual(['fetch']);
  });

  it('a finding is the requester’s or an owner’s; running it again the requester’s, while the goal can run', () => {
    const action = {
      actionRequestId: 'ar-1',
      stepRunId: 'sr-fetch',
      stepKey: 'fetch',
      gatekeeperId: 'gk',
      actionKindTag: 'cert.replace',
      failedAt: null,
      needs: 'finding' as const,
      platformCheck: null,
    };
    const paused = goalDetail({ status: 'paused', pauseReason: 'awaiting_reconcile' });
    expect(reconcileOptions(paused, action, ALICE)).toEqual({ record: true, reexecute: true });
    expect(reconcileOptions(paused, action, OWNER)).toEqual({ record: true, reexecute: false });
    const cancelled = goalDetail({ status: 'cancelled' });
    expect(reconcileOptions(cancelled, action, ALICE)).toEqual({ record: true, reexecute: false });
    // As the kernel: not while verifying, and not for a step that has ended (review #501 on #697).
    const verifying = goalDetail({ status: 'verifying' });
    expect(reconcileOptions(verifying, action, ALICE).reexecute).toBe(false);
    const ended = goalDetail({
      status: 'paused',
      pauseReason: 'awaiting_reconcile',
      steps: paused.steps.map((step) =>
        step.id === action.stepRunId ? { ...step, status: 'succeeded' as const } : step,
      ),
    });
    expect(reconcileOptions(ended, action, ALICE).reexecute).toBe(false);
    expect(reconcileOptions(paused, { ...action, needs: 'decision' }, ALICE).record).toBe(false);
  });

  it('finds when the hold was placed, and the revisions accepted since', () => {
    const record = (action: string, createdAt: string, payload: Record<string, unknown> = {}) =>
      ({
        id: `${action}-${createdAt}`,
        actorPrincipalId: 'p-owner',
        action,
        resourceType: 'goal_run',
        resourceId: 'goal-1',
        payload,
        createdAt,
      }) satisfies AuditRecordWire;
    expect(
      holdPlacedAt([
        record('goal_run.resume', '2026-10-21T00:00:00.000Z'),
        record('goal_run.pause', '2026-10-20T12:00:00.000Z', { pausedByAuthority: 'owner' }),
        record('goal_run.pause', '2026-10-20T06:00:00.000Z', { pausedByAuthority: 'requester' }),
      ]),
    ).toBe('2026-10-20T12:00:00.000Z');
    expect(holdPlacedAt([record('goal_run.hold', '2026-10-20T09:00:00.000Z')])).toBe(
      '2026-10-20T09:00:00.000Z',
    );
    expect(holdPlacedAt([record('goal_run.pause', '2026-10-20T06:00:00.000Z')])).toBeNull();
    // Two pages (holds, pauses) merged: the latest wins whatever the order.
    expect(
      holdPlacedAt([
        record('goal_run.hold', '2026-10-20T09:00:00.000Z'),
        record('goal_run.pause', '2026-10-20T12:00:00.000Z', { pausedByAuthority: 'owner' }),
      ]),
    ).toBe('2026-10-20T12:00:00.000Z');

    const base = goalDetail().revisions[0];
    if (!base) throw new Error('fixture has a revision');
    const v2 = { ...base, id: 'rev-2', revision: 2, decidedAt: '2026-10-20T13:00:00.000Z' };
    expect(revisionsSince([base, v2], '2026-10-20T12:00:00.000Z').map((r) => r.revision)).toEqual([
      2,
    ]);
    expect(revisionsSince([base, v2], '2026-10-20T14:00:00.000Z')).toEqual([]);
  });
});
