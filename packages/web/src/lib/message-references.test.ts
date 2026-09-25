import { describe, expect, it } from 'vitest';
import { extractIdCandidates } from './message-references.js';

describe('extractIdCandidates', () => {
  it('returns [] for prose with no id-shaped token', () => {
    expect(extractIdCandidates('入口 agent 观察了系统并给出了建议。')).toEqual([]);
    expect(extractIdCandidates('')).toEqual([]);
  });

  it('extracts a uuid-shaped token, lower-cased', () => {
    expect(
      extractIdCandidates('该结论依据 Fact 12345678-ABCD-4321-8888-000000000000 得出。'),
    ).toEqual(['12345678-abcd-4321-8888-000000000000']);
  });

  it('dedupes repeated ids and preserves first-seen order', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    expect(extractIdCandidates(`${a} ... ${b} ... ${a}`)).toEqual([a, b]);
  });

  it('caps at 8 candidates', () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
    );
    expect(extractIdCandidates(ids.join(' '))).toHaveLength(8);
  });
});
