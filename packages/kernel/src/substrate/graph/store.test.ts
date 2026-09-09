import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAVERSE_DEPTH,
  EpistemicStatusOverrideError,
  MAX_TRAVERSE_DEPTH,
  MIN_TRAVERSE_DEPTH,
  TraverseDepthError,
  assertNoCallerSuppliedEpistemicStatus,
  deriveEpistemicStatus,
  factContentEquals,
  factLifecycleState,
  normalizeTraverseDepth,
} from './store.js';

/**
 * Unit tests (no database) for substrate/graph/store.ts's pure helpers —
 * docs/development-tasks.md S1.2: "unit ... for ... status-by-kind rule".
 */

describe('deriveEpistemicStatus — epistemic_status by caller PrincipalKind (§5.6)', () => {
  it('human → asserted', () => {
    expect(deriveEpistemicStatus('human')).toBe('asserted');
  });

  it('agent → inferred', () => {
    expect(deriveEpistemicStatus('agent')).toBe('inferred');
  });

  it('service → observed', () => {
    expect(deriveEpistemicStatus('service')).toBe('observed');
  });
});

describe('assertNoCallerSuppliedEpistemicStatus', () => {
  it('does not throw for input with no epistemic status field', () => {
    expect(() => assertNoCallerSuppliedEpistemicStatus({ linkType: 'test.rel' })).not.toThrow();
  });

  it('throws EpistemicStatusOverrideError for a camelCase epistemicStatus field', () => {
    expect(() =>
      assertNoCallerSuppliedEpistemicStatus({ linkType: 'test.rel', epistemicStatus: 'verified' }),
    ).toThrow(EpistemicStatusOverrideError);
  });

  it('throws EpistemicStatusOverrideError for a snake_case epistemic_status field', () => {
    expect(() =>
      assertNoCallerSuppliedEpistemicStatus({ linkType: 'test.rel', epistemic_status: 'verified' }),
    ).toThrow(EpistemicStatusOverrideError);
  });
});

describe('factLifecycleState', () => {
  it('is "recorded" when neither timestamp is set', () => {
    expect(factLifecycleState({ supersededAt: null, invalidatedAt: null })).toBe('recorded');
  });

  it('is "superseded" when supersededAt is set', () => {
    expect(factLifecycleState({ supersededAt: new Date(), invalidatedAt: null })).toBe(
      'superseded',
    );
  });

  it('is "invalidated" when invalidatedAt is set, even if supersededAt is also set', () => {
    expect(factLifecycleState({ supersededAt: new Date(), invalidatedAt: new Date() })).toBe(
      'invalidated',
    );
  });
});

describe('normalizeTraverseDepth', () => {
  it(`defaults to ${DEFAULT_TRAVERSE_DEPTH} when undefined`, () => {
    expect(normalizeTraverseDepth(undefined)).toBe(DEFAULT_TRAVERSE_DEPTH);
  });

  it.each([MIN_TRAVERSE_DEPTH, 2, MAX_TRAVERSE_DEPTH])('accepts depth %i (in range)', (depth) => {
    expect(normalizeTraverseDepth(depth)).toBe(depth);
  });

  it('throws TraverseDepthError for depth 0', () => {
    expect(() => normalizeTraverseDepth(0)).toThrow(TraverseDepthError);
  });

  it(`throws TraverseDepthError for depth ${MAX_TRAVERSE_DEPTH + 1} (over the cap)`, () => {
    expect(() => normalizeTraverseDepth(MAX_TRAVERSE_DEPTH + 1)).toThrow(TraverseDepthError);
  });

  it('throws TraverseDepthError for a non-integer depth', () => {
    expect(() => normalizeTraverseDepth(1.5)).toThrow(TraverseDepthError);
  });
});

describe('factContentEquals — S3.2 followup idempotent-re-assertion equality', () => {
  const base = {
    linkType: 'test.runs_on',
    sourceObjectId: 'src-1',
    targetObjectId: 'tgt-1',
    properties: { port: 80, tags: ['a', 'b'] },
    validUntil: null,
  } as const;

  it('is true for identical properties in identical key order', () => {
    expect(factContentEquals(base, { ...base })).toBe(true);
  });

  it('is true when properties keys are reordered (order is never meaningful content)', () => {
    const reordered = { tags: ['a', 'b'], port: 80 };
    expect(factContentEquals(base, { ...base, properties: reordered })).toBe(true);
  });

  it('is true for nested objects with reordered keys too (deep key sort)', () => {
    const prior = { ...base, properties: { outer: { a: 1, b: 2 } } };
    const input = { ...base, properties: { outer: { b: 2, a: 1 } } };
    expect(factContentEquals(prior, input)).toBe(true);
  });

  it('treats a missing `properties` on the input as `{}`', () => {
    expect(
      factContentEquals(
        { ...base, properties: {} },
        {
          linkType: base.linkType,
          sourceObjectId: base.sourceObjectId,
          targetObjectId: base.targetObjectId,
          validUntil: null,
        },
      ),
    ).toBe(true);
  });

  it('is false when a property value differs', () => {
    expect(
      factContentEquals(base, { ...base, properties: { ...base.properties, port: 8080 } }),
    ).toBe(false);
  });

  it('is false when linkType differs', () => {
    expect(factContentEquals(base, { ...base, linkType: 'test.other' })).toBe(false);
  });

  it('is false when sourceObjectId or targetObjectId differs', () => {
    expect(factContentEquals(base, { ...base, sourceObjectId: 'src-2' })).toBe(false);
    expect(factContentEquals(base, { ...base, targetObjectId: 'tgt-2' })).toBe(false);
  });

  it('is false when the prior Fact has a non-null validUntil, even with identical properties', () => {
    expect(factContentEquals({ ...base, validUntil: new Date() }, { ...base })).toBe(false);
  });

  it('is false when the new input carries a non-null validUntil, even with identical properties', () => {
    expect(factContentEquals(base, { ...base, validUntil: new Date() })).toBe(false);
  });
});
