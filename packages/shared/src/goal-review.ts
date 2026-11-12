import { z } from 'zod';
import { REVIEW_SCORE_MAX, type ReviewCriterion } from './goal-plan.js';
import type { OutputProblem, OutputSchema } from './output-schema.js';

/**
 * goal-review (S11 GO18; plan §4.6, I-G5; `s11-w4/go18-default-plan.md`): what a goal's reviewer
 * reports and how the platform reads it — shared by the kernel that runs reviews
 * (`application/goal/review.ts`), the wire that shows them (`wire/goal.ts`) and the console.
 *
 * A reviewer is a Worker the kernel starts for a `review` acceptance check of a verifying GoalRun,
 * once every check of the round the platform makes has passed. It acts for the requester, observes
 * nothing, can do nothing but report, and reads only what the check names: the goal's statement,
 * the criteria, and the accepted output and files of the steps it reviews. It scores each criterion
 * 0–{@link REVIEW_SCORE_MAX} with a reason, or `null` when what it was given does not let it judge
 * that criterion.
 *
 * The verdict is the platform's arithmetic over those scores ({@link reviewDerivation}), recorded
 * once and recomputed on every read, so what a person reads is what decided — the reviewer's own
 * opinion of the whole is a comment, never a verdict. A review is a proxy indicator: an `achieved`
 * resting on one is `reviewer_assessed`, kept apart from the platform's checks and the requester's
 * word in every statistic.
 */

/** The longest reason a reviewer gives for one score. */
export const MAX_REVIEW_REASON_CHARS = 500;
/** The longest comment a reviewer adds about the whole. */
export const MAX_REVIEW_COMMENT_CHARS = 2000;

/**
 * Why a review is `unavailable` (`goal_acceptance_checks.last_error`; goal/0019 holds the same
 * list): codes only. The last error of a check reaches the goal planner's input, precedents and a
 * person's outcome Decision, so it never carries a criterion, a score or anything a reviewer wrote
 * (F5, I-P7) — that stays in the assessment and the pause's detail.
 */
export const REVIEW_UNAVAILABLE_CODE_VALUES = [
  'review_unreadable',
  'model_not_offered',
  'model_not_allowed',
  'reviewer_unpublished',
  'subject_missing',
  'no_budget',
  'daily_cost_exceeded',
  'depth_exceeded',
  'requester_cannot_start',
  'reviewer_task_missing',
  'reviewer_failed',
  'report_unreadable',
  'criteria_unassessed',
] as const;
export type ReviewUnavailableCode = (typeof REVIEW_UNAVAILABLE_CODE_VALUES)[number];

/** What a review came to: the points reached `passAt` (`passed`), did not (`failed`), or a
 *  criterion could not be judged (`unavailable` — never a pass). */
export const REVIEW_VERDICT_VALUES = ['passed', 'failed', 'unavailable'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICT_VALUES)[number];
export const ReviewVerdictSchema = z.enum(REVIEW_VERDICT_VALUES);

/** The reviewer Task's output contract (`tasks.output_schema`, held by `report_task_result`); the
 *  criteria it names are then held to the check's own ({@link reviewReportProblems}). */
export const REVIEWER_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  description:
    'Your review: one score for every criterion in your input, each once, with the reason for it. comment, optional: anything about the whole a person should read.',
  properties: {
    scores: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          criterion: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'The key of the criterion, as your input names it.',
          },
          score: {
            type: ['integer', 'null'],
            minimum: 0,
            maximum: REVIEW_SCORE_MAX,
            description: `0 (not met at all) to ${REVIEW_SCORE_MAX} (fully met); null when what you were given does not let you judge this criterion.`,
          },
          reason: { type: 'string', minLength: 1, maxLength: MAX_REVIEW_REASON_CHARS },
        },
        required: ['criterion', 'score', 'reason'],
        additionalProperties: false,
      },
    },
    comment: { type: 'string', minLength: 1, maxLength: MAX_REVIEW_COMMENT_CHARS },
  },
  required: ['scores'],
  additionalProperties: false,
};

export const ReviewScoreSchema = z
  .object({
    criterion: z.string().min(1).max(64),
    score: z.number().int().min(0).max(REVIEW_SCORE_MAX).nullable(),
    reason: z.string().min(1).max(MAX_REVIEW_REASON_CHARS),
  })
  .strict();
export type ReviewScore = z.infer<typeof ReviewScoreSchema>;

/** A reviewer's report, as its output contract reads it. */
export const ReviewerOutputSchema = z
  .object({
    scores: z.array(ReviewScoreSchema).min(1),
    comment: z.string().min(1).max(MAX_REVIEW_COMMENT_CHARS).optional(),
  })
  .strict();
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

/** Where a report's scores do not match the check's criteria — each criterion scored once, none
 *  the check does not have — named like a contract problem (`output.scores.<i>.criterion`). Empty
 *  when they match. */
export function reviewReportProblems(
  criteria: readonly ReviewCriterion[],
  output: ReviewerOutput,
): OutputProblem[] {
  const problems: OutputProblem[] = [];
  const known = new Set(criteria.map((criterion) => criterion.key));
  const seen = new Set<string>();
  output.scores.forEach((score, index) => {
    const path = `output.scores.${index}.criterion`;
    if (!known.has(score.criterion)) {
      problems.push({
        path,
        message: `is not a criterion of this review (${[...known].join(', ')})`,
      });
    } else if (seen.has(score.criterion)) {
      problems.push({ path, message: `scores criterion ${score.criterion} a second time` });
    }
    seen.add(score.criterion);
  });
  for (const criterion of criteria) {
    if (!seen.has(criterion.key)) {
      problems.push({
        path: 'output.scores',
        message: `has no score for criterion ${criterion.key}`,
      });
    }
  }
  return problems;
}

/** One line of a derivation: a criterion, its weight, the reviewer's score and reason, and the
 *  points it gives (`score × weight`, `null` when it was not judged) out of `maxPoints`. */
export interface ReviewDerivationLine {
  readonly criterion: string;
  readonly weight: number;
  readonly score: number | null;
  readonly reason: string;
  readonly points: number | null;
  readonly maxPoints: number;
}

/** How a review's verdict follows from its scores, step by step: the lines in the check's order,
 *  the points they add up to out of the most they could, and `passAt` — `passed` when
 *  `points × 100 ≥ passAt × maxPoints` (integer arithmetic: no rounding decides), `unavailable`
 *  when any criterion was not judged (`unassessed`). */
export interface ReviewDerivation {
  readonly lines: readonly ReviewDerivationLine[];
  readonly points: number;
  readonly maxPoints: number;
  readonly passAt: number;
  readonly unassessed: readonly string[];
  readonly verdict: ReviewVerdict;
}

/** The derivation of a report whose scores match `criteria` ({@link reviewReportProblems} found
 *  nothing) — throws otherwise: a mismatch never reaches a verdict. */
export function reviewDerivation(
  criteria: readonly ReviewCriterion[],
  passAt: number,
  scores: readonly ReviewScore[],
): ReviewDerivation {
  if (scores.length !== criteria.length) {
    throw new Error('reviewDerivation: the scores do not match the criteria');
  }
  const byCriterion = new Map(scores.map((score) => [score.criterion, score]));
  const lines = criteria.map((criterion): ReviewDerivationLine => {
    const score = byCriterion.get(criterion.key);
    if (!score) throw new Error(`reviewDerivation: no score for criterion ${criterion.key}`);
    return {
      criterion: criterion.key,
      weight: criterion.weight,
      score: score.score,
      reason: score.reason,
      points: score.score === null ? null : score.score * criterion.weight,
      maxPoints: REVIEW_SCORE_MAX * criterion.weight,
    };
  });
  const points = lines.reduce((sum, line) => sum + (line.points ?? 0), 0);
  const maxPoints = lines.reduce((sum, line) => sum + line.maxPoints, 0);
  const unassessed = lines.filter((line) => line.score === null).map((line) => line.criterion);
  const verdict: ReviewVerdict =
    unassessed.length > 0
      ? 'unavailable'
      : points * 100 >= passAt * maxPoints
        ? 'passed'
        : 'failed';
  return { lines, points, maxPoints, passAt, unassessed, verdict };
}

/** The criteria that cost the most points, worst first — what a pause says pulled a review down
 *  (at most three; ties in the check's order). */
export function reviewShortfalls(derivation: ReviewDerivation): readonly string[] {
  return derivation.lines
    .filter((line) => line.points !== null && line.points < line.maxPoints)
    .map((line, index) => ({ line, index, lost: line.maxPoints - (line.points ?? 0) }))
    .sort((a, b) => b.lost - a.lost || a.index - b.index)
    .slice(0, 3)
    .map(({ line }) => `${line.criterion} ${line.score}/${REVIEW_SCORE_MAX}`);
}
