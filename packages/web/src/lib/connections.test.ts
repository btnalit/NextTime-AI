import { describe, expect, it } from 'vitest';
import { draftsLeftForAPerson } from './connections.js';

/**
 * lib/connections.test.ts (legacy 800): the toast after enabling a gate says 「已发布 N 个」 and
 * how many were not published — every draft the bulk publish left for a person counts, the ones
 * held for suspected credentials included, or some stay drafts in silence.
 */
describe('draftsLeftForAPerson', () => {
  it('counts the drafts held for a gate-owned param, suspected credentials and answers that mean “not there”', () => {
    expect(
      draftsLeftForAPerson({
        gateOwnedParamDrafts: [{}],
        credentialDrafts: [{}, {}],
        absentAnswerDrafts: [{}],
      }),
    ).toBe(4);
    expect(draftsLeftForAPerson({ credentialDrafts: [{}] })).toBe(1);
  });

  it('reads a field an older kernel leaves out as none', () => {
    expect(draftsLeftForAPerson({})).toBe(0);
  });
});
