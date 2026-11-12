import type { GoalPlan, GoalReviewWire, ReviewCheck } from '@nexttime/shared';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  assessedModelText,
  planReviewModelMatch,
  planReviewModelNote,
  reviewCriterionWeightText,
  reviewLinePointsText,
  reviewModelText,
  reviewPassText,
  reviewPointsText,
  reviewProxyText,
  reviewSameModelText,
  reviewScoreText,
  reviewVerdictText,
} from '../../lib/goal-review.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from '../kit/notice.js';
import { RefChip } from '../kit/ref-chip.js';

/**
 * components/goals/ReviewCheck (S11 GO18b): a goal's independent review on its page.
 *
 * `ReviewDeclaration` — a `review` check of the plan, under its sentence: every criterion with its
 * description and weight, how the points pass, that the result is a proxy indicator, the model
 * that scores and, when the plan shows it may be the one doing the work, that a model would be
 * scoring itself. The person confirming the plan reads here what the goal will be judged by (UX
 * acceptance of #1102: 「3 条标准，75% 通过」 alone told them nothing of it).
 *
 * `ReviewOutcome` — what a review check of a verification round came to: its reviewer Task while
 * it runs, then the derivation the platform worked out (each criterion's score, weight, points and
 * reason, the points against the line, the verdict), the reviewer's comment, which models scored
 * and did the work, and whether they were the same.
 */
export function ReviewDeclaration({
  check,
  plan,
}: {
  readonly check: ReviewCheck;
  readonly plan: Pick<GoalPlan, 'steps'>;
}) {
  const t = useT();
  const modelNote = planReviewModelNote(planReviewModelMatch(check, plan), t);
  return (
    <div className="stack-s w-full" data-testid="goal-review-declaration">
      <span className="text-small">{reviewPassText(check, t)}</span>
      <ol className="stack-s" data-testid="goal-review-criteria">
        {check.criteria.map((criterion) => (
          <li
            key={criterion.key}
            className="row-wrap text-small"
            data-testid="goal-review-criterion"
            data-criterion={criterion.key}
          >
            <span>{criterion.description}</span>
            <span className="text-3 tabular">{reviewCriterionWeightText(criterion.weight, t)}</span>
          </li>
        ))}
      </ol>
      <span className="text-small text-3" data-testid="goal-review-model">
        {reviewModelText(check.model, t)}
      </span>
      <span className="text-small text-3" data-testid="goal-review-proxy">
        {reviewProxyText(t)}
      </span>
      {modelNote ? (
        <Notice tone="warn" testId="goal-review-model-note">
          {modelNote}
        </Notice>
      ) : null}
    </div>
  );
}

export function ReviewOutcome({
  review,
  http,
}: {
  readonly review: GoalReviewWire;
  readonly http?: CapabilityCaller;
}) {
  const t = useT();
  const { assessment } = review;
  const describe = (key: string) =>
    review.criteria.find((criterion) => criterion.key === key)?.description ?? key;
  const task = review.taskId ? (
    <RefChip
      kind="task"
      id={review.taskId}
      // The platform's reviewer Worker is named in English; say what the Task is, in the page's
      // language (UX acceptance of #1111).
      name={t('独立评审', 'Independent review')}
      http={http}
      href={hrefs.task(review.taskId)}
      size="s"
      testId="goal-review-task"
    />
  ) : null;

  if (assessment === null) {
    return (
      <span className="row-wrap text-small text-3" data-testid="goal-review-pending">
        {review.taskId
          ? t('评审任务：', 'Reviewer Task: ')
          : t(
              '这一轮的平台检查全部通过后才开评审。',
              'The review starts once every check the platform makes in this round has passed.',
            )}
        {task}
      </span>
    );
  }

  return (
    <div
      className="stack-s w-full"
      data-testid="goal-review-outcome"
      data-verdict={assessment.verdict}
    >
      {/* The check's own status chip is on its row above: the verdict in words only. */}
      <span className="row-wrap text-small">
        <span className="font-medium" data-testid="goal-review-verdict">
          {reviewVerdictText(assessment, t)}
        </span>
        <span className="tabular" data-testid="goal-review-points">
          {reviewPointsText(assessment, t)}
        </span>
      </span>
      <ol className="stack-s">
        {assessment.lines.map((line) => (
          <li
            key={line.criterion}
            className="flex flex-col gap-1 text-small"
            data-testid="goal-review-line"
            data-criterion={line.criterion}
          >
            <span className="row-wrap">
              <span>{describe(line.criterion)}</span>
              <span className="text-3 tabular">
                {reviewCriterionWeightText(line.weight, t)}
                {' · '}
                <span data-testid="goal-review-score">{reviewScoreText(line.score, t)}</span>
                {line.points === null
                  ? null
                  : ` · ${reviewLinePointsText(line.points, line.maxPoints, t)}`}
              </span>
            </span>
            <span className="text-3">{line.reason}</span>
          </li>
        ))}
      </ol>
      {assessment.comment ? (
        <span className="text-small" data-testid="goal-review-comment">
          {t('评审的总评：', 'The reviewer’s comment: ')}
          {assessment.comment}
        </span>
      ) : null}
      <span className="row-wrap text-small text-3" data-testid="goal-review-models">
        <span>
          {t(
            `评审模型：${assessedModelText(assessment.reviewerModel, t)}`,
            `Reviewer model: ${assessedModelText(assessment.reviewerModel, t)}`,
          )}
        </span>
        {assessment.executorModels.map((executor) => (
          <span key={executor.stepKey}>
            {t(
              `${executor.stepKey}（第 ${executor.attempt} 次尝试）：${assessedModelText(executor.model, t)}`,
              `${executor.stepKey} (attempt ${executor.attempt}): ${assessedModelText(executor.model, t)}`,
            )}
          </span>
        ))}
        {task}
      </span>
      {assessment.sameModel === false ? (
        <span className="text-small text-3" data-testid="goal-review-same-model">
          {reviewSameModelText(false, t)}
        </span>
      ) : (
        <Notice tone="warn" testId="goal-review-same-model">
          {reviewSameModelText(assessment.sameModel, t)}
        </Notice>
      )}
      <span className="text-small text-3">{reviewProxyText(t)}</span>
    </div>
  );
}
