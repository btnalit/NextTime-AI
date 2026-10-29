import { describe, expect, it } from 'vitest';
import { AcceptanceCheckSchema, StepAcceptanceCheckSchema } from './goal-plan.js';
import {
  FactCheckSchema,
  ObservationAbsenceCheckSchema,
  ObservationCheckSchema,
  PREDICATE_MAX_CHILDREN,
  PREDICATE_MAX_LEAVES,
  PREDICATE_VALUE_MAX_BYTES,
  PredicateSchema,
  isPredicateJsonValue,
  predicateLeaves,
} from './predicate.js';

describe('predicate (S11 GO3d)', () => {
  it('takes leaves and all / any / not, strictly', () => {
    const predicate = {
      all: [
        { path: 'state', op: 'eq', value: 'applied' },
        {
          any: [
            { path: 'revision', op: 'gte', value: 7 },
            { not: { path: 'error', op: 'exists' } },
          ],
        },
      ],
    };
    expect(PredicateSchema.parse(predicate)).toEqual(predicate);
    expect(predicateLeaves(PredicateSchema.parse(predicate)).map((leaf) => leaf.path)).toEqual([
      'state',
      'revision',
      'error',
    ]);
    // An unknown field, a missing value, a value on `exists`, an unknown op, an empty `all`.
    for (const bad of [
      { path: 'a', op: 'eq', value: 1, note: 'x' },
      { path: 'a', op: 'eq' },
      { path: 'a', op: 'exists', value: 1 },
      { path: 'a', op: 'matches', value: '.*' },
      { all: [] },
      { path: '', op: 'exists' },
      { all: [{ path: 'a', op: 'exists' }], any: [{ path: 'a', op: 'exists' }] },
    ]) {
      expect(PredicateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('orders only numbers or strings, and bounds values, nesting, leaves and children', () => {
    expect(PredicateSchema.safeParse({ path: 'a', op: 'gt', value: [1] }).success).toBe(false);
    expect(PredicateSchema.safeParse({ path: 'a', op: 'lte', value: '2026-10-17' }).success).toBe(
      true,
    );
    expect(
      PredicateSchema.safeParse({
        path: 'a',
        op: 'eq',
        value: 'x'.repeat(PREDICATE_VALUE_MAX_BYTES),
      }).success,
    ).toBe(false);
    const leaf = { path: 'a', op: 'exists' };
    const deep = { not: { not: { not: { not: { not: leaf } } } } };
    expect(PredicateSchema.safeParse(deep).success).toBe(false);
    expect(PredicateSchema.safeParse(deep.not).success).toBe(true);
    expect(
      PredicateSchema.safeParse({ all: Array(PREDICATE_MAX_CHILDREN + 1).fill(leaf) }).success,
    ).toBe(false);
    const wide = { all: Array(PREDICATE_MAX_CHILDREN).fill({ any: [leaf, leaf, leaf] }) };
    expect(PREDICATE_MAX_CHILDREN * 3).toBeGreaterThan(PREDICATE_MAX_LEAVES);
    expect(PredicateSchema.safeParse(wide).success).toBe(false);
  });

  it('a value is plain JSON', () => {
    expect(isPredicateJsonValue({ a: [1, 'b', null, true, { c: 2 }] })).toBe(true);
    expect(isPredicateJsonValue(Number.NaN)).toBe(false);
    expect(isPredicateJsonValue(new Date())).toBe(false);
    expect(isPredicateJsonValue({ a: undefined })).toBe(false);
  });

  it('an observation check names an observe-class call and its predicate', () => {
    const check = {
      gatekeeperId: '00000000-0000-4000-8000-000000000001',
      operation: 'inventory.read',
      params: { sku: 'A-1' },
      expect: { path: 'qty', op: 'gte', value: 5 },
    };
    expect(ObservationCheckSchema.parse(check)).toEqual(check);
    expect(ObservationCheckSchema.safeParse({ ...check, gatekeeperId: 'gate-1' }).success).toBe(
      false,
    );
    expect(ObservationCheckSchema.safeParse({ ...check, mode: 'execute' }).success).toBe(false);
  });

  it('an absence check names an observe-class call and no predicate; an observe_absent check carries one (S11 「门确认不存在」 B)', () => {
    const check = {
      gatekeeperId: '00000000-0000-4000-8000-000000000001',
      operation: 'record.get',
      params: { id: 'r-1' },
    };
    expect(ObservationAbsenceCheckSchema.parse(check)).toEqual(check);
    // Nothing in a result can say "not there": a predicate has no place on it.
    expect(
      ObservationAbsenceCheckSchema.safeParse({ ...check, expect: { path: 'id', op: 'exists' } })
        .success,
    ).toBe(false);
    const absent = { kind: 'observe_absent', key: 'gone', check };
    expect(AcceptanceCheckSchema.parse(absent)).toEqual(absent);
    expect(StepAcceptanceCheckSchema.parse(absent)).toEqual(absent);
    // An observe_predicate still needs its predicate, and an observe_absent takes none.
    expect(AcceptanceCheckSchema.safeParse({ ...absent, kind: 'observe_predicate' }).success).toBe(
      false,
    );
    expect(
      AcceptanceCheckSchema.safeParse({
        ...absent,
        check: { ...check, expect: { path: 'id', op: 'exists' } },
      }).success,
    ).toBe(false);
  });

  it('a fact check names a Link by its type and its two ends — by id, or by ObjectType and identity — and an optional predicate, strictly (S11 GO4c)', () => {
    const fact = {
      linkType: 'runs_on',
      source: { objectId: '00000000-0000-4000-8000-000000000001' },
      target: { objectType: 'Host', identity: { name: 'web-1', zone: 2 } },
    };
    expect(FactCheckSchema.parse(fact)).toEqual(fact);
    const expect_ = { path: 'port', op: 'eq', value: 443 };
    expect(FactCheckSchema.parse({ ...fact, expect: expect_ })).toEqual({
      ...fact,
      expect: expect_,
    });
    for (const refused of [
      { ...fact, linkType: '' },
      { ...fact, source: { objectId: 'web' } },
      { ...fact, source: { ...fact.source, objectType: 'Service', identity: { name: 'web' } } },
      { ...fact, target: { objectType: 'Host' } },
      { ...fact, target: { objectType: 'Host', identity: {} } },
      { ...fact, target: { objectType: '', identity: { name: 'web-1' } } },
      { ...fact, expect: { path: 'port', op: 'between', value: 1 } },
      { ...fact, mode: 'latest' },
      { linkType: fact.linkType, source: fact.source },
    ]) {
      expect(FactCheckSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
  });
});
