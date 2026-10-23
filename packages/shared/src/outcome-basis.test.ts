import { describe, expect, it } from 'vitest';
import { GOAL_OUTCOME_BASIS_VALUES } from './enums.js';
import {
  OUTCOME_BASIS_TIER,
  OUTCOME_BASIS_VALUES,
  outcomeBasisTier,
  tallyOutcomesByBasis,
} from './outcome-basis.js';
import { OBJECTIVE_OUTCOME_BASIS_VALUES } from './wire/attribution.js';

describe('outcome basis tiers (S11 W1a)', () => {
  it('gives every Turn, Task and GoalRun basis a tier, and nothing else', () => {
    expect([...OUTCOME_BASIS_VALUES].sort()).toEqual(
      [...new Set([...OBJECTIVE_OUTCOME_BASIS_VALUES, ...GOAL_OUTCOME_BASIS_VALUES])].sort(),
    );
  });

  it('counts only the requester’s word and confirmed checks toward attainment', () => {
    expect(outcomeBasisTier('requester')).toBe('primary');
    expect(outcomeBasisTier('verified_by_check')).toBe('primary');
    expect(outcomeBasisTier('agent_reported')).toBe('proxy');
    expect(outcomeBasisTier('reviewer_assessed')).toBe('proxy');
    expect(Object.keys(OUTCOME_BASIS_TIER)).toHaveLength(4);
  });
});

describe('tallyOutcomesByBasis', () => {
  it('keeps proxy outcomes out of the attainment rate', () => {
    const tally = tallyOutcomesByBasis([
      { basis: 'requester', outcome: 'achieved' },
      { basis: 'verified_by_check', outcome: 'achieved' },
      { basis: 'verified_by_check', outcome: 'not_achieved' },
      { basis: 'agent_reported', outcome: 'achieved' },
      { basis: 'agent_reported', outcome: 'achieved' },
      { basis: 'agent_reported', outcome: 'achieved' },
      { basis: 'reviewer_assessed', outcome: 'not_achieved' },
    ]);
    expect(tally.primary).toEqual({ achieved: 2, notAchieved: 1, total: 3, attainment: 2 / 3 });
    expect(tally.proxy).toEqual({ achieved: 3, notAchieved: 1, total: 4, attainment: 3 / 4 });
    expect(tally.byBasis).toEqual({
      verified_by_check: { achieved: 1, notAchieved: 1 },
      requester: { achieved: 1, notAchieved: 0 },
      reviewer_assessed: { achieved: 0, notAchieved: 1 },
      agent_reported: { achieved: 3, notAchieved: 0 },
    });
  });

  it('has no rate for a tier with no outcome, rather than 0', () => {
    const onlyProxy = tallyOutcomesByBasis([{ basis: 'agent_reported', outcome: 'achieved' }]);
    expect(onlyProxy.primary).toEqual({ achieved: 0, notAchieved: 0, total: 0, attainment: null });
    expect(onlyProxy.proxy.attainment).toBe(1);

    const none = tallyOutcomesByBasis([]);
    expect(none.primary.attainment).toBeNull();
    expect(none.proxy.attainment).toBeNull();
  });
});
