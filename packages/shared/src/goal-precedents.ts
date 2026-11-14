import { z } from 'zod';
import type { GoalOutcomeBasis, ObjectiveOutcome } from './enums.js';
import { WORKER_HINT_WINDOW_DAYS } from './wire/worker-discovery.js';

/**
 * S11 GO17 (`docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md` §4, the 先例 paragraph;
 * `s11-w4/go17-default-plan.md`, coordinator 11-07): a goal's precedents — earlier goals of the same
 * requester that ended with an outcome and are of the same kind, given to whoever writes the next
 * plan so it can say what was done the last time and how that came out.
 *
 * A precedent is read, never stored, and authorizes nothing: a plan that copies a precedent's
 * steps is checked like any other (I-G8 unchanged). What it carries is the full record — the plan
 * in force when the goal ended, its outcome and what that rests on, the checks of its last
 * verification round with their evidence, the checks a person overrode — not a summary.
 *
 * Rules (the kernel applies them, `application/goal/precedents.ts`):
 *
 *   - **Whose goals** (F2 A): only goals requested by the same person (`on_behalf_of`), whatever
 *     their role — an owner's agent does not get other people's plans as precedents.
 *   - **Which goals** (F5 A): `completed` with an outcome, ended within
 *     {@link GOAL_PRECEDENT_WINDOW_DAYS} days; a cancelled goal has no outcome to learn from.
 *   - **Same kind** (F1 A, by structure, never by wording): a goal whose first plan was made from
 *     the same Procedure (`procedure`), else one whose plan in force at its end has a step run by
 *     a Worker of the same family (`worker`). With nothing to match against, the most recent ones
 *     (`recent`). Newest first within each, procedure matches before worker matches.
 *   - **Polarity** ({@link goalPrecedentPolarity}).
 *
 * S11 GO17b (F4 A): a revision records the precedents its plan was written from
 * (`plan_revisions.cited_precedents`, migration goal/0018; `citedPrecedents` on every read of a
 * revision): the entry agent names them in `propose_goal`'s `precedents`, the goal planner in its
 * report. Each is one of the requester's own completed goals, cited once, at most
 * {@link GOAL_PRECEDENT_MAX_CITED}; a planner cites only the precedents its round's input gave it.
 * A citation authorizes nothing either.
 */

/** How far back a precedent may have ended — the window GO13's hints and GO16's combinations
 *  count over. */
export const GOAL_PRECEDENT_WINDOW_DAYS = WORKER_HINT_WINDOW_DAYS;
/** How many precedents a planner's input and the entry context carry. */
export const GOAL_PRECEDENT_CONTEXT_LIMIT = 3;
/** `find_goal_precedents`' default and ceiling. */
export const GOAL_PRECEDENT_DEFAULT_LIMIT = 3;
export const GOAL_PRECEDENT_MAX_LIMIT = 10;
/** S11 GO17b (F4 A): how many precedents one revision may cite — what one `find_goal_precedents`
 *  returns at most; migration goal/0018's `plan_revisions_cited_precedents_shape` holds the same. */
export const GOAL_PRECEDENT_MAX_CITED = GOAL_PRECEDENT_MAX_LIMIT;
/** How many Worker families `find_goal_precedents` matches against at once. */
export const GOAL_PRECEDENT_MAX_WORKER_FILTER = 20;

/**
 * What a precedent says about its plan:
 *
 *   - `positive`: achieved, and the platform's own checks say so — achieved by check
 *     (`verified_by_check`), or (S11 GO18, `platformChecksPassed`) its last verification round
 *     passed whole with at least one check the platform makes in it, whatever a review or the
 *     requester's confirmation added on top: a stricter acceptance never makes a goal count for
 *     less. An achieved goal whose checks a person overrode rests on the requester's word, never
 *     on this;
 *   - `negative`: not achieved, or achieved on the requester's word over checks that did not pass
 *     (`overriddenChecks`);
 *   - `unverified`: achieved on the requester's word or a review with no check the platform makes
 *     (nothing overridden) — said, not checked.
 *
 * None of them says the plan will work this time: a positive one worked on a goal like this.
 */
export const GOAL_PRECEDENT_POLARITY_VALUES = ['positive', 'negative', 'unverified'] as const;
export type GoalPrecedentPolarity = (typeof GOAL_PRECEDENT_POLARITY_VALUES)[number];
export const GoalPrecedentPolaritySchema = z.enum(GOAL_PRECEDENT_POLARITY_VALUES);

/** Why a goal is a precedent of the one at hand — see the module comment. */
export const GOAL_PRECEDENT_MATCH_VALUES = ['procedure', 'worker', 'recent'] as const;
export type GoalPrecedentMatch = (typeof GOAL_PRECEDENT_MATCH_VALUES)[number];
export const GoalPrecedentMatchSchema = z.enum(GOAL_PRECEDENT_MATCH_VALUES);

export function goalPrecedentPolarity(
  outcome: ObjectiveOutcome,
  basis: GoalOutcomeBasis,
  overriddenChecks: number,
  platformChecksPassed: boolean,
): GoalPrecedentPolarity {
  if (outcome === 'not_achieved' || overriddenChecks > 0) return 'negative';
  return basis === 'verified_by_check' || platformChecksPassed ? 'positive' : 'unverified';
}
