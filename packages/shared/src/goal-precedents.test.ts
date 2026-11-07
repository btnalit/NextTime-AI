import { describe, expect, it } from 'vitest';
import { goalPrecedentPolarity } from './goal-precedents.js';

describe('goalPrecedentPolarity (S11 GO17)', () => {
  it('positive only when achieved on the platform’s own checks', () => {
    expect(goalPrecedentPolarity('achieved', 'verified_by_check', 0)).toBe('positive');
  });

  it('negative when not achieved, whatever it rests on', () => {
    for (const basis of ['verified_by_check', 'requester', 'reviewer_assessed'] as const) {
      expect(goalPrecedentPolarity('not_achieved', basis, 0)).toBe('negative');
    }
  });

  it('negative when achieved over checks a person overrode', () => {
    expect(goalPrecedentPolarity('achieved', 'requester', 1)).toBe('negative');
    // Never a verified_by_check one in practice (an override rests on the requester's word); the
    // overridden checks still decide.
    expect(goalPrecedentPolarity('achieved', 'verified_by_check', 2)).toBe('negative');
  });

  it('unverified when achieved on someone’s word alone', () => {
    expect(goalPrecedentPolarity('achieved', 'requester', 0)).toBe('unverified');
    expect(goalPrecedentPolarity('achieved', 'reviewer_assessed', 0)).toBe('unverified');
  });
});
