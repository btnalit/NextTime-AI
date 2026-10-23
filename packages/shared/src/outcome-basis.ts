import type { GoalOutcomeBasis, ObjectiveOutcome } from './enums.js';
import type { ObjectiveOutcomeBasis } from './wire/attribution.js';

/**
 * outcome-basis (S11 W1a; docs/global-roadmap-2026-10-16.md W1a "达成率按 basis 分列"): which
 * objective outcomes an attainment figure may count. The one rule every read of "how often did
 * this work" goes through — E2's per-Skill read model must tally with {@link tallyOutcomesByBasis},
 * never sum outcomes of its own.
 *
 * An outcome's basis says whose judgement it is (`ObjectiveOutcomeBasis` for Turns and Tasks,
 * `GoalOutcomeBasis` for GoalRuns). Two tiers:
 *   - `primary` — the requester's own word (`requester`) or a platform check the requester
 *     confirmed (`verified_by_check`). Only these make the attainment rate.
 *   - `proxy` — the delegating agent's own report (`agent_reported`) and, from W4, an independent
 *     reviewer's assessment (`reviewer_assessed`). Shown next to the rate as a proxy indicator,
 *     never added into it.
 */
export type OutcomeBasis = ObjectiveOutcomeBasis | GoalOutcomeBasis;

export const OUTCOME_BASIS_TIER_VALUES = ['primary', 'proxy'] as const;
export type OutcomeBasisTier = (typeof OUTCOME_BASIS_TIER_VALUES)[number];

/** Every basis a Turn, Task or GoalRun outcome can carry, with its tier — a basis added to either
 *  list without a tier here fails to compile. */
export const OUTCOME_BASIS_TIER: Readonly<Record<OutcomeBasis, OutcomeBasisTier>> = {
  verified_by_check: 'primary',
  requester: 'primary',
  reviewer_assessed: 'proxy',
  agent_reported: 'proxy',
};

export const OUTCOME_BASIS_VALUES = Object.keys(OUTCOME_BASIS_TIER) as readonly OutcomeBasis[];

export function outcomeBasisTier(basis: OutcomeBasis): OutcomeBasisTier {
  return OUTCOME_BASIS_TIER[basis];
}

export interface OutcomeCount {
  readonly achieved: number;
  readonly notAchieved: number;
}

export interface OutcomeTierTally extends OutcomeCount {
  readonly total: number;
  /** `achieved / total`, or `null` when nothing in this tier has an outcome. */
  readonly attainment: number | null;
}

export interface OutcomeTallyByBasis {
  /** The attainment rate: `requester` and `verified_by_check` outcomes only. */
  readonly primary: OutcomeTierTally;
  /** The proxy indicator: `agent_reported` and `reviewer_assessed`, never mixed into `primary`. */
  readonly proxy: OutcomeTierTally;
  readonly byBasis: Readonly<Record<OutcomeBasis, OutcomeCount>>;
}

function tierTally(counts: readonly OutcomeCount[]): OutcomeTierTally {
  let achieved = 0;
  let notAchieved = 0;
  for (const count of counts) {
    achieved += count.achieved;
    notAchieved += count.notAchieved;
  }
  const total = achieved + notAchieved;
  return { achieved, notAchieved, total, attainment: total === 0 ? null : achieved / total };
}

/** Tallies objective outcomes by basis and tier. An unknown outcome (no record) is not passed in
 *  and counts nowhere; it is not a `not_achieved`. */
export function tallyOutcomesByBasis(
  outcomes: Iterable<{ readonly basis: OutcomeBasis; readonly outcome: ObjectiveOutcome }>,
): OutcomeTallyByBasis {
  const byBasis = Object.fromEntries(
    OUTCOME_BASIS_VALUES.map((basis) => [basis, { achieved: 0, notAchieved: 0 }]),
  ) as Record<OutcomeBasis, { achieved: number; notAchieved: number }>;
  for (const { basis, outcome } of outcomes) {
    const count = byBasis[basis];
    if (outcome === 'achieved') count.achieved += 1;
    else count.notAchieved += 1;
  }
  const inTier = (tier: OutcomeBasisTier) =>
    OUTCOME_BASIS_VALUES.filter((basis) => OUTCOME_BASIS_TIER[basis] === tier).map(
      (basis) => byBasis[basis],
    );
  return { primary: tierTally(inTier('primary')), proxy: tierTally(inTier('proxy')), byBasis };
}
