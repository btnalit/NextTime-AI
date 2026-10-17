import { describe, expect, it } from 'vitest';
import {
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
});
