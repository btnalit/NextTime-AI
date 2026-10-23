import { randomUUID } from 'node:crypto';
import { GOAL_ACCEPTANCE_CHECK_KIND_VALUES } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  RedactedTextSubmittedError,
  TextCarriesCredentialsError,
} from '../../governance/redaction/index.js';
import {
  GoalPlanValidationError,
  IMPLICIT_CONFIRM_KEY,
  MAX_ACCEPTANCE_PROMPT_CHARS,
  MAX_PLAN_ACCEPTANCE_CHECKS,
  MAX_PLAN_BYTES,
  MAX_PLAN_STEPS,
  MAX_STEP_ACCEPTANCE_CHECKS,
  MAX_STEP_ATTEMPTS,
  type PlanStep,
  parsePlan,
  planAsRead,
  planHints,
  planShape,
  planStep,
  refusePlanCredentials,
  reviewRevisedPlan,
  roundAcceptance,
  samePlanEntry,
} from './plan.js';

/** application/goal/plan (S11 GO2): the plan checks that need no database. `validatePlan`'s
 *  WorkerDefinition and Operation lookups are covered by `advancer.integration.test.ts`. */

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
    expect(problemsOf({ steps: [step('a', { verify: 'always' })] })).toHaveLength(1);
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
      'step "a": the key appears more than once',
      'step "b": depends on itself',
      'step "c": depends on "x", which is not in the plan',
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
    ).toEqual(['step "a": the dependencies form a cycle: a -> c -> b -> a']);
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

describe('parsePlan — acceptance checks (S11 GO4a)', () => {
  const gate = randomUUID();
  const observe = (
    key: string,
    expect: unknown = { path: 'state', op: 'eq', value: 'running' },
  ) => ({
    kind: 'observe_predicate',
    key,
    check: { gatekeeperId: gate, operation: 'svc.status', params: { name: 'web' }, expect },
  });
  const confirm = (key: string, prompt = 'Is the weekly report in the shared folder?') => ({
    kind: 'requester_confirm',
    key,
    prompt,
  });

  it('accepts observations and at most one confirmation, each under its own key', () => {
    const plan = parsePlan({
      steps: [step('a')],
      acceptance: [observe('up'), observe('healthy'), confirm('report')],
    });
    expect(plan.acceptance?.map((check) => [check.kind, check.key])).toEqual([
      ['observe_predicate', 'up'],
      ['observe_predicate', 'healthy'],
      ['requester_confirm', 'report'],
    ]);
  });

  it('refuses a prompt that looks like it carries a credential (review #493 on #680)', () => {
    // Synthetic, header- and vendor-shaped: what the credential review counts.
    const header = 'Did the call with Authorization: Bearer synthAbCdEf0123456789xyzQW work?';
    const vendor = `Is ghp_${'abcdefghij'.repeat(4)} rotated?`;
    for (const prompt of [header, vendor]) {
      expect(problemsOf({ steps: [step('a')], acceptance: [confirm('ok', prompt)] })).toEqual([
        'acceptance[0] "ok": the prompt looks like it carries a credential (1 suspected) — a plan does not carry credentials',
      ]);
    }
    // Words about credentials are not one.
    const plan = parsePlan({
      steps: [step('a')],
      acceptance: [confirm('ok', 'Was the API token rotated on schedule?')],
    });
    expect(plan.acceptance).toHaveLength(1);
  });

  it('refuses a key used twice, a second confirmation, an empty prompt, unknown fields and too many checks', () => {
    expect(problemsOf({ steps: [step('a')], acceptance: [observe('up'), confirm('up')] })).toEqual([
      'acceptance[1] "up": the key appears more than once',
    ]);
    expect(
      problemsOf({ steps: [step('a')], acceptance: [confirm('one'), confirm('two')] }),
    ).toEqual(['acceptance[1] "two": a plan asks the requester to confirm at most once']);
    expect(problemsOf({ steps: [step('a')], acceptance: [confirm('ok', '  ')] })).toHaveLength(1);
    expect(
      problemsOf({
        steps: [step('a')],
        acceptance: [confirm('ok', 'x'.repeat(MAX_ACCEPTANCE_PROMPT_CHARS + 1))],
      }),
    ).toHaveLength(1);
    expect(
      problemsOf({ steps: [step('a')], acceptance: [{ ...observe('up'), retries: 3 }] }),
    ).toHaveLength(1);
    expect(
      problemsOf({
        steps: [step('a')],
        acceptance: [{ ...confirm('ok'), check: observe('x').check }],
      }),
    ).toHaveLength(1);
    expect(
      problemsOf({ steps: [step('a')], acceptance: [{ kind: 'reviewer', key: 'r' }] }),
    ).toHaveLength(1);
    expect(
      problemsOf({
        steps: [step('a')],
        acceptance: Array.from({ length: MAX_PLAN_ACCEPTANCE_CHECKS + 1 }, (_, i) =>
          observe(`c${i}`),
        ),
      }),
    ).toHaveLength(1);
  });

  it('holds an observation’s predicate to the lint and the credential review a reconcile check is under', () => {
    const [always] = problemsOf({
      steps: [step('a')],
      acceptance: [observe('up', { not: { path: 'error', op: 'exists' } })],
    });
    expect(always).toMatch(/^acceptance\[0\] "up": the predicate holds on /);
    // Absence is never proof (GO3d's decision): "nothing is there" is refused here too.
    expect(
      problemsOf({
        steps: [step('a')],
        acceptance: [observe('gone', { path: 'length(items)', op: 'eq', value: 0 })],
      }),
    ).toHaveLength(1);
    const vendor = `ghp_${'abcdefghij'.repeat(4)}`;
    expect(
      problemsOf({
        steps: [step('a')],
        acceptance: [observe('up', { path: 'owner', op: 'eq', value: vendor })],
      }),
    ).toEqual([
      'acceptance[0] "up": a value compared at path "owner" looks like a credential (1 suspected) — the check judges the result with such values redacted, so it could never match; a plan does not carry credentials',
    ]);
  });

  it('a plan without an observation carries the requester_confirm_only hint; one with any carries none', () => {
    const confirmOnly = parsePlan({ steps: [step('a')], acceptance: [confirm('report')] });
    expect(planHints(parsePlan({ steps: [step('a')] }))).toEqual([
      {
        code: 'requester_confirm_only',
        message: expect.stringContaining('only when the requester'),
      },
    ]);
    expect(planHints(confirmOnly).map((hint) => hint.code)).toEqual(['requester_confirm_only']);
    expect(planHints(parsePlan({ steps: [step('a')], acceptance: [observe('up')] }))).toEqual([]);
  });

  it('a round checks the plan’s acceptance — or, without any, asks the requester to confirm the statement; an unreadable plan gives none', () => {
    expect(roundAcceptance({ steps: [step('a')] }, 'ship the report')).toEqual([
      { kind: 'requester_confirm', key: IMPLICIT_CONFIRM_KEY, prompt: 'ship the report' },
    ]);
    expect(
      roundAcceptance({ steps: [step('a')], acceptance: [observe('up')] }, 'ship the report'),
    ).toEqual([observe('up')]);
    expect(roundAcceptance({ steps: [] }, 'x')).toBeNull();
    expect(roundAcceptance(null, 'x')).toBeNull();
  });
});

describe('parsePlan — a step’s acceptance checks (S11 GO4b)', () => {
  const gate = randomUUID();
  const observe = (
    key: string,
    expect: unknown = { path: 'state', op: 'eq', value: 'running' },
  ) => ({
    kind: 'observe_predicate',
    key,
    check: { gatekeeperId: gate, operation: 'svc.status', params: { name: 'web' }, expect },
  });

  it('accepts observations under their own keys per step — the same key in another step or the goal’s is fine', () => {
    const plan = parsePlan({
      steps: [
        step('a', { acceptance: [observe('up'), observe('healthy')] }),
        step('b', { dependsOn: ['a'], acceptance: [observe('up')] }),
      ],
      acceptance: [observe('up')],
    });
    expect(plan.steps.map((entry) => entry.acceptance?.map((check) => check.key))).toEqual([
      ['up', 'healthy'],
      ['up'],
    ]);
  });

  it('refuses a confirmation, a fact check carrying an observation, an empty list, a key used twice, unknown fields and too many checks', () => {
    // A step is checked by the platform alone: the requester confirms the goal, never a step.
    expect(
      problemsOf({
        steps: [
          step('a', { acceptance: [{ kind: 'requester_confirm', key: 'ok', prompt: 'ok?' }] }),
        ],
      }),
    ).toHaveLength(1);
    // A fact check names its Fact under `fact`, never an observation.
    expect(
      problemsOf({
        steps: [step('a', { acceptance: [{ ...observe('up'), kind: 'fact_predicate' }] })],
      }),
    ).toEqual([
      'steps.0.acceptance.0.fact: Required',
      "steps.0.acceptance.0: Unrecognized key(s) in object: 'check'",
    ]);
    expect(problemsOf({ steps: [step('a', { acceptance: [] })] })).toHaveLength(1);
    expect(
      problemsOf({ steps: [step('a', { acceptance: [observe('up'), observe('up')] })] }),
    ).toEqual(['step "a": acceptance[1] "up": the key appears more than once']);
    expect(
      problemsOf({ steps: [step('a', { acceptance: [{ ...observe('up'), retries: 3 }] })] }),
    ).toHaveLength(1);
    expect(
      problemsOf({
        steps: [
          step('a', {
            acceptance: Array.from({ length: MAX_STEP_ACCEPTANCE_CHECKS + 1 }, (_, i) =>
              observe(`c${i}`),
            ),
          }),
        ],
      }),
    ).toHaveLength(1);
  });

  it('holds a step’s predicate to the lint and the credential review the goal’s is under, naming the step', () => {
    const [always] = problemsOf({
      steps: [step('a', { acceptance: [observe('up', { not: { path: 'error', op: 'exists' } })] })],
    });
    expect(always).toMatch(/^step "a": acceptance\[0\] "up": the predicate holds on /);
    // Absence is never proof (GO3d's decision): "nothing is there" is refused here too.
    for (const absent of [
      { path: 'length(items)', op: 'eq', value: 0 },
      { path: 'found', op: 'eq', value: false },
    ]) {
      expect(
        problemsOf({ steps: [step('a', { acceptance: [observe('gone', absent)] })] }),
      ).toHaveLength(1);
    }
    const vendor = `ghp_${'abcdefghij'.repeat(4)}`;
    expect(
      problemsOf({
        steps: [
          step('a', { acceptance: [observe('up', { path: 'owner', op: 'eq', value: vendor })] }),
        ],
      }),
    ).toEqual([
      'step "a": acceptance[0] "up": a value compared at path "owner" looks like a credential (1 suspected) — the check judges the result with such values redacted, so it could never match; a plan does not carry credentials',
    ]);
  });
});

describe('parsePlan — acceptance checks on a Fact of the graph (S11 GO4c)', () => {
  const web = randomUUID();
  const fact = (key: string, extra: Record<string, unknown> = {}) => ({
    kind: 'fact_predicate',
    key,
    fact: {
      linkType: 'runs_on',
      source: { objectId: web },
      target: { objectType: 'Host', identity: { name: 'web-1' } },
      ...extra,
    },
  });

  it('accepts a Fact named by its Link type and its two ends, with or without a predicate, on the goal and on a step', () => {
    const plan = parsePlan({
      steps: [step('a', { acceptance: [fact('runs')] })],
      acceptance: [fact('runs', { expect: { path: 'port', op: 'eq', value: 443 } })],
    });
    expect(plan.acceptance).toEqual([
      fact('runs', { expect: { path: 'port', op: 'eq', value: 443 } }),
    ]);
    expect(plan.steps[0]?.acceptance).toEqual([fact('runs')]);
    // A Fact the platform judges is a check it makes: the goal is not achieved on a word alone.
    expect(planHints(parsePlan({ steps: [step('a')], acceptance: [fact('runs')] }))).toEqual([]);
    expect(
      roundAcceptance({ steps: [step('a')], acceptance: [fact('runs')] }, 'ship the report'),
    ).toEqual([fact('runs')]);
  });

  it('refuses a Fact without its Link type or an end, an end named both ways or by nothing, and unknown fields', () => {
    for (const refused of [
      { linkType: '' },
      { source: { objectId: 'web' } },
      { source: { objectId: web, objectType: 'Service', identity: { name: 'web' } } },
      { target: { objectType: 'Host', identity: {} } },
      { target: { objectType: 'Host' } },
      { mode: 'latest' },
    ]) {
      expect(
        problemsOf({ steps: [step('a')], acceptance: [fact('runs', refused)] }),
        JSON.stringify(refused),
      ).toHaveLength(1);
    }
    const { fact: _fact, ...noFact } = fact('runs');
    expect(problemsOf({ steps: [step('a')], acceptance: [noFact] })).toHaveLength(1);
  });

  it('holds a Fact’s predicate to the lint and the credential review, and its identities to the credential review, on the goal and on a step', () => {
    const [always] = problemsOf({
      steps: [step('a')],
      acceptance: [fact('runs', { expect: { not: { path: 'error', op: 'exists' } } })],
    });
    expect(always).toMatch(/^acceptance\[0\] "runs": the predicate holds on /);
    const vendor = `ghp_${'abcdefghij'.repeat(4)}`;
    expect(
      problemsOf({
        steps: [step('a')],
        acceptance: [fact('runs', { expect: { path: 'owner', op: 'eq', value: vendor } })],
      }),
    ).toEqual([
      'acceptance[0] "runs": a value compared at path "owner" looks like a credential (1 suspected) — the check judges the result with such values redacted, so it could never match; a plan does not carry credentials',
    ]);
    // Synthetic and vendor-shaped: what the credential review counts.
    expect(
      problemsOf({
        steps: [
          step('a', {
            acceptance: [
              fact('runs', {
                source: { objectType: 'Account', identity: { name: 'svc', apiKey: vendor } },
              }),
            ],
          }),
        ],
      }),
    ).toEqual([
      'step "a": acceptance[0] "runs": the source\'s identity looks like it carries a credential (1 suspected) — a plan does not carry credentials',
    ]);
    // A name that only mentions one is an ordinary identity.
    expect(() =>
      parsePlan({
        steps: [step('a')],
        acceptance: [
          fact('runs', { target: { objectType: 'Header', identity: { name: 'Authorization' } } }),
        ],
      }),
    ).not.toThrow();
  });
});

describe('parsePlan — absence is never proof, wherever a predicate sits (S11 GO3d, GO4c)', () => {
  const gate = randomUUID();
  const observation = (expect: unknown) => ({
    gatekeeperId: gate,
    operation: 'svc.status',
    expect,
  });
  const factOf = (expect: unknown) => ({
    linkType: 'runs_on',
    source: { objectId: randomUUID() },
    target: { objectId: randomUUID() },
    expect,
  });
  const checkOf: Record<string, (expect: unknown) => Record<string, unknown>> = {
    observe_predicate: (expect) => ({
      kind: 'observe_predicate',
      key: 'k',
      check: observation(expect),
    }),
    fact_predicate: (expect) => ({ kind: 'fact_predicate', key: 'k', fact: factOf(expect) }),
  };
  /** A plan with one predicate, for every place a plan carries one. */
  const PLACES: Record<string, (expect: unknown) => unknown> = {
    reconcile: (expect) => ({
      steps: [
        step('a', {
          reconcile: [
            {
              action: { gatekeeperId: gate, operation: 'svc.restart' },
              check: observation(expect),
            },
          ],
        }),
      ],
    }),
    ...Object.fromEntries(
      Object.entries(checkOf).flatMap(([kind, check]) => [
        [
          `goal ${kind}`,
          (expect: unknown) => ({ steps: [step('a')], acceptance: [check(expect)] }),
        ],
        [
          `step ${kind}`,
          (expect: unknown) => ({ steps: [step('a', { acceptance: [check(expect)] })] }),
        ],
      ]),
    ),
  };

  it('covers reconcile and every acceptance check kind but the requester’s word, on the goal and on a step', () => {
    const judged = GOAL_ACCEPTANCE_CHECK_KIND_VALUES.filter((kind) => kind !== 'requester_confirm');
    expect(Object.keys(PLACES).sort()).toEqual(
      ['reconcile', ...judged.flatMap((kind) => [`goal ${kind}`, `step ${kind}`])].sort(),
    );
  });

  it.each(Object.keys(PLACES))(
    '%s: refuses "nothing is there" — an empty list, a found flag false',
    (place) => {
      const plan = PLACES[place] as (expect: unknown) => unknown;
      for (const absent of [
        { path: 'length(items)', op: 'eq', value: 0 },
        { path: 'found', op: 'eq', value: false },
      ]) {
        expect(problemsOf(plan(absent)), JSON.stringify(absent)).toHaveLength(1);
      }
      expect(() => parsePlan(plan({ path: 'state', op: 'eq', value: 'running' }))).not.toThrow();
    },
  );
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

// S11 GO5c: what `propose_goal` and `revise_goal` refuse before a plan's other problems, each
// place named the way the console's plan editor finds it (`plan.steps.<i>.…`).
describe('refusePlanCredentials', () => {
  /** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
  const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

  function refusalOf(plan: unknown): { readonly name: string; readonly details: unknown } {
    try {
      refusePlanCredentials(planShape(plan));
    } catch (err) {
      return err as { name: string; details: unknown };
    }
    throw new Error('expected the plan to be refused');
  }

  it('lets a plan whose every part reads back as written through', () => {
    expect(() =>
      refusePlanCredentials(
        planShape({
          steps: [step('a', { input: { host: 'db-1', note: 'rotate the key' } }), step('b')],
          acceptance: [{ key: 'ok', kind: 'requester_confirm', prompt: 'Is the report right?' }],
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a credential in a call argument — under a secret field name, or by its value — naming every place', () => {
    const refused = refusalOf({
      steps: [
        step('a', { input: { host: 'db-1', password: 'anything' } }),
        step('b', { input: { targets: [{ name: 'x' }, { header: `Bearer ${FAKE}` }] } }),
      ],
    });
    expect(refused).toBeInstanceOf(TextCarriesCredentialsError);
    expect(refused.details).toEqual({
      field: 'plan.steps.0.input.password',
      suspectedSecretValues: 2,
      suspectedSecretPaths: ['plan.steps.0.input.password', 'plan.steps.1.input.targets.1.header'],
    });
    expect(JSON.stringify(refused)).not.toContain(FAKE);
  });

  it('refuses one anywhere else in the plan — a confirmation prompt — the same way, before the plan’s other problems', () => {
    const plan = {
      steps: [step('a')],
      acceptance: [{ key: 'ok', kind: 'requester_confirm', prompt: `PGPASSWORD=${FAKE} worked?` }],
    };
    expect(refusalOf(plan).details).toEqual({
      field: 'plan.acceptance.0.prompt',
      suspectedSecretValues: 1,
      suspectedSecretPaths: ['plan.acceptance.0.prompt'],
    });
    // parsePlan alone still names it as a problem (a plan stored before, read back).
    expect(problemsOf(plan)).toHaveLength(1);
  });

  it('counts a schema literal under a secret-named key once (review #493 on #704)', () => {
    expect(
      refusalOf({ steps: [step('a', { input: { schema: { apiKey: { default: 'x1' } } } })] })
        .details,
    ).toEqual({
      field: 'plan.steps.0.input.schema.apiKey.default',
      suspectedSecretValues: 1,
      suspectedSecretPaths: ['plan.steps.0.input.schema.apiKey.default'],
    });
  });

  it('refuses a [redacted] mark copied from a read, naming where — before looking for credentials', () => {
    const refused = refusalOf({
      steps: [
        step('a', { input: { password: 'anything' } }),
        step('b', { input: { note: 'use [redacted] here' } }),
      ],
    });
    expect(refused).toBeInstanceOf(RedactedTextSubmittedError);
    expect(refused.details).toEqual({
      field: 'plan.steps.1.input.note',
      paths: ['plan.steps.1.input.note'],
    });
  });
});

describe('reviewRevisedPlan (S11 GO5c: an entry sent back as read)', () => {
  /** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
  const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';
  const stored = planShape({
    steps: [
      step('a', { input: { host: 'db1', password: `${FAKE}A` } }),
      step('b', { input: { host: 'db1', password: `${FAKE}B` } }),
      step('z', { input: { note: 'family \u{1F468}\u200D\u{1F469}' } }),
    ],
    acceptance: [
      { key: 'ok', kind: 'requester_confirm', prompt: 'the \u{1F468}\u200D\u{1F469} photo' },
    ],
  });
  const read = planAsRead(stored);
  const [readA, readB, readZ] = read.steps as [PlanStep, PlanStep, PlanStep];

  function refusalOf(submitted: unknown): { readonly name: string; readonly details: unknown } {
    try {
      reviewRevisedPlan(planShape(submitted), stored);
    } catch (err) {
      return err as { name: string; details: unknown };
    }
    throw new Error('expected the revision to be refused');
  }

  it('the read differs from what is stored: a credential masked, a joiner spelled out', () => {
    expect(readA.input).toEqual({ host: 'db1', password: '[redacted]' });
    expect(JSON.stringify(readZ.input)).toContain('\\u{200D}');
    expect(read.acceptance?.[0]).toMatchObject({ prompt: expect.stringContaining('\\u{200D}') });
  });

  it('keeps the stored original of every entry sent back as read, in the order sent', () => {
    const added = step('c', { input: { host: 'db3' } });
    expect(
      reviewRevisedPlan(planShape({ ...read, steps: [readZ, readB, readA, added] }), stored),
    ).toEqual({
      steps: [stored.steps[2], stored.steps[1], stored.steps[0], added],
      acceptance: stored.acceptance,
    });
  });

  it('restores leaf by leaf: a value left as read beside a changed one keeps what is stored', () => {
    expect(
      reviewRevisedPlan(planShape({ ...read, steps: [{ ...readA, maxAttempts: 2 }] }), stored)
        .steps,
    ).toEqual([{ ...stored.steps[0], maxAttempts: 2 }]);
  });

  it('checks only what was written, refused at its place in the plan sent', () => {
    expect(
      refusalOf({
        ...read,
        steps: [readB, { ...readA, input: { host: 'db1', password: '[redacted]!' } }],
      }),
    ).toMatchObject({
      name: 'RedactedTextSubmittedError',
      details: { field: 'plan.steps.1.input.password', paths: ['plan.steps.1.input.password'] },
    });
    expect(
      refusalOf({
        ...read,
        acceptance: [{ key: 'ok', kind: 'requester_confirm', prompt: `PGPASSWORD=${FAKE}` }],
      }),
    ).toMatchObject({
      name: 'TextCarriesCredentialsError',
      details: { field: 'plan.acceptance.0.prompt', suspectedSecretValues: 1 },
    });
    // A value left as read is not counted with what was written.
    expect(
      refusalOf({
        ...read,
        steps: [{ ...readA, input: { host: 'db1', password: '[redacted]', token: `${FAKE}C` } }],
      }),
    ).toMatchObject({
      name: 'TextCarriesCredentialsError',
      details: {
        field: 'plan.steps.0.input.token',
        suspectedSecretValues: 1,
        suspectedSecretPaths: ['plan.steps.0.input.token'],
      },
    });
  });

  it('never brings one entry’s original along with another’s read', () => {
    // b's read under a new key is a new entry, checked — not b.
    expect(refusalOf({ ...read, steps: [readA, { ...readB, key: 'd' }] })).toMatchObject({
      name: 'RedactedTextSubmittedError',
      details: { field: 'plan.steps.1.input.password' },
    });
    // b's read under a's key equals a's own read, so it is a — with a's original, never b's.
    const revised = reviewRevisedPlan(
      planShape({ ...read, steps: [{ ...readB, key: 'a' }] }),
      stored,
    );
    expect(revised.steps).toEqual([stored.steps[0]]);
  });
});
