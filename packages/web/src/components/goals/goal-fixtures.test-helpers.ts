import type { GoalDetailWire, GoalRunWire, StepRunWire } from '@nexttime/shared';

/** Goal fixtures shared by the goal pages' tests (`wire/goal.ts` shapes). */

export const GATE_ID = '11111111-1111-4111-8111-111111111111';
export const WORKER_ID = '22222222-2222-4222-8222-222222222222';

export function goalRun(overrides: Partial<GoalRunWire> = {}): GoalRunWire {
  return {
    id: 'goal-1',
    status: 'running',
    pauseReason: null,
    pausedBy: null,
    pausedByAuthority: null,
    cleanupPending: false,
    outcome: null,
    outcomeBasis: null,
    outcomeDecisionId: null,
    onBehalfOf: 'p-alice',
    turnId: null,
    statement: '把三台主机的证书都换成新签发的',
    currentRevision: 1,
    budget: { maxTokens: 100000, maxSteps: 10, maxRevisions: 3, maxWallClockSeconds: 7200 },
    usage: { tokens: 1200, steps: 2, revisions: 0 },
    stepCounts: {
      pending: 1,
      ready: 0,
      running: 1,
      waiting: 0,
      succeeded: 0,
      failed: 0,
      superseded: 0,
      cancelled: 0,
      skipped: 0,
    },
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:10:00.000Z',
    confirmedAt: '2026-10-20T00:01:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

export function stepRun(overrides: Partial<StepRunWire> = {}): StepRunWire {
  return {
    id: 'sr-fetch',
    stepKey: 'fetch',
    introducedInRevision: 1,
    supersededInRevision: null,
    status: 'running',
    waitingReason: null,
    failureCategory: null,
    attemptCount: 1,
    createdAt: '2026-10-20T00:01:00.000Z',
    updatedAt: '2026-10-20T00:02:00.000Z',
    endedAt: null,
    attempts: [
      {
        attempt: 1,
        taskId: 'task-fetch-1',
        status: 'running',
        createdAt: '2026-10-20T00:01:00.000Z',
        failureReason: null,
        rework: false,
        outputProblems: null,
        outputProblemCount: 0,
      },
    ],
    actions: [],
    output: null,
    ...overrides,
  };
}

export function goalDetail(overrides: Partial<GoalDetailWire> = {}): GoalDetailWire {
  const run = goalRun();
  return {
    ...run,
    planRevision: {
      id: 'rev-1',
      goalRunId: run.id,
      revision: 1,
      status: 'accepted',
      basedOnRevision: null,
      plan: {
        steps: [
          { key: 'fetch', worker: { definitionId: WORKER_ID, version: 2 }, input: { hosts: 3 } },
          {
            key: 'apply',
            worker: { definitionId: WORKER_ID, version: 2 },
            dependsOn: ['fetch'],
            maxAttempts: 2,
          },
        ],
        acceptance: [
          {
            kind: 'observe_predicate',
            key: 'certs',
            check: {
              gatekeeperId: GATE_ID,
              operation: 'cert.list',
              expect: { path: 'expiring', op: 'eq', value: 0 },
            },
          },
        ],
      },
      proposedBy: 'p-agent',
      proposer: 'person',
      acceptedBy: 'person',
      reason: null,
      decidedBy: 'p-alice',
      decidedAt: '2026-10-20T00:01:00.000Z',
      createdAt: '2026-10-20T00:00:00.000Z',
      removals: {},
      fromProcedure: null,
      hints: [],
    },
    revisions: [
      {
        id: 'rev-1',
        goalRunId: run.id,
        revision: 1,
        status: 'accepted',
        basedOnRevision: null,
        proposedBy: 'p-agent',
        proposer: 'person',
        acceptedBy: 'person',
        reason: null,
        decidedBy: 'p-alice',
        decidedAt: '2026-10-20T00:01:00.000Z',
        createdAt: '2026-10-20T00:00:00.000Z',
        removals: {},
        fromProcedure: null,
      },
    ],
    steps: [
      stepRun(),
      stepRun({
        id: 'sr-apply',
        stepKey: 'apply',
        status: 'pending',
        attemptCount: 0,
        attempts: [],
      }),
    ],
    acceptance: { rounds: [], steps: [], absenceBaselines: [], overriddenChecks: [] },
    leftovers: null,
    trialApprovals: [],
    planner: null,
    planningRounds: [],
    ...overrides,
  };
}
