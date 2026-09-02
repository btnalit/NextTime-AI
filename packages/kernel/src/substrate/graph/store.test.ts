import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAVERSE_DEPTH,
  EpistemicStatusOverrideError,
  MAX_TRAVERSE_DEPTH,
  MIN_TRAVERSE_DEPTH,
  TraverseDepthError,
  assertNoCallerSuppliedEpistemicStatus,
  deriveEpistemicStatus,
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
