import { describe, expect, it } from 'vitest';
import { goalPrecedentPolarity } from './goal-precedents.js';

describe('goalPrecedentPolarity (S11 GO17)', () => {
  it('positive when achieved on the platform’s own checks', () => {
    expect(goalPrecedentPolarity('achieved', 'verified_by_check', 0, true)).toBe('positive');
  });

  it('negative when not achieved, whatever it rests on', () => {
    for (const basis of ['verified_by_check', 'requester', 'reviewer_assessed'] as const) {
      expect(goalPrecedentPolarity('not_achieved', basis, 0, true)).toBe('negative');
      expect(goalPrecedentPolarity('not_achieved', basis, 0, false)).toBe('negative');
    }
  });

  it('negative when achieved over checks a person overrode', () => {
    expect(goalPrecedentPolarity('achieved', 'requester', 1, false)).toBe('negative');
    // Never a verified_by_check one in practice (an override rests on the requester's word); the
    // overridden checks still decide.
    expect(goalPrecedentPolarity('achieved', 'verified_by_check', 2, true)).toBe('negative');
  });

  it('unverified when achieved on someone’s word or a review alone', () => {
    expect(goalPrecedentPolarity('achieved', 'requester', 0, false)).toBe('unverified');
    expect(goalPrecedentPolarity('achieved', 'reviewer_assessed', 0, false)).toBe('unverified');
  });

  // S11 GO18 (independent review N2): a review or a confirmation on top of the platform's passed
  // checks moves the basis off `verified_by_check` (F7), never the precedent below positive.
  it('positive when the last round passed whole with a platform check, whatever was added on top', () => {
    expect(goalPrecedentPolarity('achieved', 'requester', 0, true)).toBe('positive');
    expect(goalPrecedentPolarity('achieved', 'reviewer_assessed', 0, true)).toBe('positive');
  });
});
