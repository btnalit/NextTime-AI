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
    // Review #493: the shape of the answer is not the effect.
    expect(
      problemsOf({
        steps: [
          step('a', { reconcile: [declaration({ path: 'length(keys(@))', op: 'gt', value: 1 })] }),
        ],
      }),
    ).toEqual([
      'step "a": reconcile[0]: path "length(keys(@))" reads the result as a whole (@, *, keys, values or a position) instead of a named field — it would hold on almost any answer',
    ]);
  });

  it('refuses a predicate whose literals carry a suspected credential — in a value, an object value or the path', () => {
    // Synthetic, Handle-shaped and vendor-shaped: what the credential review counts.
    const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
    const vendor = `ghp_${'abcdefghij'.repeat(4)}`;
    const refused: [unknown, string][] = [
      [{ path: 'token', op: 'eq', value: jwt }, 'token'],
      [{ path: 'auth', op: 'eq', value: { password: 'hunter2-not-real' } }, 'auth'],
      [
        { path: `keys[?id=='${vendor}'] | [0].state`, op: 'eq', value: 'active' },
        `keys[?id=='${vendor}'] | [0].state`,
      ],
      [
        {
          all: [
            { path: 'state', op: 'eq', value: 'up' },
            { path: 'owner', op: 'contains', value: vendor },
          ],
        },
        'owner',
      ],
    ];
    for (const [expect_, path] of refused) {
      expect(
        problemsOf({ steps: [step('a', { reconcile: [declaration(expect_)] })] }),
        JSON.stringify(expect_),
      ).toEqual([
        `step "a": reconcile[0]: a value compared at path "${path}" looks like a credential (1 suspected) — the check judges the result with such values redacted, so it could never match; a plan does not carry credentials`,
      ]);
    }
    // Text that only mentions one is an ordinary value: a header's name, a count, a word.
    for (const expect_ of [
      { path: 'header', op: 'eq', value: 'Authorization' },
      { path: 'tokenCount', op: 'gte', value: 3 },
      { path: 'message', op: 'contains', value: 'rotated' },
    ]) {
      expect(() =>
        parsePlan({ steps: [step('a', { reconcile: [declaration(expect_)] })] }),
      ).not.toThrow();
    }
  });
});

describe('parsePlan — reconcile declarations share one lint budget (S11 GO3d)', () => {
  it("refuses predicates past the plan's lint budget, though each alone would pass", () => {
    const gate = randomUUID();
    // Sixteen fields under one wrapper: well within one predicate's bound, a large share of a plan's.
    const wide = {
      all: Array.from({ length: 16 }, (_, i) => ({ path: `result.field${i}`, op: 'eq', value: i })),
    };
    const declarations = (from: number) =>
      Array.from({ length: 8 }, (_, i) => ({
        action: { gatekeeperId: gate, operation: 'svc.restart', params: { n: from + i } },
        check: { gatekeeperId: gate, operation: 'svc.status', expect: wide },
      }));
    expect(() => parsePlan({ steps: [step('a', { reconcile: declarations(0) })] })).not.toThrow();
    const problems = problemsOf({
      steps: [
        step('a', { reconcile: declarations(0) }),
        step('b', { reconcile: declarations(8) }),
        step('c', { reconcile: declarations(16) }),
        step('d', { reconcile: declarations(24) }),
      ],
    });
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem).toMatch(
        /^step "[cd]": reconcile\[\d\]: the plan's predicates together read too many places for the lint to check — test fewer fields$/,
      );
    }
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
