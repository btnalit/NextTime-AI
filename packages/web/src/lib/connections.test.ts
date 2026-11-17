import { describe, expect, it } from 'vitest';
import { draftsLeftForAPerson, manifestPublishPlan } from './connections.js';

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

describe('manifestPublishPlan (legacy 801)', () => {
  const row = (name: string, extra: Record<string, unknown> = {}) => ({
    gatekeeperId: 'gk-1',
    name,
    status: 'draft',
    origin: 'import',
    ...extra,
  });

  it('holds back a draft carrying suspected credentials, in the kernel’s order', () => {
    const plan = manifestPublishPlan(
      [
        row('plain'),
        row('login', { suspectedSecretValues: 2 }),
        row('owned', { suspectedSecretValues: 1, gateOwnedParams: [{}] }),
        row('lookup', { suspectedSecretValues: 1, absentAnswers: { statuses: [404] } }),
        row('absent', { absentAnswers: { statuses: [404] } }),
        row('proposed', { origin: 'agent', suspectedSecretValues: 1 }),
        row('other-gate', { gatekeeperId: 'gk-2' }),
      ],
      'gk-1',
    );
    expect(plan).toEqual({
      publishable: ['plain'],
      proposals: ['proposed'],
      gateOwned: ['owned'],
      credentials: ['login', 'lookup'],
      absentAnswers: ['absent'],
    });
  });

  it('reads a row without the count as carrying none', () => {
    expect(manifestPublishPlan([row('plain')], 'gk-1').credentials).toEqual([]);
  });
});
