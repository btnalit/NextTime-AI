import {
  REVIEW_SCORE_MAX,
  type ReviewAssessmentWire,
  type ReviewCriterion,
  type ReviewUnavailableCode,
} from '@nexttime/shared';
import type { Translate } from './i18n.js';

/**
 * lib/goal-review (S11 GO18b): what the console says about a goal's independent review — a `review`
 * acceptance check (`goal-plan.ts` `ReviewCheckSchema`) as the person confirming the plan reads it,
 * and what one came to (`ReviewAssessmentWire`) as the goal's page shows it. No React and no calls.
 *
 * A review is a proxy indicator: a model scores what the reviewed steps produced against the
 * criteria, and the platform works out from the scores whether it passed. Everything here says so,
 * and says which model scored, because a model scoring its own work is the weak case.
 */

/** The most points a review's criteria can score (`REVIEW_SCORE_MAX` × the weights). */
export function reviewMaxPoints(criteria: readonly Pick<ReviewCriterion, 'weight'>[]): number {
  return criteria.reduce((sum, criterion) => sum + REVIEW_SCORE_MAX * criterion.weight, 0);
}

/** The fewest points that pass: `points × 100 ≥ passAt × maxPoints`, the kernel's own integer rule
 *  (`reviewDerivation`), so no rounding here can say a review passed that the platform failed. */
export function reviewPointsToPass(passAt: number, maxPoints: number): number {
  return Math.ceil((passAt * maxPoints) / 100);
}

/** One criterion as a line: its description and how much it counts. */
export function reviewCriterionWeightText(weight: number, t: Translate): string {
  return t(`权重 ${weight}`, `weight ${weight}`);
}

/** How a review passes, in one sentence — 「N 条标准，加权得分至少 P 分（满分 M 的 X%）算通过」. */
export function reviewPassText(
  check: {
    readonly criteria: readonly Pick<ReviewCriterion, 'weight'>[];
    readonly passAt: number;
  },
  t: Translate,
): string {
  const max = reviewMaxPoints(check.criteria);
  const needed = reviewPointsToPass(check.passAt, max);
  const n = check.criteria.length;
  return t(
    `由独立评审按 ${n} 条标准逐条打 0 到 ${REVIEW_SCORE_MAX} 分，乘以权重相加，至少 ${needed} 分（满分 ${max} 的 ${check.passAt}%）算通过`,
    `An independent reviewer scores ${n === 1 ? 'one criterion' : `${n} criteria`} 0 to ${REVIEW_SCORE_MAX} each; weighted and added up, ${needed} points or more (${check.passAt}% of ${max}) pass`,
  );
}

/** What a review's verdict is worth, said wherever one is declared or read. */
export function reviewProxyText(t: Translate): string {
  return t(
    '评审结果是代理指标：是模型按这些标准打的分，平台只按分数算过没过，不是平台自己验证过的事实。',
    'A review is a proxy indicator: a model scores against these criteria and the platform works out from the scores whether it passed. It is not something the platform verified itself.',
  );
}

/** The model a review scores with — the check's, or the requester's when it names none. */
export function reviewModelText(model: string | null | undefined, t: Translate): string {
  return model
    ? t(`评审模型：${model}`, `Reviewer model: ${model}`)
    : t(
        '评审模型：请求人的模型（请求人的智能体设置来选）',
        'Reviewer model: the requester’s (their agent settings pick it)',
      );
}

/**
 * Whether a review declared in `plan` scores its steps with the model that does them, as far as
 * the plan says — the steps' Workers may set a model the plan does not show:
 *  - `same`: the review names a model, and a reviewed step's WorkerSpec sets that very model;
 *  - `different`: the review names a model, and every reviewed step's WorkerSpec sets another one;
 *  - `unknown`: anything else — the review takes the requester's model, or a reviewed step takes
 *    its Worker's (often the requester's too).
 * After the review ran, the assessment says for certain (`sameModel`).
 */
export type PlanReviewModelMatch = 'same' | 'different' | 'unknown';

export function planReviewModelMatch(
  check: { readonly subjects: readonly string[]; readonly model?: string | undefined },
  plan: {
    readonly steps: readonly {
      readonly key: string;
      readonly spec?: { readonly model?: string | undefined } | undefined;
    }[];
  },
): PlanReviewModelMatch {
  if (check.model === undefined) return 'unknown';
  const models = check.subjects.map(
    (subject) => plan.steps.find((step) => step.key === subject)?.spec?.model,
  );
  if (models.some((model) => model === check.model)) return 'same';
  return models.every((model) => model !== undefined) ? 'different' : 'unknown';
}

/** The note under a declared review about which model scores whose work (`null`: nothing to say —
 *  the review names a model no reviewed step sets). `editing`: said in the plan editor, beside the
 *  model select, rather than on the goal's page. */
export function planReviewModelNote(
  match: PlanReviewModelMatch,
  t: Translate,
  editing = false,
): string | null {
  switch (match) {
    case 'same':
      return editing
        ? t(
            '评审用的模型和被评步骤的一样：等于模型给自己的产出打分。可以给评审换一个模型。',
            'The reviewer uses the same model as a step it reviews: a model scoring its own work. Pick another model for the review.',
          )
        : t(
            '评审用的模型和被评步骤的一样：等于模型给自己的产出打分。修订计划时可以给评审换一个模型。',
            'The reviewer uses the same model as a step it reviews: a model scoring its own work. A revision can give the review another model.',
          );
    case 'unknown':
      return editing
        ? t(
            '评审和被评步骤可能用同一个模型（没有指定时，两边多半都用请求人的模型），那样等于模型给自己的产出打分。可以给评审另选一个模型。',
            'The reviewer and the steps it reviews may use the same model (left unset, both usually take the requester’s), which is a model scoring its own work. Pick another model for the review.',
          )
        : t(
            '评审和被评步骤可能用同一个模型（没有指定时，两边多半都用请求人的模型），那样等于模型给自己的产出打分。修订计划时可以给评审另选一个模型。',
            'The reviewer and the steps it reviews may use the same model (left unset, both usually take the requester’s), which is a model scoring its own work. A revision can give the review another model.',
          );
    case 'different':
      return null;
  }
}

/** A score as the page shows it — 「打分 3 / 4」, told apart from the points it makes (UX acceptance
 *  of #1111) — or 「判断不了」 for a criterion the reviewer could not judge. */
export function reviewScoreText(score: number | null, t: Translate): string {
  return score === null
    ? t('判断不了', 'not judged')
    : t(`打分 ${score} / ${REVIEW_SCORE_MAX}`, `scored ${score} of ${REVIEW_SCORE_MAX}`);
}

/** The points a criterion's score makes (score × weight), out of the most it can make. */
export function reviewLinePointsText(points: number, maxPoints: number, t: Translate): string {
  return t(`得 ${points} / ${maxPoints} 分`, `${points} of ${maxPoints} points`);
}

/** A review's steps in the order the plan has them (UX acceptance of #1111: 「polish、draft」 read
 *  backwards); a key the plan no longer has keeps its place after the rest. */
export function inPlanOrder(
  subjects: readonly string[],
  stepKeys: readonly string[],
): readonly string[] {
  return inPlanOrderBy(subjects, (key) => key, stepKeys);
}

/** `inPlanOrder` for items that each name a step (a review's executor models, say). */
export function inPlanOrderBy<T>(
  items: readonly T[],
  stepKeyOf: (item: T) => string,
  stepKeys: readonly string[],
): readonly T[] {
  const at = (key: string) => {
    const index = stepKeys.indexOf(key);
    return index === -1 ? stepKeys.length : index;
  };
  return [...items].sort((a, b) => at(stepKeyOf(a)) - at(stepKeyOf(b)));
}

/** The points against the line: 「得分 11 / 16（69%），至少 12 分通过」. */
export function reviewPointsText(
  assessment: Pick<ReviewAssessmentWire, 'points' | 'maxPoints' | 'passAt'>,
  t: Translate,
): string {
  const percent = Math.floor((assessment.points * 100) / assessment.maxPoints);
  const needed = reviewPointsToPass(assessment.passAt, assessment.maxPoints);
  return t(
    `得分 ${assessment.points} / ${assessment.maxPoints}（${percent}%），至少 ${needed} 分（${assessment.passAt}%）通过`,
    `${assessment.points} of ${assessment.maxPoints} points (${percent}%); ${needed} (${assessment.passAt}%) pass`,
  );
}

/** What a review came to, in words. */
export function reviewVerdictText(
  assessment: Pick<ReviewAssessmentWire, 'verdict' | 'unassessed'>,
  t: Translate,
): string {
  switch (assessment.verdict) {
    case 'passed':
      return t('评审通过', 'The review passed');
    case 'failed':
      return t('评审没过线', 'The review fell short of its line');
    case 'unavailable':
      return t(
        `有 ${assessment.unassessed.length} 条标准评审判断不了，没有结论（不算通过）`,
        `The reviewer could not judge ${assessment.unassessed.length === 1 ? 'one criterion' : `${assessment.unassessed.length} criteria`}: no verdict (never a pass)`,
      );
  }
}

/** Whether the reviewer scored with the model that did the work (`sameModel`). */
export function reviewSameModelText(sameModel: boolean | null, t: Translate): string {
  if (sameModel === true) {
    return t(
      '评审和被评步骤用的是同一个模型：等于模型给自己的产出打分，这个结论分量更轻。',
      'The reviewer and a step it reviewed used the same model: a model scoring its own work, which weighs less.',
    );
  }
  if (sameModel === null) {
    return t(
      '分不清是不是同一个模型：一边用默认模型，一边指定了模型。',
      'Whether it was the same model cannot be told: one side used the default model, the other named one.',
    );
  }
  return t(
    '评审和被评步骤用的不是同一个模型。',
    'The reviewer and the steps it reviewed used different models.',
  );
}

/** A model as an assessment records it (`null`: pi's default). */
export function assessedModelText(model: string | null, t: Translate): string {
  return model ?? t('默认模型', 'the default model');
}

/** Why a review has no verdict (`last_error`, a closed list of codes: `REVIEW_UNAVAILABLE_CODE_VALUES`). */
export const REVIEW_UNAVAILABLE_TEXT: Readonly<
  Record<ReviewUnavailableCode, readonly [string, string]>
> = {
  review_unreadable: ['评审检查读不出来', 'The review check could not be read'],
  model_not_offered: [
    '评审要用的模型不在模型目录里',
    'The model the review asks for is not in the model catalog',
  ],
  model_not_allowed: [
    '工作区不允许评审要用的模型',
    'The workspace does not allow the model the review asks for',
  ],
  reviewer_unpublished: [
    '平台的目标评审器没有已发布的版本',
    'The platform’s goal reviewer has no published version',
  ],
  subject_missing: [
    '要评的步骤没有成功，或者成功了但既没有输出也没有文件',
    'A step to review did not succeed, or succeeded with neither output nor files',
  ],
  no_budget: [
    '目标剩下的 token 预算不够评审用',
    'What is left of the goal’s token budget is too little for the review',
  ],
  daily_cost_exceeded: [
    '今天的花费额度用完了，评审没开',
    'Today’s cost allowance is used up, so the review did not start',
  ],
  depth_exceeded: [
    '嵌套额度用完了，评审没开',
    'The nesting allowance is used up, so the review did not start',
  ],
  requester_cannot_start: [
    '请求人现在不能启动评审（权限变了）',
    'The requester can no longer start the review (their permissions changed)',
  ],
  reviewer_task_missing: ['评审任务不见了', 'The reviewer’s Task is gone'],
  reviewer_failed: [
    '评审任务没有完成（失败、超时或被终止）',
    'The reviewer’s Task did not complete (it failed, timed out or was stopped)',
  ],
  report_unreadable: ['读不懂评审的报告', 'The reviewer’s report could not be read'],
  criteria_unassessed: [
    '有标准评审判断不了，没有结论',
    'The reviewer could not judge a criterion, so there is no verdict',
  ],
};
