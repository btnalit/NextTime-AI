import type { GoalPlan, PlannerRevisionClassReasonWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  type ClassifyPlannerRevisionInput,
  type RunningStepFacts,
  type StepAbility,
  changedStepKeys,
  classifyPlannerRevision,
} from './revision-class.js';

/** application/goal/revision-class (S11 GO9b): the classing rule, table by table. What the facts
 *  are read from (`plannerRevisionFacts`) is covered by `goal-planner.integration.test.ts`. */

const workerA = { definitionId: '00000000-0000-4000-8000-00000000000a', version: 1 };
const workerB = { definitionId: '00000000-0000-4000-8000-00000000000b', version: 2 };

const observe = (key: string, value: string) => ({
  kind: 'observe_predicate',
  key,
  check: { gatekeeperId: 'g', operation: 'ledger.get', params: { id: value }, predicate: 'x' },
});

type Step = Record<string, unknown> & { readonly key: string };
const step = (key: string, extra: Record<string, unknown> = {}): Step => ({
  key,
  worker: workerA,
  ...extra,
});
const plan = (steps: readonly Step[], acceptance?: readonly unknown[]): GoalPlan =>
  ({ steps, ...(acceptance ? { acceptance } : {}) }) as unknown as GoalPlan;

const reads: StepAbility = { kind: 'resolved', executes: false, blocked: false };
const acts: StepAbility = { kind: 'resolved', executes: true, blocked: false };
const blocked: StepAbility = { kind: 'resolved', executes: false, blocked: true };
const live: RunningStepFacts = { ended: false, liveWork: false };
const busy: RunningStepFacts = { ended: false, liveWork: true };
const done: RunningStepFacts = { ended: true, liveWork: false };

function classify(
  input: Partial<ClassifyPlannerRevisionInput> &
    Pick<ClassifyPlannerRevisionInput, 'base' | 'candidate'>,
): { readonly revisionClass: string; readonly reasons: readonly PlannerRevisionClassReasonWire[] } {
  const abilities =
    input.abilities ??
    new Map(changedStepKeys(input.base, input.candidate).map((key) => [key, reads] as const));
  return classifyPlannerRevision({ running: new Map(), ...input, abilities });
}

const reason = (code: string, stepKey: string | null = null) => ({ code, stepKey });

describe('changedStepKeys', () => {
  it('names the steps added or changed, not the ones kept or removed', () => {
    const base = plan([step('a'), step('b'), step('c')]);
    const candidate = plan([step('a'), step('b', { worker: workerB }), step('d')]);
    expect(changedStepKeys(base, candidate)).toEqual(['b', 'd']);
  });

  it('reads a step the same whatever the order of its fields', () => {
    const base = plan([{ worker: workerA, key: 'a', input: { x: 1, y: 2 } }]);
    const candidate = plan([step('a', { input: { y: 2, x: 1 } })]);
    expect(changedStepKeys(base, candidate)).toEqual([]);
  });
});

describe('classifyPlannerRevision', () => {
  const cases: readonly {
    readonly name: string;
    readonly input: Partial<ClassifyPlannerRevisionInput> &
      Pick<ClassifyPlannerRevisionInput, 'base' | 'candidate'>;
    readonly reasons: readonly ReturnType<typeof reason>[];
  }[] = [
    {
      name: 'a different Worker for a failed step that only reads is minor',
      input: {
        base: plan([step('fetch'), step('sum', { dependsOn: ['fetch'] })]),
        candidate: plan([
          step('fetch', { worker: workerB }),
          step('sum', { dependsOn: ['fetch'] }),
        ]),
        running: new Map([['fetch', live]]),
      },
      reasons: [],
    },
    {
      name: 'a new step, a removed step without checks and a new order are minor',
      input: {
        base: plan([step('a'), step('b', { dependsOn: ['a'] })]),
        candidate: plan([step('c'), step('b', { dependsOn: ['c'] })]),
        running: new Map([
          ['a', live],
          ['b', live],
        ]),
      },
      reasons: [],
    },
    {
      name: 'adding a goal acceptance check is the requester’s',
      input: {
        base: plan([step('a')]),
        candidate: plan([step('a')], [observe('done', '1')]),
      },
      reasons: [reason('goal_acceptance_changed')],
    },
    {
      name: 'removing the goal acceptance is the requester’s',
      input: {
        base: plan([step('a')], [observe('done', '1')]),
        candidate: plan([step('a')]),
      },
      reasons: [reason('goal_acceptance_changed')],
    },
    {
      name: 'a changed step that drops one of its checks',
      input: {
        base: plan([step('a', { acceptance: [observe('k1', '1'), observe('k2', '2')] })]),
        candidate: plan([step('a', { worker: workerB, acceptance: [observe('k1', '1')] })]),
        running: new Map([['a', live]]),
      },
      reasons: [reason('step_acceptance_changed', 'a')],
    },
    {
      name: 'a changed step that loosens a check (same key, other params)',
      input: {
        base: plan([step('a', { acceptance: [observe('k1', '1')] })]),
        candidate: plan([step('a', { acceptance: [observe('k1', 'anything')] })]),
        running: new Map([['a', live]]),
      },
      reasons: [reason('step_acceptance_changed', 'a')],
    },
    {
      name: 'a changed step that adds a check keeps what had to hold: minor',
      input: {
        base: plan([step('a', { acceptance: [observe('k1', '1')] })]),
        candidate: plan([step('a', { acceptance: [observe('k1', '1'), observe('k2', '2')] })]),
        running: new Map([['a', live]]),
      },
      reasons: [],
    },
    {
      name: 'a removed step with checks no other step takes over',
      input: {
        base: plan([step('verify', { acceptance: [observe('k1', '1')] }), step('b')]),
        candidate: plan([step('b'), step('verify2')]),
        running: new Map([['verify', live]]),
      },
      reasons: [reason('step_acceptance_changed', 'verify')],
    },
    {
      name: 'a removed step whose checks a new step takes over, under its own key: minor',
      input: {
        base: plan([step('verify', { acceptance: [observe('k1', '1')] })]),
        candidate: plan([
          step('verify2', { worker: workerB, acceptance: [observe('other', '1')] }),
        ]),
        running: new Map([['verify', live]]),
      },
      reasons: [],
    },
    {
      name: 'a check that only a kept, ended step still declares does not count as kept',
      input: {
        base: plan([
          step('done1', { acceptance: [observe('k1', '1')] }),
          step('a', { acceptance: [observe('k1', '1')] }),
        ]),
        candidate: plan([step('done1', { acceptance: [observe('k1', '1')] }), step('b')]),
        running: new Map([
          ['done1', done],
          ['a', live],
        ]),
      },
      reasons: [reason('step_acceptance_changed', 'a')],
    },
    {
      name: 'removing an ended step’s checks changes nothing to verify',
      input: {
        base: plan([step('old', { acceptance: [observe('k1', '1')] }), step('a')]),
        candidate: plan([step('a', { worker: workerB })]),
        running: new Map([['old', done]]),
      },
      reasons: [],
    },
    {
      name: 'a new step whose Worker could request actions',
      input: {
        base: plan([step('a')]),
        candidate: plan([step('a'), step('write')]),
        abilities: new Map([['write', acts]]),
      },
      reasons: [reason('execution_step', 'write')],
    },
    {
      name: 'a changed step that may start Workers of its own',
      input: {
        base: plan([step('a')]),
        candidate: plan([step('a', { nested: true })]),
      },
      reasons: [reason('execution_step', 'a')],
    },
    {
      name: 'a new step that declares reconcile checks (it raises actions), named once',
      input: {
        base: plan([step('a')]),
        candidate: plan([step('a'), step('w', { reconcile: [{ action: {}, check: {} }] })]),
        abilities: new Map([['w', acts]]),
      },
      reasons: [reason('execution_step', 'w')],
    },
    {
      name: 'a kept step that can act is not the revision’s doing: minor',
      input: {
        base: plan([step('write', { nested: true }), step('a')]),
        candidate: plan([step('write', { nested: true }), step('a', { worker: workerB })]),
      },
      reasons: [],
    },
    {
      name: 'a new step that would wait for a person to start',
      input: {
        base: plan([step('a')]),
        candidate: plan([step('a'), step('draft')]),
        abilities: new Map([['draft', blocked]]),
      },
      reasons: [reason('admission_blocked', 'draft')],
    },
    {
      name: 'a requester who cannot start Workers blocks every new step',
      input: {
        base: plan([step('a')]),
        candidate: plan([step('a'), step('b')]),
        requesterBlocked: true,
      },
      reasons: [reason('admission_blocked')],
    },
    {
      name: 'changing a step whose Task still runs would stop it',
      input: {
        base: plan([step('slow'), step('a')]),
        candidate: plan([step('slow', { worker: workerB }), step('a')]),
        running: new Map([['slow', busy]]),
      },
      reasons: [reason('stops_live_work', 'slow')],
    },
    {
      name: 'removing a step with an action in flight would stop it',
      input: {
        base: plan([step('slow'), step('a')]),
        candidate: plan([step('a')]),
        running: new Map([['slow', busy]]),
      },
      reasons: [reason('stops_live_work', 'slow')],
    },
    {
      name: 'a busy step the revision keeps as it is: minor',
      input: {
        base: plan([step('slow'), step('a')]),
        candidate: plan([step('slow'), step('a', { worker: workerB })]),
        running: new Map([['slow', busy]]),
      },
      reasons: [],
    },
    {
      name: 'a step whose abilities could not be worked out',
      input: {
        base: plan([step('a')]),
        candidate: plan([step('a'), step('b')]),
        abilities: new Map([['b', { kind: 'unresolved' } as const]]),
      },
      reasons: [reason('unresolvable', 'b')],
    },
    {
      name: 'a step the facts left out counts as unresolvable',
      input: {
        base: plan([step('a')]),
        candidate: plan([step('a'), step('b')]),
        abilities: new Map(),
      },
      reasons: [reason('unresolvable', 'b')],
    },
    {
      name: 'every reason is named, goal first, then step by step',
      input: {
        base: plan(
          [step('a', { acceptance: [observe('k', '1')] }), step('busy')],
          [observe('g', '1')],
        ),
        candidate: plan([step('busy', { worker: workerB }), step('w')], [observe('g', '2')]),
        running: new Map([
          ['a', live],
          ['busy', busy],
        ]),
        abilities: new Map([
          ['busy', reads],
          ['w', { kind: 'resolved', executes: true, blocked: true }],
        ]),
      },
      reasons: [
        reason('goal_acceptance_changed'),
        reason('step_acceptance_changed', 'a'),
        reason('stops_live_work', 'busy'),
        reason('execution_step', 'w'),
        reason('admission_blocked', 'w'),
      ],
    },
  ];

  for (const { name, input, reasons } of cases) {
    it(name, () => {
      const result = classify(input);
      expect(result.reasons).toEqual(reasons);
      expect(result.revisionClass).toBe(reasons.length > 0 ? 'major' : 'minor');
    });
  }
});
