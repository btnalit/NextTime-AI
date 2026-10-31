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

  it('refuses an empty list, unknown fields and the same action twice', () => {
    expect(problemsOf({ steps: [step('a', { reconcile: [] })] })).toHaveLength(1);
    expect(
      problemsOf({ steps: [step('a', { reconcile: [{ ...declaration(), mode: 'auto' }] })] }),
    ).toHaveLength(1);
    expect(
      problemsOf({
        steps: [
          step('a', {
            reconcile: [{ ...declaration(), check: { ...declaration().check, absent: true } }],
          }),
        ],
      }),
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

describe('parsePlan — reconcile declarations with an absence call (S11 「门确认不存在」 reconcile)', () => {
  const gate = randomUUID();
  const action = { gatekeeperId: gate, operation: 'vm.delete', params: { name: 'old-web' } };
  const call = { gatekeeperId: gate, operation: 'vm.get', params: { name: 'old-web' } };
  const absent = (key: string, check: unknown = call) => ({ kind: 'observe_absent', key, check });
  const message =
    'step "a": reconcile[0]: an absence check shows the action took effect only if the platform saw the thing there before it — make the same call (Gatekeeper, Operation and params) in an observe_absent acceptance check of this step or of the goal: the platform looks with it before the step starts';

  it("accepts one whose call is an observe_absent check's — the step's own or the goal's", () => {
    const own = parsePlan({
      steps: [step('a', { reconcile: [{ action, check: call }], acceptance: [absent('gone')] })],
    });
    expect(own.steps[0]?.reconcile?.[0]?.check).toEqual(call);
    expect(() =>
      parsePlan({
        steps: [step('a', { reconcile: [{ action, check: call }] })],
        acceptance: [absent('gone')],
      }),
    ).not.toThrow();
  });

  it('refuses one with no such check, or whose check makes another call', () => {
    expect(problemsOf({ steps: [step('a', { reconcile: [{ action, check: call }] })] })).toEqual([
      message,
    ]);
    // Other params, another step's check, or an observation with a predicate: not the baseline.
    for (const plan of [
      {
        steps: [
          step('a', {
            reconcile: [{ action, check: call }],
            acceptance: [absent('gone', { ...call, params: { name: 'old-db' } })],
          }),
        ],
      },
      {
        steps: [
          step('a', { reconcile: [{ action, check: call }] }),
          step('b', { acceptance: [absent('gone')] }),
        ],
      },
      {
        steps: [
          step('a', {
            reconcile: [{ action, check: call }],
            acceptance: [
              {
                kind: 'observe_predicate',
                key: 'gone',
                check: { ...call, expect: { path: 'state', op: 'eq', value: 'deleted' } },
              },
            ],
          }),
        ],
      },
    ]) {
      expect(problemsOf(plan), JSON.stringify(plan)).toEqual([message]);
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
      'steps.0.acceptance.0.fact: Invalid input: expected object, received undefined',
      'steps.0.acceptance.0: Unrecognized key: "check"',
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

  it('covers reconcile and every acceptance check kind that carries a predicate, on the goal and on a step', () => {
    // The requester's word carries none, nor does an absence check (S11 「门确认不存在」 B): the
    // gate's answer is the check, and its schema refuses a predicate (`predicate.test.ts`).
    const judged = GOAL_ACCEPTANCE_CHECK_KIND_VALUES.filter(
      (kind) => kind !== 'requester_confirm' && kind !== 'observe_absent',
    );
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
        steps: [{ ...readA, maxAttempts: 2 }],
        acceptance: [{ key: 'ok', kind: 'requester_confirm', prompt: `PGPASSWORD=${FAKE}` }],
      }),
    ).toMatchObject({
      name: 'TextCarriesCredentialsError',
      details: {
        field: 'plan.acceptance.0.prompt',
        suspectedSecretValues: 1,
        suspectedSecretPaths: ['plan.acceptance.0.prompt'],
      },
    });
  });

  it('gives a masked value back only with its whole call argument sent as read (review #493 on #704)', () => {
    const withRows = planShape({
      steps: [
        step('t', {
          input: {
            targets: [
              { host: 'h1', password: `${FAKE}1` },
              { host: 'h2', password: `${FAKE}2` },
            ],
            tokens: [`${FAKE}A`, `${FAKE}B`],
          },
        }),
      ],
    });
    const [readT] = planAsRead(withRows).steps as [PlanStep];
    const input = readT.input as {
      targets: { host: string; password: string }[];
      tokens: string[];
    };
    const refusedAt = (changed: Record<string, unknown>) => {
      try {
        reviewRevisedPlan(
          planShape({ steps: [{ ...readT, input: { ...input, ...changed } }] }),
          withRows,
        );
      } catch (err) {
        return { name: (err as Error).name, details: (err as { details: unknown }).details };
      }
      throw new Error('expected the revision to be refused');
    };
    // A row deleted, two rows swapped, an item deleted, a host changed: each [redacted] left in the
    // changed input is refused where it stands — never filled with whatever was stored there.
    expect(refusedAt({ targets: [input.targets[1]] })).toEqual({
      name: 'RedactedTextSubmittedError',
      details: { field: 'plan.steps.0.input.targets.0.password', paths: expect.any(Array) },
    });
    expect(refusedAt({ targets: [input.targets[1], input.targets[0]] })).toMatchObject({
      details: { field: 'plan.steps.0.input.targets.0.password' },
    });
    expect(refusedAt({ tokens: [input.tokens[1]] })).toMatchObject({
      details: { field: 'plan.steps.0.input.targets.0.password' },
    });
    expect(
      refusedAt({ targets: [{ ...input.targets[0], host: 'h9' }, input.targets[1]] }),
    ).toMatchObject({ details: { field: 'plan.steps.0.input.targets.0.password' } });
    // The whole input as read, the step changed elsewhere: given back as stored.
    expect(
      reviewRevisedPlan(planShape({ steps: [{ ...readT, maxAttempts: 2 }] }), withRows).steps,
    ).toEqual([{ ...withRows.steps[0], maxAttempts: 2 }]);
  });

  it('gives a masked value back only with its whole call sent as read: its Worker, gate and place too (review #493 on #704)', () => {
    const [gateA1, gateA2] = [randomUUID(), randomUUID()];
    const other = { definitionId: randomUUID(), version: 1 };
    const action = (gatekeeperId: string, password: string) => ({
      gatekeeperId,
      operation: 'svc.restart',
      params: { password },
    });
    const check = (gatekeeperId: string, password: string) => ({
      ...action(gatekeeperId, password),
      expect: { path: 'ok', op: 'eq', value: true },
    });
    const calls = planShape({
      steps: [
        step('a', {
          reconcile: [
            { action: action(gateA1, `${FAKE}1`), check: check(gateA1, `${FAKE}1`) },
            { action: action(gateA2, `${FAKE}2`), check: check(gateA2, `${FAKE}2`) },
          ],
        }),
        step('b', { input: { password: `${FAKE}B` } }),
        step('c', {
          acceptance: [
            { kind: 'observe_predicate', key: 'x', check: check(gateA1, `${FAKE}X`) },
            { kind: 'observe_predicate', key: 'y', check: check(gateA2, `${FAKE}Y`) },
          ],
        }),
      ],
    });
    const [readA, readB, readC] = planAsRead(calls).steps as [PlanStep, PlanStep, PlanStep];
    const [first, second] = readA.reconcile as [
      NonNullable<PlanStep['reconcile']>[number],
      NonNullable<PlanStep['reconcile']>[number],
    ];
    const fieldOf = (steps: unknown[]) => {
      try {
        reviewRevisedPlan(planShape({ steps }), calls);
      } catch (err) {
        expect((err as Error).name).toBe('RedactedTextSubmittedError');
        return (err as { details: { field: string } }).details.field;
      }
      throw new Error('expected the revision to be refused');
    };
    // A reconcile declaration taken out: the one left is not given the first one's value.
    expect(fieldOf([{ ...readA, reconcile: [second] }, readB, readC])).toBe(
      'plan.steps.0.reconcile.0.action.params.password',
    );
    // An action pointed at another gate, its params left as read.
    expect(
      fieldOf([
        {
          ...readA,
          reconcile: [{ ...first, action: { ...first.action, gatekeeperId: gateA2 } }, second],
        },
        readB,
        readC,
      ]),
    ).toBe('plan.steps.0.reconcile.0.action.params.password');
    // Another Worker, the input left as read.
    expect(fieldOf([readA, { ...readB, worker: other }, readC])).toBe(
      'plan.steps.1.input.password',
    );
    // A step's acceptance check taken out: the one left is matched by its key, not its place,
    // so y keeps its own value and never x's.
    const [, checkY] = readC.acceptance as [unknown, unknown];
    expect(
      reviewRevisedPlan(
        planShape({ steps: [readA, readB, { ...readC, acceptance: [checkY] }] }),
        calls,
      ).steps[2],
    ).toEqual({ ...calls.steps[2], acceptance: [calls.steps[2]?.acceptance?.[1]] });
    // y's check pointed at x's gate, its params left as read: not y's call any more.
    const [, shownY] = readC.acceptance as [unknown, { check: Record<string, unknown> }];
    expect(
      fieldOf([
        readA,
        readB,
        { ...readC, acceptance: [{ ...shownY, check: { ...shownY.check, gatekeeperId: gateA1 } }] },
      ]),
    ).toBe('plan.steps.2.acceptance.0.check.params.password');
    // Every call as read, only the attempts changed: each is the stored call.
    expect(
      reviewRevisedPlan(
        planShape({
          steps: [readA, readB, readC].map((entry) => ({ ...entry, maxAttempts: 2 })),
        }),
        calls,
      ).steps,
    ).toEqual(calls.steps.map((entry) => ({ ...entry, maxAttempts: 2 })));
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

describe('parsePlan — output schemas and input bindings (S11 GO5d-1)', () => {
  const hosts = {
    type: 'object',
    properties: {
      hosts: { type: 'array', items: { type: 'string' } },
      target: { type: 'object', properties: { zone: { type: 'string' } } },
      meta: { type: 'object' },
    },
    required: ['hosts'],
    additionalProperties: false,
  };
  const scan = step('scan', { outputSchema: hosts });

  it('accepts a binding from a step it depends on that declares its output', () => {
    const plan = parsePlan({
      steps: [
        scan,
        step('apply', {
          dependsOn: ['scan'],
          input: { mode: 'safe', target: { region: 'lab' } },
          bindings: [
            { to: 'host', from: 'scan', path: 'hosts[0]' },
            { to: 'target.zone', from: 'scan', path: 'target.zone' },
            { to: 'all', from: 'scan', path: '@' },
            { to: 'count', from: 'scan', path: 'length(hosts)' },
            { to: 'extra', from: 'scan', path: 'meta.anything.below' },
          ],
        }),
      ],
    });
    expect(plan.steps[1]?.bindings).toHaveLength(5);
  });

  it('refuses a binding from a step not depended on, or one without an output schema', () => {
    expect(
      problemsOf({
        steps: [
          scan,
          step('raw'),
          step('apply', {
            dependsOn: ['raw'],
            bindings: [
              { to: 'host', from: 'scan', path: 'hosts[0]' },
              { to: 'note', from: 'raw', path: 'text' },
            ],
          }),
        ],
      }),
    ).toEqual([
      'step "apply": bindings[0]: takes from step "scan", which this step does not depend on — add it to dependsOn',
      'step "apply": bindings[1]: step "raw" declares no outputSchema — a binding takes only from a declared output',
    ]);
  });

  it('legacy 455: says first that the step a binding takes from is not in the plan, or is the step itself', () => {
    expect(
      problemsOf({
        steps: [
          scan,
          step('apply', {
            dependsOn: ['scan'],
            bindings: [
              { to: 'host', from: 'scna', path: 'hosts[0]' },
              { to: 'again', from: 'apply', path: 'hosts[0]' },
              { to: 'ok', from: 'scan', path: 'hosts[0]' },
            ],
          }),
        ],
      }),
    ).toEqual([
      'step "apply": bindings[0]: takes from step "scna", which is not in the plan',
      'step "apply": bindings[1]: takes from this step itself — a binding takes from a step this one depends on',
    ]);
  });

  it('refuses a path that does not compile, reads nothing, goes through a reserved field, or that the schema rules out', () => {
    const problems = problemsOf({
      steps: [
        scan,
        step('apply', {
          dependsOn: ['scan'],
          bindings: [
            { to: 'a', from: 'scan', path: 'hosts[' },
            { to: 'b', from: 'scan', path: '`1`' },
            { to: 'c', from: 'scan', path: 'hosts.__proto__' },
            { to: 'd', from: 'scan', path: 'hostz[0]' },
            { to: 'e', from: 'scan', path: 'hosts.name' },
            { to: 'f', from: 'scan', path: 'target[0]' },
          ],
        }),
      ],
    });
    expect(problems).toHaveLength(6);
    expect(problems[0]).toMatch(
      /^step "apply": bindings\[0\]: path "hosts\[" is not a JMESPath expression/,
    );
    expect(problems.slice(1)).toEqual([
      'step "apply": bindings[1]: path "`1`" reads nothing from the output',
      'step "apply": bindings[2]: path "hosts.__proto__" goes through __proto__',
      'step "apply": bindings[3]: path "hostz[0]": the output schema does not declare "hostz" in the output of step "scan"',
      'step "apply": bindings[4]: path "hosts.name": hosts is not an object in the output schema of step "scan"',
      'step "apply": bindings[5]: path "target[0]": target is not a list in the output schema of step "scan"',
    ]);
  });

  it('refuses bindings that put their values at the same field or inside each other, or over a written value', () => {
    expect(
      problemsOf({
        steps: [
          scan,
          step('apply', {
            dependsOn: ['scan'],
            input: { host: 'fixed', target: 'lab' },
            bindings: [
              { to: 'node', from: 'scan', path: 'hosts[0]' },
              { to: 'node.name', from: 'scan', path: 'hosts[1]' },
              { to: 'node', from: 'scan', path: 'hosts[2]' },
              { to: 'host', from: 'scan', path: 'hosts[3]' },
              { to: 'target.zone', from: 'scan', path: 'target.zone' },
            ],
          }),
        ],
      }),
    ).toEqual([
      'step "apply": bindings[1]: puts its value at "node.name", where bindings[0] puts its own at "node"',
      'step "apply": bindings[2]: puts its value at "node", where bindings[0] puts its own at "node"',
      'step "apply": bindings[3]: the input already has a value at "host" — take it out of the input, or bind another field',
      'step "apply": bindings[4]: the input already has a value at "target" — take it out of the input, or bind another field',
    ]);
    expect(
      problemsOf({
        steps: [
          scan,
          step('apply', {
            dependsOn: ['scan'],
            input: 'a sentence',
            bindings: [{ to: 'host', from: 'scan', path: 'hosts[0]' }],
          }),
        ],
      }),
    ).toEqual([
      'step "apply": the input must be an object when the step has bindings — a binding fills a field of it',
    ]);
  });

  it('refuses an output schema the shared subset does not accept, at its place', () => {
    expect(problemsOf({ steps: [step('scan', { outputSchema: { type: 'array' } })] })).toEqual([
      "steps.0.outputSchema.type: a step's output is an object: the schema's root must be type 'object'",
    ]);
  });

  it('a revision keeps a stored output schema and bindings sent back as read, and checks a changed one', () => {
    const stored = planShape({
      steps: [
        step('scan', {
          outputSchema: {
            type: 'object',
            properties: { 'zone\u200D': { type: 'string', description: 'the zone\u200D' } },
          },
        }),
        step('apply', {
          dependsOn: ['scan'],
          bindings: [{ to: 'zone', from: 'scan', path: '"zone\u200D"' }],
        }),
      ],
    });
    const read = planAsRead(stored);
    expect(JSON.stringify(read.steps[0]?.outputSchema)).toContain('\\u{200D}');
    expect(reviewRevisedPlan(planShape(read), stored)).toEqual(stored);
    // A changed schema is as sent.
    const changed = {
      ...read,
      steps: [{ ...read.steps[0], outputSchema: { type: 'object' } }, read.steps[1]],
    };
    expect(reviewRevisedPlan(planShape(changed), stored).steps[0]?.outputSchema).toEqual({
      type: 'object',
    });
  });
});

describe('a step’s WorkerSpec (S11 GO8a)', () => {
  /** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
  const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

  it('takes what a step sets differently, and refuses one that sets nothing or a field it does not know', () => {
    expect(
      parsePlan({
        steps: [step('a', { spec: { instructions: 'Only the backups.', tokenBudget: 4000 } })],
      }).steps[0]?.spec,
    ).toEqual({ instructions: 'Only the backups.', tokenBudget: 4000 });
    expect(problemsOf({ steps: [step('a', { spec: {} })] }).join(' ')).toMatch(/sets nothing/);
    // Its fields are the only ones: a prompt of its own would replace the definition's.
    expect(problemsOf({ steps: [step('a', { spec: { systemPrompt: 'x' } })] }).join(' ')).toMatch(
      /systemPrompt/,
    );
    expect(problemsOf({ steps: [step('a', { spec: { instructions: '   ' } })] })).toHaveLength(1);
    expect(problemsOf({ steps: [step('a', { spec: { gates: ['not-a-gate-id'] } })] })).toHaveLength(
      1,
    );
    expect(problemsOf({ steps: [step('a', { spec: { tokenBudget: 0 } })] })).toHaveLength(1);
  });

  it('refuses a suspected credential in its instructions at its place', () => {
    try {
      refusePlanCredentials(
        planShape({ steps: [step('a', { spec: { instructions: `PGPASSWORD=${FAKE}` } })] }),
      );
      throw new Error('expected the plan to be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(TextCarriesCredentialsError);
      expect((err as TextCarriesCredentialsError).details).toMatchObject({
        field: 'plan.steps.0.spec.instructions',
        suspectedSecretValues: 1,
      });
    }
  });

  it('is part of the step: a change to it is another step (invariant 2 — admitted afresh)', () => {
    const before = { steps: [step('a', { spec: { tokenBudget: 4000 } })] };
    const after = { steps: [step('a', { spec: { tokenBudget: 3000 } })] };
    expect(samePlanEntry(before, before, 'a')).toBe(true);
    expect(samePlanEntry(before, after, 'a')).toBe(false);
    expect(samePlanEntry({ steps: [step('a')] }, before, 'a')).toBe(false);
  });

  it('sent back as read keeps what is stored; changed, it is as sent', () => {
    const stored = planShape({
      steps: [step('a', { spec: { instructions: 'family \u{1F468}‍\u{1F469} photos' } })],
    });
    const [readA] = planAsRead(stored).steps as [PlanStep];
    expect(JSON.stringify(readA.spec)).toContain('\\u{200D}');
    expect(reviewRevisedPlan(planShape({ steps: [readA] }), stored)).toEqual(stored);
    const changed = { ...readA, spec: { ...readA.spec, tokenBudget: 10 } };
    expect(reviewRevisedPlan(planShape({ steps: [changed] }), stored).steps[0]?.spec).toEqual(
      changed.spec,
    );
  });
});
