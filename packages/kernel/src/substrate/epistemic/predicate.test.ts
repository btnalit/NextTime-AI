import type { Predicate } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { PREDICATE_EMPTY_PROBES, evaluatePredicate, lintPredicate } from './predicate.js';

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
      expect(lintPredicate({ path: 'length(items)', op: 'gt', value: 0 })).toEqual([]);
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

    it('refuses a predicate a result that says nothing about the target satisfies', () => {
      const tautologies: Predicate[] = [
        { path: '@', op: 'exists' },
        { not: { path: 'error', op: 'exists' } },
        { path: 'status', op: 'ne', value: 'failed' },
        { path: 'missing', op: 'eq', value: null },
        { path: 'length(keys(@))', op: 'gte', value: 0 },
        { path: 'type(@)', op: 'ne', value: 'number' },
        {
          any: [
            { path: 'state', op: 'eq', value: 'applied' },
            { not: { path: 'state', op: 'exists' } },
          ],
        },
        { path: 'not_null(@)', op: 'exists' },
      ];
      for (const predicate of tautologies) {
        const problems = lintPredicate(predicate);
        expect(problems, JSON.stringify(predicate)).toHaveLength(1);
        expect(problems[0]).toMatch(
          /^the predicate holds on .* without the observation showing the target$/,
        );
      }
      // Every probe says nothing: none of them satisfies a predicate the lint accepts.
      for (const probe of PREDICATE_EMPTY_PROBES) {
        expect(outcome({ path: 'state', op: 'eq', value: 'applied' }, probe)).not.toBe('satisfied');
      }
    });
  });
});
