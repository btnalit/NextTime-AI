import type { Predicate } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  PREDICATE_EMPTY_PROBES,
  PREDICATE_REFUSAL_ANSWERS,
  type PredicateLintBudget,
  evaluatePredicate,
  lintPredicate,
  predicateRefusalProbes,
} from './predicate.js';

const outcome = (predicate: Predicate, data: unknown) => evaluatePredicate(predicate, data).outcome;

describe('substrate/epistemic predicate (S11 GO3d)', () => {
  const result = {
    state: 'applied',
    revision: 7,
    startedAt: '2026-10-17T05:00:00Z',
    tags: ['a', 'b'],
    items: [
      { id: 'x', status: 'done' },
      { id: 'y', status: 'open' },
    ],
    note: 'restarted by request 42',
  };

  it('judges each comparison on what its path reads', () => {
    expect(outcome({ path: 'state', op: 'eq', value: 'applied' }, result)).toBe('satisfied');
    expect(outcome({ path: 'state', op: 'ne', value: 'applied' }, result)).toBe('unsatisfied');
    expect(outcome({ path: 'revision', op: 'gte', value: 7 }, result)).toBe('satisfied');
    expect(outcome({ path: 'revision', op: 'gt', value: 7 }, result)).toBe('unsatisfied');
    expect(outcome({ path: 'revision', op: 'lt', value: 8 }, result)).toBe('satisfied');
    expect(outcome({ path: 'revision', op: 'lte', value: 6 }, result)).toBe('unsatisfied');
    expect(outcome({ path: 'startedAt', op: 'gt', value: '2026-10-17T04:59:59Z' }, result)).toBe(
      'satisfied',
    );
    expect(outcome({ path: 'tags', op: 'contains', value: 'b' }, result)).toBe('satisfied');
    expect(outcome({ path: 'note', op: 'contains', value: 'request 42' }, result)).toBe(
      'satisfied',
    );
    expect(outcome({ path: "items[?status=='done'].id", op: 'eq', value: ['x'] }, result)).toBe(
      'satisfied',
    );
    expect(
      outcome({ path: 'items[0]', op: 'eq', value: { status: 'done', id: 'x' } }, result),
    ).toBe('satisfied');
    expect(outcome({ path: 'missing', op: 'exists' }, result)).toBe('unsatisfied');
    expect(outcome({ path: 'missing', op: 'eq', value: null }, result)).toBe('satisfied');
  });

  it('an answerless comparison is undetermined, and not of it stays undetermined', () => {
    const mismatch: Predicate = { path: 'state', op: 'gt', value: 3 };
    expect(evaluatePredicate(mismatch, result)).toEqual({
      outcome: 'undetermined',
      undetermined: ['state: gt needs two numbers or two strings'],
    });
    expect(outcome({ not: mismatch }, result)).toBe('undetermined');
    expect(outcome({ path: 'missing', op: 'gt', value: 3 }, result)).toBe('undetermined');
    expect(outcome({ not: { path: 'missing', op: 'contains', value: 'x' } }, result)).toBe(
      'undetermined',
    );
    // A path that fails on this result (length of nothing) is undetermined too.
    const failing = evaluatePredicate({ path: 'length(missing)', op: 'gt', value: 0 }, result);
    expect(failing.outcome).toBe('undetermined');
    expect(failing.undetermined[0]).toMatch(/^length\(missing\): /);
  });

  it('all, any and not follow three-valued logic', () => {
    const yes: Predicate = { path: 'state', op: 'eq', value: 'applied' };
    const no: Predicate = { path: 'state', op: 'eq', value: 'other' };
    const unknown: Predicate = { path: 'state', op: 'gt', value: 1 };
    expect(outcome({ all: [yes, yes] }, result)).toBe('satisfied');
    expect(outcome({ all: [yes, unknown] }, result)).toBe('undetermined');
    expect(outcome({ all: [unknown, no] }, result)).toBe('unsatisfied');
    expect(outcome({ any: [no, yes] }, result)).toBe('satisfied');
    expect(outcome({ any: [no, unknown] }, result)).toBe('undetermined');
    expect(outcome({ any: [no, no] }, result)).toBe('unsatisfied');
    expect(outcome({ not: no }, result)).toBe('satisfied');
    expect(outcome({ not: { all: [yes, unknown] } }, result)).toBe('undetermined');
  });

  it('never throws on any result', () => {
    const predicate: Predicate = {
      all: [
        { path: 'items[0].id', op: 'eq', value: 'x' },
        { path: 'length(items)', op: 'gte', value: 1 },
      ],
    };
    for (const data of [null, 0, 'text', true, [], [1, 2], {}, { items: 'not a list' }]) {
      expect(() => evaluatePredicate(predicate, data)).not.toThrow();
      expect(outcome(predicate, data)).not.toBe('satisfied');
    }
  });

  describe('the lint', () => {
    it('accepts a predicate that needs the target to show something', () => {
      expect(lintPredicate({ path: 'state', op: 'eq', value: 'applied' })).toEqual([]);
      expect(
        lintPredicate({
          all: [
            { path: "items[?id=='x'] | [0].status", op: 'eq', value: 'done' },
            { path: 'revision', op: 'gte', value: 7 },
          ],
        }),
      ).toEqual([]);
      // A count of what the filter kept — not of whatever `items` holds (review #493).
      expect(
        lintPredicate({ path: "items[?status=='done'] | length(@)", op: 'gt', value: 0 }),
      ).toEqual([]);
    });

    it('refuses a path that does not compile, reads only literals, or goes through the prototype', () => {
      expect(lintPredicate({ path: 'items[', op: 'exists' })[0]).toMatch(
        /^path "items\[" is not a JMESPath expression: /,
      );
      expect(lintPredicate({ path: '`1`', op: 'eq', value: 1 })).toEqual([
        'path "`1`" reads nothing from the observation\'s result',
      ]);
      expect(lintPredicate({ path: '`{"a": 1}`.a', op: 'eq', value: 1 })).toEqual([
        'path "`{"a": 1}`.a" reads nothing from the observation\'s result',
      ]);
      expect(lintPredicate({ path: "'text'", op: 'exists' })).toHaveLength(1);
      expect(lintPredicate({ path: 'a.__proto__', op: 'exists' })).toEqual([
        'path "a.__proto__" goes through __proto__',
      ]);
      expect(lintPredicate({ path: 'constructor.name', op: 'eq', value: 'Object' })).toEqual([
        'path "constructor.name" goes through constructor',
      ]);
    });

    it('refuses a path that reads the result as a whole instead of a named field (review #493)', () => {
      // The review's table: each holds on a refusal like {error, code} as well as on the effect.
      const shapeReads: Predicate[] = [
        { path: 'length(keys(@))', op: 'gt', value: 1 },
        {
          all: [
            { path: 'type(@)', op: 'eq', value: 'object' },
            { path: 'length(keys(@))', op: 'gte', value: 2 },
          ],
        },
        { path: 'foo || length(keys(@)) > `1`', op: 'eq', value: true },
        { path: 'length(values(@))', op: 'gte', value: 2 },
        { path: 'length(*)', op: 'gt', value: 1 },
        { path: 'length(to_string(@))', op: 'gt', value: 40 },
        { path: 'keys(@)', op: 'contains', value: 'status' },
        // And the rest of the class: the root itself, a position, a projection of it.
        { path: '@', op: 'exists' },
        { path: 'type(@)', op: 'ne', value: 'number' },
        { path: 'not_null(@)', op: 'exists' },
        { path: '[0]', op: 'exists' },
        { path: '[*]', op: 'contains', value: 'x' },
        { path: '*', op: 'contains', value: 'applied' },
        { path: 'sort(keys(@))[0]', op: 'eq', value: 'code' },
        { path: '[@, state]', op: 'exists' },
        { path: '{a: @}.a', op: 'exists' },
      ];
      for (const predicate of shapeReads) {
        const problems = lintPredicate(predicate);
        expect(problems.length, JSON.stringify(predicate)).toBeGreaterThan(0);
        for (const problem of problems) {
          expect(problem, JSON.stringify(predicate)).toMatch(
            /reads the result as a whole \(@, \*, keys, values or a position\) instead of a named field|every branch of \|\| and && must read a named field/,
          );
        }
      }
      expect(lintPredicate({ path: 'state || `"applied"`', op: 'eq', value: 'applied' })).toEqual([
        'path "state || `"applied"`": every branch of || and && must read a named field',
      ]);
      expect(
        lintPredicate({ path: 'foo || length(keys(@)) > `1`', op: 'eq', value: true }),
      ).toEqual([
        'path "foo || length(keys(@)) > `1`" reads the result as a whole (@, *, keys, values or a position) instead of a named field — it would hold on almost any answer',
      ]);
    });

    it('accepts @, *, keys and positions below a named field — right of a field, a projection, a filter or a pipe', () => {
      const anchored: Predicate[] = [
        { path: "items[?name=='svc'] | length(@)", op: 'gt', value: 0 },
        { path: '@.state', op: 'eq', value: 'applied' },
        { path: '[0].status', op: 'eq', value: 'done' },
        { path: '[*].status', op: 'contains', value: 'done' },
        { path: '*.state', op: 'contains', value: 'applied' },
        { path: 'services.* | [0].state', op: 'eq', value: 'running' },
        { path: 'items[0]', op: 'eq', value: 'web' },
        { path: 'state || status', op: 'eq', value: 'applied' },
        { path: "items[?state=='up'] | length(@) > `2`", op: 'eq', value: true },
      ];
      for (const predicate of anchored) {
        expect(lintPredicate(predicate), JSON.stringify(predicate)).toEqual([]);
      }
    });

    it('refuses a predicate a result that says nothing about the target satisfies', () => {
      const tautologies: Predicate[] = [
        { not: { path: 'error', op: 'exists' } },
        { path: 'to_string(items)', op: 'exists' },
        { path: 'type(state)', op: 'exists' },
        { path: 'status', op: 'ne', value: 'failed' },
        { path: 'missing', op: 'eq', value: null },
        {
          any: [
            { path: 'state', op: 'eq', value: 'applied' },
            { not: { path: 'state', op: 'exists' } },
          ],
        },
      ];
      for (const predicate of tautologies) {
        const problems = lintPredicate(predicate);
        expect(problems, JSON.stringify(predicate)).toHaveLength(1);
        expect(problems[0]).toMatch(
          /^the predicate holds on .* without the observation showing the target$/,
        );
      }
      // Every probe says nothing: none of them satisfies a predicate the lint accepts.
      for (const probe of [
        ...PREDICATE_EMPTY_PROBES,
        ...predicateRefusalProbes(new Set(['state'])),
      ]) {
        expect(outcome({ path: 'state', op: 'eq', value: 'applied' }, probe)).not.toBe('satisfied');
      }
    });

    it('builds its refusal probes from fields the predicate does not read: several keys, long strings, a list', () => {
      const read = new Set(['error', 'code', 'state']);
      const probes = predicateRefusalProbes(read);
      const objects = probes.filter(
        (probe): probe is Record<string, unknown> =>
          typeof probe === 'object' && probe !== null && !Array.isArray(probe),
      );
      expect(objects.length).toBeGreaterThanOrEqual(2);
      for (const probe of objects) {
        expect(Object.keys(probe).length).toBeGreaterThanOrEqual(2);
        expect(Object.keys(probe).some((key) => read.has(key))).toBe(false);
      }
      expect(JSON.stringify(probes)).toMatch(/"[^"]{80,}"/);
      expect(probes.some((probe) => Array.isArray(probe) && probe.length >= 2)).toBe(true);
      // A predicate that names every refusal key still gets them, on made-up keys (review #493).
      const all = new Set([
        'error',
        'code',
        'reason',
        'message',
        'detail',
        'found',
        'ok',
        'result',
        'data',
        'info',
        'meta',
        'value',
        '__nexttime_refusal_0__',
      ]);
      const made = predicateRefusalProbes(all);
      expect(made).toHaveLength(4);
      for (const probe of made.filter((p) => !Array.isArray(p))) {
        expect(Object.keys(probe as object).length).toBeGreaterThanOrEqual(2);
        expect(Object.keys(probe as object).some((key) => all.has(key))).toBe(false);
      }
    });

    it('refuses a predicate that holds whatever the field it reads is, and accepts one that tests a value', () => {
      const anyValue: Predicate[] = [
        { path: 'length(items)', op: 'gte', value: 0 },
        { path: 'length(items)', op: 'ne', value: -1 },
        { path: "ends_with(name, '')", op: 'eq', value: true },
      ];
      for (const predicate of anyValue) {
        const problems = lintPredicate(predicate);
        expect(problems, JSON.stringify(predicate)).toHaveLength(1);
        expect(problems[0]).toMatch(
          /^the predicate holds whatever ".+" is \(empty, false, zero or unrelated\) — it does not test its value$/,
        );
      }
      // Each holds on only some of the probe values: whether that proves the effect is for the
      // plan author to weigh, and the confirmation card shows it.
      const tests: Predicate[] = [
        { path: 'status', op: 'exists' },
        { path: 'enabled', op: 'eq', value: false },
        { path: 'revision', op: 'gte', value: 7 },
        { path: 'count', op: 'eq', value: 0 },
      ];
      for (const predicate of tests) {
        expect(lintPredicate(predicate), JSON.stringify(predicate)).toEqual([]);
      }
    });

    it('refuses a shape test at a place below the root — the review table, a wrapper or deeper (review #493)', () => {
      // The delta review's table: each held on {result: {found: false}, data: {found: false}}.
      const negative = {
        result: { found: false, reason: 'not there' },
        data: { found: false, reason: 'x' },
      };
      const table: Predicate[] = [
        { path: 'length(result)', op: 'gt', value: 0 },
        { path: 'length(data)', op: 'gte', value: 1 },
        { path: 'length(keys(data))', op: 'gt', value: 1 },
        { path: 'merge(data, `{}`)', op: 'ne', value: {} },
      ];
      // And the rest of the class, at any depth and through any construct that reaches a place.
      const shapes: Predicate[] = [
        ...table,
        { path: 'type(result)', op: 'eq', value: 'object' },
        { path: 'length(to_string(result))', op: 'gt', value: 5 },
        { path: 'length(values(data))', op: 'gt', value: 0 },
        { path: 'length(data.*)', op: 'gt', value: 0 },
        { path: 'length(data[])', op: 'gt', value: 0 },
        { path: 'result | length(@)', op: 'gt', value: 0 },
        { path: 'result | keys(@) | length(@)', op: 'gt', value: 0 },
        { path: 'result.state || length(result)', op: 'gt', value: 0 },
        { path: 'length(data.result.items)', op: 'gt', value: 0 },
        { path: 'length(sort_by(data.items, &name))', op: 'gt', value: 0 },
        { path: 'length(a[*].b)', op: 'gt', value: 0 },
        { path: 'length(items[*] | [0])', op: 'gt', value: 0 },
        { path: 'length(items)', op: 'gte', value: 1 },
        { path: 'length(items)', op: 'eq', value: 1 },
        {
          any: [
            { path: 'state', op: 'eq', value: 'running' },
            { path: 'length(result)', op: 'gt', value: 0 },
          ],
        },
      ];
      for (const predicate of shapes) {
        const problems = lintPredicate(predicate);
        expect(problems, JSON.stringify(predicate)).toHaveLength(1);
        expect(problems[0], JSON.stringify(predicate)).toMatch(
          /^the predicate holds (on .* — it would pass without the observation showing the target|whatever ".+" is \(empty, false, zero or unrelated\) — it does not test its value)$/,
        );
      }
      for (const predicate of table) {
        expect(outcome(predicate, negative), JSON.stringify(predicate)).toBe('satisfied');
      }
      expect(lintPredicate({ path: 'length(result)', op: 'gt', value: 0 })).toEqual([
        'the predicate holds on {"result":{"error":false}} — it would pass without the observation showing the target',
      ]);
      // A tautology below the root, too.
      expect(lintPredicate({ path: 'length(data.items)', op: 'gte', value: 0 })).toHaveLength(1);
    });

    it('refuses a predicate a refusal answer satisfies — exists error, and nine refusal keys at once (review #493)', () => {
      const nine = [
        'error',
        'code',
        'reason',
        'message',
        'detail',
        'found',
        'ok',
        'result',
        'data',
      ];
      const refused: Predicate[] = [
        { any: nine.map((path) => ({ path, op: 'exists' as const })) },
        { path: 'error', op: 'exists' },
        {
          any: [
            { path: 'error', op: 'exists' },
            { path: 'status', op: 'exists' },
          ],
        },
        { path: 'not_null(status, error)', op: 'exists' },
        { path: 'type(error)', op: 'eq', value: 'string' },
        // Below a wrapper too, once something else makes it more than `exists` leaves.
        {
          any: [
            { path: 'result.state', op: 'eq', value: 'running' },
            { path: 'result.error', op: 'exists' },
          ],
        },
      ];
      for (const predicate of refused) {
        const problems = lintPredicate(predicate);
        expect(problems, JSON.stringify(predicate)).toHaveLength(1);
        expect(problems[0], JSON.stringify(predicate)).toMatch(
          /^the predicate holds on .*(error|found|ok).* — it would pass without the observation showing the target$/,
        );
      }
      for (const answer of PREDICATE_REFUSAL_ANSWERS) {
        expect(outcome({ path: 'state', op: 'eq', value: 'applied' }, answer)).toBe('unsatisfied');
      }
    });

    it('exempts only exists on a plain field path from the place probes (review #493)', () => {
      // Each measures a place or is a count: probed like any other leaf, and refused.
      const measured: Predicate[] = [
        { path: 'keys(data)[0]', op: 'exists' },
        { path: 'values(result)[0]', op: 'exists' },
        { path: 'to_array(result)[0]', op: 'exists' },
        { path: 'not_null(result.id, result.error)', op: 'exists' },
        { path: 'data.items[0]', op: 'exists' },
        { path: 'data.items[-1]', op: 'exists' },
        { path: 'items[*]', op: 'exists' },
        {
          any: [
            { path: 'status', op: 'exists' },
            { path: 'items[0]', op: 'exists' },
          ],
        },
      ];
      for (const predicate of measured) {
        expect(lintPredicate(predicate), JSON.stringify(predicate)).toHaveLength(1);
      }
      const plain: Predicate[] = [
        { path: 'status', op: 'exists' },
        { path: 'data.id', op: 'exists' },
        {
          all: [
            { path: 'id', op: 'exists' },
            { path: 'spec.name', op: 'exists' },
          ],
        },
      ];
      for (const predicate of plain) {
        expect(lintPredicate(predicate), JSON.stringify(predicate)).toEqual([]);
      }
    });

    it('refuses an absence and a text order on its own, and lets a test of a value carry them', () => {
      const refused: Predicate[] = [
        { path: 'length(items)', op: 'eq', value: 0 },
        { path: "items[?id=='x'] | length(@)", op: 'eq', value: 0 },
        { path: 'result.found', op: 'eq', value: false },
        { not: { path: "items[?id=='x']", op: 'contains', value: { id: 'x' } } },
        { path: 'version', op: 'gte', value: '1.2.0' },
        { path: 'name', op: 'lte', value: 'zzz' },
        { path: 'message', op: 'contains', value: ' ' },
      ];
      for (const predicate of refused) {
        expect(lintPredicate(predicate), JSON.stringify(predicate)).toHaveLength(1);
      }
      const accepted: Predicate[] = [
        { path: 'status', op: 'eq', value: 'running' },
        { path: 'result.state', op: 'eq', value: 'running' },
        { path: "items[?name=='svc'] | length(@)", op: 'eq', value: 1 },
        { path: "items[?name=='svc'] | length(@)", op: 'gt', value: 0 },
        { path: "length(replicas[?state=='ready'])", op: 'gte', value: 3 },
        { path: 'sort_by(items, &name)[0].name', op: 'eq', value: 'svc' },
        { path: 'tags', op: 'contains', value: 'prod' },
        { path: 'message', op: 'contains', value: 'restarted' },
        { path: 'data.id', op: 'exists' },
        {
          all: [
            { path: 'id', op: 'exists' },
            { path: 'name', op: 'exists' },
          ],
        },
        {
          all: [
            { path: 'state', op: 'eq', value: 'running' },
            { path: 'version', op: 'gte', value: '1.2.0' },
          ],
        },
        {
          all: [
            { path: 'state', op: 'eq', value: 'up' },
            { path: 'length(items)', op: 'gt', value: 0 },
          ],
        },
      ];
      for (const predicate of accepted) {
        expect(lintPredicate(predicate), JSON.stringify(predicate)).toEqual([]);
      }
    });

    it('bounds its own work — per predicate and, through a shared budget, per plan', () => {
      const tooDeep = { path: `a${'.b'.repeat(70)}`, op: 'eq', value: 1 } satisfies Predicate;
      expect(lintPredicate(tooDeep)).toEqual([
        'the predicate reads too many places in the result for the lint to check — test fewer fields',
      ]);
      const wide: Predicate = {
        all: Array.from({ length: 8 }, (_, i) => ({
          path: `result.field${i}`,
          op: 'eq' as const,
          value: i,
        })),
      };
      expect(lintPredicate(wide)).toEqual([]);
      const budget: PredicateLintBudget = { remaining: 40_000 };
      expect(lintPredicate(wide, budget)).toEqual([]);
      const left = budget.remaining;
      expect(left).toBeLessThan(40_000);
      expect(left).toBeGreaterThan(0);
      // The next one no longer fits: refused, and nothing more is spent.
      expect(lintPredicate(wide, budget)).toEqual([
        "the plan's predicates together read too many places for the lint to check — test fewer fields",
      ]);
      expect(budget.remaining).toBe(left);
    });
  });
});
