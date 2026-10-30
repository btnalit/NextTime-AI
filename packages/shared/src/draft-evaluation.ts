import type { DraftEvaluationStageName } from './wire/eval.js';

/**
 * draft-evaluation (S10 E3-2b; docs/s10-evolution-plan-2026-10-04.md §5.5 四级漏斗, 审查器, 怎么判):
 * the fixed rules of a draft evaluation — how many times each stage tries a case, the thresholds a
 * verdict is judged by, and the limits of the check a draft passes before anything runs. Shared so
 * the kernel that runs and judges an evaluation and the console that estimates its cost and
 * explains its verdict use the same numbers. An owner-edited evaluation setting (§5.6 评测总览)
 * replaces them when it comes; until then these are the rules, and the console says so.
 */
export const DRAFT_EVALUATION_RULES = {
  /** Tries of each regression case, per arm (§5.5: 每例 1–3 次). */
  regressionK: 2,
  /** Tries of the named mechanism's cases per arm, in all (§5.5: ON / OFF 各 10 次) — spread
   *  evenly over its cases, rounded up. */
  mechanismTriesPerArm: 10,
  /** The share of its tries the baseline may pass for the mechanism to count as shown (§5.5:
   *  OFF ≤ 4 of 10). The candidate must pass every one. */
  mechanismBaselineMaxShare: 0.4,
  /** Tries of each confirmation case, per arm. */
  confirmK: 3,
  /** δ, the non-inferiority margin, as a share of tries (§5.5: 10 个百分点). */
  delta: 0.1,
  /** The one-sided confidence of the pass-rate difference's lower bound (Newcombe's hybrid score
   *  interval). */
  confidence: 0.95,
  /** An arm with a larger share of a stage's trials ended without an outcome
   *  (`trialHasOutcome`) proves nothing: `inconclusive`. Counted per arm, so trials lost in one
   *  arm alone cannot tilt the comparison. */
  maxErroredShare: 0.25,
} as const;

/**
 * Errors that are the arm's own outcome: its Worker ran and did not finish the task — it ran out
 * of time, ended without reporting, or spent its token budget. Such a trial counts as not passed.
 * Any other error (it could not start, was lost or terminated, its Worker crashed) says nothing of
 * the Skill: the trial has no outcome, and a verdict must hold whichever way it would have gone.
 */
export const DRAFT_EVALUATION_FAILING_ERRORS = [
  'timeout',
  'no_result',
  'budget_exhausted',
] as const;

/** Whether an ended trial has an outcome a verdict may read: scored, or errored in a way that is
 *  the arm's own failure (`DRAFT_EVALUATION_FAILING_ERRORS`). */
export function trialHasOutcome(trial: {
  readonly status: string;
  readonly error: string | null;
}): boolean {
  if (trial.status === 'scored') return true;
  return (
    trial.status === 'errored' &&
    (DRAFT_EVALUATION_FAILING_ERRORS as readonly (string | null)[]).includes(trial.error)
  );
}

/** Whether a trial was voided: the evaluation was cancelled while it waited its turn, so it never
 *  started — no Task, no cost (#833 UX P3-2). A trial cancelled while running ran: it is errored. */
export function trialVoided(trial: {
  readonly status: string;
  readonly error: string | null;
  readonly taskId: string | null;
}): boolean {
  return trial.status === 'errored' && trial.error === 'cancelled' && trial.taskId === null;
}

/** How many times a stage tries each of its cases, per arm — 0 for a stage with no case. */
export function draftEvaluationStageK(stage: DraftEvaluationStageName, caseCount: number): number {
  if (caseCount <= 0) return 0;
  if (stage === 'regression') return DRAFT_EVALUATION_RULES.regressionK;
  if (stage === 'mechanism') {
    return Math.ceil(DRAFT_EVALUATION_RULES.mechanismTriesPerArm / caseCount);
  }
  return DRAFT_EVALUATION_RULES.confirmK;
}

/** How many trials a stage holds: both arms, each of its cases, k times. */
export function draftEvaluationStageTrials(
  stage: DraftEvaluationStageName,
  caseCount: number,
): number {
  return 2 * caseCount * draftEvaluationStageK(stage, caseCount);
}

/** The most of `baselineTries` the baseline may pass in a mechanism stage. */
export function mechanismBaselineMaxPassed(baselineTries: number): number {
  return Math.floor(DRAFT_EVALUATION_RULES.mechanismBaselineMaxShare * baselineTries + 1e-9);
}

/** The limits two of the draft checks hold it to (`DRAFT_CHECK_VALUES`, wire/eval.ts). */
export const DRAFT_CHECK_LIMITS = {
  /** Characters of a Skill's name, description and body together. */
  maxChars: 20_000,
  /** Lines added or removed against the version it would replace (the description counts as one). */
  maxChangedLines: 200,
} as const;
