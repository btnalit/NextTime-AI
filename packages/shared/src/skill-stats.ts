import type { ObjectiveOutcome, TaskFailureCategory, TaskFailureReason } from './enums.js';

/**
 * skill-stats (S11 W1a E2-1; S10 §5.4, docs/global-roadmap-2026-10-16.md W1a E2): the rules a
 * Skill version's statistics (`get_skill_stats`) are read by that are not counting outcomes — that
 * one is `tallyOutcomesByBasis` (`outcome-basis.ts`). Pure, so the kernel's read and its tests use
 * the same rule.
 */

const FAILURE_CATEGORY: Readonly<Record<TaskFailureReason, TaskFailureCategory>> = {
  no_result: 'no_result',
  worker_failed: 'worker_error',
  timeout: 'limit_reached',
  budget_exhausted: 'limit_reached',
  spawn_failed: 'platform',
  spawn_lost: 'platform',
  run_lost: 'platform',
  terminated: 'platform',
  model_refused: 'platform',
};

/** The category a failed Task's `failure_reason` names (`TASK_FAILURE_CATEGORY_VALUES`): every
 *  reason the kernel writes has one; a value an earlier release wrote, or none, is `other`. A
 *  reason added to `TASK_FAILURE_REASON_VALUES` without a category here fails to compile. */
export function taskFailureCategory(reason: string | null | undefined): TaskFailureCategory {
  if (reason === null || reason === undefined) return 'other';
  return Object.hasOwn(FAILURE_CATEGORY, reason)
    ? FAILURE_CATEGORY[reason as TaskFailureReason]
    : 'other';
}

/** How many primary outcomes in a row, all not achieved, mark a Skill or Procedure version's
 *  segment 「建议复核」 (coordinator decisions 2026-10-29: E2 fork 5 = a, E2-2 fork 2 = a). */
export const REVIEW_STREAK = 3;

/**
 * Whether a segment's most recent primary outcomes suggest a review: the latest
 * {@link REVIEW_STREAK} of them, newest first, are all `not_achieved`. Only primary outcomes of one
 * segment are passed in — one Skill version in one run environment, or one Procedure version's
 * goals that ran in one set of environments — so a proxy outcome never suggests a review, and
 * outcomes of another environment are never compared. A hint for a person (a builder decides
 * whether to deprecate); nothing acts on it.
 */
export function suggestsReview(primaryOutcomesNewestFirst: readonly ObjectiveOutcome[]): boolean {
  if (primaryOutcomesNewestFirst.length < REVIEW_STREAK) return false;
  return primaryOutcomesNewestFirst
    .slice(0, REVIEW_STREAK)
    .every((outcome) => outcome === 'not_achieved');
}
