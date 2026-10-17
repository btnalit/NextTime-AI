import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GoalPlanValidationError,
  MAX_PLAN_BYTES,
  MAX_PLAN_STEPS,
  MAX_STEP_ATTEMPTS,
  parsePlan,
  planStep,
  samePlanEntry,
} from './plan.js';

/** application/goal/plan (S11 GO2): the plan checks that need no database. `validatePlan`'s
 *  WorkerDefinition lookups are covered by `advancer.integration.test.ts`. */

const worker = { definitionId: randomUUID(), version: 1 };
const step = (key: string, extra: Record<string, unknown> = {}) => ({ key, worker, ...extra });

function problemsOf(plan: unknown): readonly string[] {
  try {
    parsePlan(plan);
  } catch (err) {
    expect(err).toBeInstanceOf(GoalPlanValidationError);
    return (err as GoalPlanValidationError).problems;
  }
  throw new Error('expected the plan to be refused');
}

describe('parsePlan', () => {
  it('accepts a plan with dependencies, nesting and an attempt limit', () => {
    const plan = parsePlan({
      steps: [
        step('a', { input: { anything: [1, 2] } }),
        step('b'),
        step('c', { dependsOn: ['a', 'b'], nested: true, maxAttempts: MAX_STEP_ATTEMPTS }),
      ],
    });
    expect(plan.steps.map((entry) => entry.key)).toEqual(['a', 'b', 'c']);
  });

  it('refuses unknown fields rather than ignoring them', () => {
    expect(problemsOf({ steps: [step('a', { acceptance: 'always' })] })).toHaveLength(1);
    expect(problemsOf({ steps: [step('a')], outputs: {} })).toHaveLength(1);
    expect(problemsOf({ steps: [{ key: 'a', worker: { ...worker, pinned: true } }] })).toHaveLength(
      1,
    );
  });

  it('refuses an empty plan, too many steps, a bad key, a bad attempt limit', () => {
    expect(problemsOf({ steps: [] })).toHaveLength(1);
    expect(
      problemsOf({
        steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, index) => step(`s${index}`)),
      }),
    ).toHaveLength(1);
    expect(problemsOf({ steps: [step('-leading-dash')] })).toHaveLength(1);
    expect(problemsOf({ steps: [step('a b')] })).toHaveLength(1);
    expect(problemsOf({ steps: [step('a', { maxAttempts: 0 })] })).toHaveLength(1);
    expect(problemsOf({ steps: [step('a', { maxAttempts: MAX_STEP_ATTEMPTS + 1 })] })).toHaveLength(
      1,
    );
    expect(
      problemsOf({ steps: [{ key: 'a', worker: { definitionId: 'x', version: 1 } }] }),
    ).toHaveLength(1);
    expect(problemsOf(null)).toHaveLength(1);
  });

  it('names every graph problem at once: duplicates, self- and unknown dependencies', () => {
    const problems = problemsOf({
      steps: [
        step('a'),
        step('a'),
        step('b', { dependsOn: ['b'] }),
        step('c', { dependsOn: ['x'] }),
      ],
    });
    expect(problems).toEqual([
      'step key "a" appears more than once',
      'step "b" depends on itself',
      'step "c" depends on "x", which is not in the plan',
    ]);
  });

  it('finds a cycle and names it along its path', () => {
    expect(
      problemsOf({
        steps: [
          step('a', { dependsOn: ['c'] }),
          step('b', { dependsOn: ['a'] }),
          step('c', { dependsOn: ['b'] }),
          step('d'),
        ],
      }),
    ).toEqual(['the dependencies form a cycle: a -> c -> b -> a']);
    // A diamond is not a cycle.
    expect(() =>
      parsePlan({
        steps: [
          step('a'),
          step('b', { dependsOn: ['a'] }),
          step('c', { dependsOn: ['a'] }),
          step('d', { dependsOn: ['b', 'c'] }),
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a plan larger than the confirmation card can show', () => {
    const big = 'x'.repeat(MAX_PLAN_BYTES);
    expect(problemsOf({ steps: [step('a', { input: big })] })).toEqual([
      `the plan is larger than ${MAX_PLAN_BYTES} bytes`,
    ]);
  });
});

describe('parsePlan — reconcile declarations (S11 GO3d)', () => {
  const gate = randomUUID();
  const declaration = (expect: unknown = { path: 'state', op: 'eq', value: 'running' }) => ({
    action: { gatekeeperId: gate, operation: 'svc.restart', params: { name: 'web', zone: 'a' } },
    check: { gatekeeperId: gate, operation: 'svc.status', params: { name: 'web' }, expect },
  });

  it('accepts declarations that name an action and a predicate over an observation', () => {
    const other = {
      ...declaration(),
      action: { gatekeeperId: gate, operation: 'svc.reload' },
    };
    const plan = parsePlan({ steps: [step('a', { reconcile: [declaration(), other] })] });
    expect(plan.steps[0]?.reconcile).toHaveLength(2);
  });

  it('refuses an empty list, unknown fields, a missing predicate and the same action twice', () => {
    expect(problemsOf({ steps: [step('a', { reconcile: [] })] })).toHaveLength(1);
    expect(
      problemsOf({ steps: [step('a', { reconcile: [{ ...declaration(), mode: 'auto' }] })] }),
    ).toHaveLength(1);
    const { expect: _missing, ...noPredicate } = declaration().check;
    expect(
      problemsOf({ steps: [step('a', { reconcile: [{ ...declaration(), check: noPredicate }] })] }),
    ).toHaveLength(1);
    // The same identity, params in another order: one declaration per action.
    const reordered = {
      ...declaration(),
      action: { gatekeeperId: gate, operation: 'svc.restart', params: { zone: 'a', name: 'web' } },
    };
    expect(problemsOf({ steps: [step('a', { reconcile: [declaration(), reordered] })] })).toEqual([
      'step "a": reconcile[1]: declares the same action as reconcile[0]',
    ]);
  });

  it('refuses a predicate the lint refuses, naming the step and the declaration', () => {
    const [always] = problemsOf({
      steps: [step('a', { reconcile: [declaration({ not: { path: 'error', op: 'exists' } })] })],
    });
    expect(always).toMatch(/^step "a": reconcile\[0\]: the predicate holds on /);
    expect(
      problemsOf({
        steps: [step('a', { reconcile: [declaration({ path: '`1`', op: 'eq', value: 1 })] })],
      }),
    ).toEqual(['step "a": reconcile[0]: path "`1`" reads nothing from the observation\'s result']);
  });
});

describe('planStep and samePlanEntry', () => {
  const plan = { steps: [step('a', { input: { n: 1 } }), step('b', { dependsOn: ['a'] })] };

  it('reads one entry of a stored plan, or null', () => {
    expect(planStep(plan, 'b')).toEqual(step('b', { dependsOn: ['a'] }));
    expect(planStep(plan, 'z')).toBeNull();
    expect(planStep({ steps: [{ key: 'a', worker: 'not a ref' }] }, 'a')).toBeNull();
    expect(planStep(null, 'a')).toBeNull();
    expect(planStep({ steps: 'nope' }, 'a')).toBeNull();
  });

  it('compares the whole entry as a JSON value, key order aside', () => {
    const reordered = {
      steps: [{ input: { n: 1 }, worker, key: 'a' }, step('b', { dependsOn: ['a'] })],
    };
    expect(samePlanEntry(plan, reordered, 'a')).toBe(true);
    expect(samePlanEntry(plan, plan, 'b')).toBe(true);
    const changed = { steps: [step('a', { input: { n: 2 } }), step('b', { dependsOn: ['a'] })] };
    expect(samePlanEntry(plan, changed, 'a')).toBe(false);
    expect(samePlanEntry(plan, changed, 'b')).toBe(true);
    // A field the new entry adds, even a default one, is a change.
    const widened = { steps: [step('a', { input: { n: 1 }, nested: false }), step('b')] };
    expect(samePlanEntry(plan, widened, 'a')).toBe(false);
    expect(samePlanEntry(plan, { steps: [step('a', { input: { n: 1 } })] }, 'b')).toBe(false);
    expect(samePlanEntry(plan, plan, 'z')).toBe(false);
  });
});
