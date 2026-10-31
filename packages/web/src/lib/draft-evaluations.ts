import {
  DRAFT_EVALUATION_RULES,
  DRAFT_EVALUATION_STAGE_VALUES,
  type DraftCheckProblemWire,
  DraftCheckProblemWireSchema,
  type DraftEvaluationArmTallyWire,
  type DraftEvaluationReason,
  type DraftEvaluationSkip,
  type DraftEvaluationStageName,
  type DraftEvaluationStageWire,
  type DraftEvaluationSummaryWire,
  type EvalBudgetWire,
  type EvalCaseSummaryWire,
  draftEvaluationStageK,
  draftEvaluationStageTrials,
  mechanismBaselineMaxPassed,
} from '@nexttime/shared';
import type { ErrorOverrides } from './errors.js';
import { evaluationPausedStartText, formatUsd } from './eval-runs.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import type { DraftEvaluationOutcome } from './status-tone.js';

/**
 * lib/draft-evaluations (S10 E3-2b): what the console says about a draft evaluation — its stages
 * and the rule each is judged by, why it reached its verdict, why a stage was skipped, what the
 * check before it starts found, and what a start would run and cost. The numbers come from
 * `@nexttime/shared` draft-evaluation.ts (the kernel judges by the same ones). No React, no
 * capability calls (`components/evaluation/DraftEvaluations.tsx` and
 * `components/catalog/SkillDraftEvaluations.tsx` do those).
 */

const RULES = DRAFT_EVALUATION_RULES;

/** A share as whole percentage points: 0.1 → "10". */
function points(share: number): string {
  return String(Math.round(share * 100));
}

/** The evaluation's state as one status (`kit/status-chip`'s `draftEvaluation` machine): running,
 *  cancelled, or its verdict. A finished one always has a verdict; `inconclusive` stands in if a
 *  read ever lacks it. */
export function draftEvaluationOutcome(
  row: Pick<DraftEvaluationSummaryWire, 'status' | 'verdict'>,
): DraftEvaluationOutcome {
  if (row.status === 'running') return 'running';
  if (row.status === 'cancelled') return 'cancelled';
  return row.verdict ?? 'inconclusive';
}

/** A stage's name. */
export function stageName(stage: DraftEvaluationStageName, t: Translate): string {
  switch (stage) {
    case 'regression':
      return t('回归检查', 'Regression check');
    case 'mechanism':
      return t('机制检验', 'Mechanism test');
    case 'confirm':
      return t('确认对比', 'Confirmation');
  }
}

/** The rule a stage is judged by, in a sentence — the fixed rules (an owner-set evaluation
 *  setting replaces them when one comes, §5.6). */
export function stageRuleText(stage: DraftEvaluationStageName, t: Translate): string {
  switch (stage) {
    case 'regression':
      return t(
        `用例集的每条回归用例，两组各跑 ${RULES.regressionK} 次。草稿组每条通过的次数不能少于基线组，否则判「有回归」。`,
        `Each regression case of the suite runs ${RULES.regressionK} times per arm. The draft must pass each as often as the baseline does, else Regressed.`,
      );
    case 'mechanism': {
      const max = mechanismBaselineMaxPassed(RULES.mechanismTriesPerArm);
      return t(
        `针对所选机制的用例，两组各跑约 ${RULES.mechanismTriesPerArm} 次（平摊到每条用例，向上取整）。草稿组必须每次都通过，基线组最多通过 ${points(RULES.mechanismBaselineMaxShare)}%（${RULES.mechanismTriesPerArm} 次里 ${max} 次），否则判「机制未证实」。没选机制就跳过。`,
        `The cases aimed at the chosen mechanism run about ${RULES.mechanismTriesPerArm} times per arm (spread over its cases, rounded up). The draft must pass every try and the baseline at most ${points(RULES.mechanismBaselineMaxShare)}% of them (${max} in ${RULES.mechanismTriesPerArm}), else Refuted. Skipped when no mechanism is chosen.`,
      );
    }
    case 'confirm':
      return t(
        `用例集的每条完整用例，两组各跑 ${RULES.confirmK} 次，看 dev 上通过率之差（草稿 − 基线）的单侧 ${points(RULES.confidence)}% 下界：草稿比基线低 ${points(RULES.delta)} 个百分点以上判「差于基线」；下界大于 0 判「优于基线」，大于 −${points(RULES.delta)} 个百分点判「不差于基线」，否则「没有定论」。后两种还要 holdout 指向同一边。`,
        `Each full case of the suite runs ${RULES.confirmK} times per arm, judged by the one-sided ${points(RULES.confidence)}% lower bound of the dev pass-rate difference (draft − baseline): more than ${points(RULES.delta)} points below the baseline is Worse; a bound above 0 is Better, above −${points(RULES.delta)} points Non-inferior, otherwise Inconclusive. Better and Non-inferior also need holdout to point the same way.`,
      );
  }
}

/** Why the evaluation reached its verdict, in a sentence. */
export function verdictReasonText(reason: DraftEvaluationReason, t: Translate): string {
  switch (reason) {
    case 'regression_case_lost':
      return t(
        '有回归用例，草稿通过的次数比基线少。',
        'On a regression case the draft passed fewer times than the baseline.',
      );
    case 'mechanism_not_shown':
      return t(
        `所选机制的用例上，草稿没有每次都通过，或基线也通过了 ${points(RULES.mechanismBaselineMaxShare)}% 以上，所以不能说是这个草稿修好了这个机制。`,
        `On the chosen mechanism’s cases the draft did not pass every try, or the baseline passed more than ${points(RULES.mechanismBaselineMaxShare)}% of them too, so the draft is not shown to fix that mechanism.`,
      );
    case 'below_margin':
      return t(
        `dev 上草稿的通过率比基线低了 ${points(RULES.delta)} 个百分点以上。`,
        `On dev the draft’s pass rate is more than ${points(RULES.delta)} points below the baseline’s.`,
      );
    case 'above_baseline':
      return t(
        'dev 上草稿的通过率高于基线（差值的下界大于 0），holdout 也没有反向。',
        'On dev the draft’s pass rate is above the baseline’s (the difference’s lower bound is above 0), and holdout does not point the other way.',
      );
    case 'within_margin':
      return t(
        `dev 上草稿的通过率不比基线低 ${points(RULES.delta)} 个百分点以上（差值的下界大于 −${points(RULES.delta)}），holdout 也一致。`,
        `On dev the draft’s pass rate is not more than ${points(RULES.delta)} points below the baseline’s (the difference’s lower bound is above −${points(RULES.delta)}), and holdout agrees.`,
      );
    case 'too_few_trials':
      return t(
        `试的次数还分不出高下：差值的下界没有高于 −${points(RULES.delta)} 个百分点。用例更多的用例集能给出结论。`,
        `Too few tries to tell: the difference’s lower bound is not above −${points(RULES.delta)} points. A suite with more cases can decide it.`,
      );
    case 'holdout_disagrees':
      return t(
        'dev 上看草稿更好或不差，但 holdout 指向了另一边，结论不可信。',
        'On dev the draft looks better or no worse, but holdout points the other way, so that cannot be trusted.',
      );
    case 'no_holdout_cases':
      return t(
        '用例集没有 holdout 用例，没法确认 dev 上的结果不是凑出来的，所以不给「优于」或「不差于」。给用例集加几条 holdout 用例。',
        'The suite has no holdout case to confirm the dev result was not fitted to it, so it cannot give Better or Non-inferior. Add holdout cases to the suite.',
      );
    case 'no_confirm_cases':
      return t(
        '用例集没有「完整」分区的用例，确认对比没法跑；前面跑了的阶段都过了。',
        'The suite has no case in the full partition, so the confirmation could not run; the stages that ran before it passed.',
      );
    case 'errored_trials':
      return t(
        `有试跑没有结果（没能启动、中途丢失、被终止或崩溃，或者跑的时候评测防泄漏暂停了评测自己的智能体）：一组里超过 ${points(RULES.maxErroredShare)}% 是这样，或者它们正好能改变某条用例或这个阶段的判定，所以这次说明不了什么。超时、没交汇报、用完了 token 额度算作没通过，不算没有结果。看那些试跑为什么没有结果，再评测一次。`,
        `Some trials have no outcome (they did not start, or were lost, terminated or crashed, or the evaluation seal paused the evaluation’s own agents while they ran): over ${points(RULES.maxErroredShare)}% of an arm, or enough to change how a case or the stage is judged, so this proves nothing. A timeout, a missing report or a spent token budget counts as not passing, not as no outcome. Look at why those trials have none, then evaluate again.`,
      );
    case 'budget':
      return t(
        '本月剩下的评测预算不够跑下一个阶段，评测在那里停下，那个阶段没有启动。',
        'What was left of this month’s evaluation budget did not cover the next stage, so the evaluation stopped there without starting it.',
      );
    case 'environment_differs':
      return t(
        '试跑不全在同一个运行环境里（镜像、模型、平台版本或系统提示词变了），两组没法直接比较。',
        'The trials did not all run in one environment (the image, model, platform version or system prompt changed), so the two arms cannot be compared.',
      );
    case 'environment_unknown':
      return t(
        '有试跑的运行环境没有记录下来，没法确认两组是在同一个环境里跑的。',
        'A trial’s environment was not recorded, so the two arms cannot be shown to have run in one environment.',
      );
    case 'content_withheld':
      return t(
        '有试跑的 Worker 没有启动：要交给它的内容里带着评测保留的部分（holdout 用例的原文或 canary），平台拦下了它。',
        'A trial’s Worker was not started: what it would start with held text evaluation keeps back (a holdout case’s text or a canary), so the platform stopped it.',
      );
    case 'canary_reported':
      return t(
        '有试跑的 Worker 在汇报里写出了用例集的 canary，说明评测内容泄露给了它。',
        'A trial’s Worker wrote the suite’s canary in its report, so evaluation content reached it.',
      );
  }
}

/** Why a stage was skipped. */
export function skipReasonText(skip: DraftEvaluationSkip, t: Translate): string {
  switch (skip) {
    case 'no_cases':
      return t('用例集里没有这个阶段的用例。', 'The suite holds no case for this stage.');
    case 'no_mechanism':
      return t('没有选机制，跳过机制检验。', 'No mechanism was chosen, so it is skipped.');
    case 'budget':
      return t(
        '本月剩下的评测预算不够跑这个阶段。',
        'What was left of this month’s evaluation budget did not cover this stage.',
      );
  }
}

/** What an ended stage came to — `passed` on to the next stage, or the stage whose outcome gave
 *  the verdict (`decided`). `null` for a stage that has not ended. */
export function stageResult(
  stage: Pick<DraftEvaluationStageWire, 'stage' | 'status'>,
  evaluation: Pick<DraftEvaluationSummaryWire, 'decidedBy'>,
): 'passed' | 'decided' | null {
  if (stage.status !== 'ended') return null;
  return evaluation.decidedBy === stage.stage ? 'decided' : 'passed';
}

/** One failed check of the draft (400 `draft_check_failed`), in a sentence: what it found and
 *  what to change. The kernel names counts only, never the text it found. */
export function draftCheckProblemText(problem: DraftCheckProblemWire, t: Translate): string {
  const count = problem.count ?? 0;
  const limit = problem.limit ?? 0;
  switch (problem.check) {
    case 'credential_like':
      return t(
        `有 ${count} 处看起来像凭证的值。Skill 里不能带凭证，删掉它们。`,
        `It has ${count} value${count === 1 ? '' : 's'} shaped like a credential. A Skill carries no credential; remove ${count === 1 ? 'it' : 'them'}.`,
      );
    case 'internal_id':
      return t(
        `有 ${count} 处平台 id（UUID）。Skill 写的是做法，不写某个工作区的具体记录，改成名称或说法。`,
        `It has ${count} platform id${count === 1 ? '' : 's'} (UUID). A Skill says how, not which row of one workspace; use names instead.`,
      );
    case 'oversized':
      return t(
        `名称、描述和正文一共 ${count} 个字符，超过了 ${limit} 的上限。`,
        `Its name, description and body come to ${count} characters, over the ${limit} limit.`,
      );
    case 'unchanged':
      return t(
        '它和要替换的已发布版本一字不差，没什么可比的。',
        'It says exactly what the published version it would replace says, so there is nothing to compare.',
      );
    case 'edit_budget':
      return t(
        `和要替换的版本比改了 ${count} 行，超过了 ${limit} 行的上限（新 Skill 的每一行都算）。把改动拆小一点，一次只改一件事。`,
        `${count} lines differ from the version it would replace, over the ${limit}-line limit (every line counts for a new Skill). Make a smaller change, one thing at a time.`,
      );
    case 'contaminated':
      return t(
        '里面有某个用例集的 canary，或某条 holdout 用例的原文。评测时它的 Worker 会被拦下，删掉这段内容。',
        'It holds an evaluation suite’s canary or a holdout case’s text, so its Worker would be stopped; remove that text.',
      );
  }
}

/** The failed checks a refused start carried (`details.problems`), or `null` when `err` is not a
 *  `draft_check_failed`. */
export function draftCheckProblemsOf(err: unknown): readonly DraftCheckProblemWire[] | null {
  if (!(err instanceof HttpError) || err.code !== 'draft_check_failed') return null;
  const listed = err.details?.problems;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((item) => {
    const parsed = DraftCheckProblemWireSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export interface BudgetShortfall {
  readonly budgetUsd: number;
  readonly spentUsd: number;
  /** What the trials not ended yet will take. */
  readonly committedUsd: number;
  readonly estimateUsd: number;
}

/** What a refused start's `evaluation_budget_insufficient` carried, or `null` for another error. */
export function budgetShortfallOf(err: unknown): BudgetShortfall | null {
  if (!(err instanceof HttpError) || err.code !== 'evaluation_budget_insufficient') return null;
  const { budgetUsd, spentUsd, committedUsd, estimateUsd } = err.details ?? {};
  if (
    typeof budgetUsd !== 'number' ||
    typeof spentUsd !== 'number' ||
    typeof committedUsd !== 'number' ||
    typeof estimateUsd !== 'number'
  ) {
    return null;
  }
  return { budgetUsd, spentUsd, committedUsd, estimateUsd };
}

/** Why a start was refused for the budget, in a sentence — with what the trials not ended yet
 *  hold of it, when they hold any. */
export function budgetShortfallText(shortfall: BudgetShortfall, t: Translate): string {
  const estimate = formatUsd(shortfall.estimateUsd);
  const budget = formatUsd(shortfall.budgetUsd);
  const spent = formatUsd(shortfall.spentUsd);
  if (shortfall.committedUsd <= 0) {
    return t(
      `第一个阶段预估 ${estimate}，本月评测预算 ${budget} 已用 ${spent}，不够，什么也没有启动。`,
      `The first stage is estimated at ${estimate} and ${spent} of the ${budget} monthly evaluation budget is spent, so nothing was started.`,
    );
  }
  const committed = formatUsd(shortfall.committedUsd);
  return t(
    `第一个阶段预估 ${estimate}，本月评测预算 ${budget} 已用 ${spent}，还没跑完的试跑约占 ${committed}，不够，什么也没有启动。等那些试跑结束后再看剩多少。`,
    `The first stage is estimated at ${estimate}; ${spent} of the ${budget} monthly evaluation budget is spent and about ${committed} is held for trials not ended yet, so nothing was started. See what is left once those trials end.`,
  );
}

/** The mechanisms a suite's mechanism cases name, each with how many cases name it, in the order
 *  the cases come — what a start may choose from (the kernel matches them trimmed). */
export function suiteMechanisms(
  cases: readonly Pick<EvalCaseSummaryWire, 'partition' | 'mechanism'>[],
): readonly { readonly mechanism: string; readonly caseCount: number }[] {
  const counts = new Map<string, number>();
  for (const row of cases) {
    const mechanism = row.mechanism?.trim();
    if (row.partition !== 'mechanism' || !mechanism) continue;
    counts.set(mechanism, (counts.get(mechanism) ?? 0) + 1);
  }
  return [...counts].map(([mechanism, caseCount]) => ({ mechanism, caseCount }));
}

export interface StagePlan {
  readonly stage: DraftEvaluationStageName;
  readonly caseCount: number;
  /** Tries of each case, per arm. */
  readonly k: number;
  /** Both arms, every case, k times. */
  readonly trials: number;
  /** Its trials × the recent cost of a trial; `null` while no trial's cost is known. */
  readonly estimateUsd: number | null;
  /** Why it will not run whatever happens before it, as the kernel would skip it. */
  readonly skip: Exclude<DraftEvaluationSkip, 'budget'> | null;
  /** Whether what is left of the budget covers it after the stages before it spent their
   *  estimates — `null` with no estimate (the kernel lets an unknown estimate through). */
  readonly covered: boolean | null;
}

export interface DraftEvaluationPlan {
  readonly stages: readonly StagePlan[];
  /** Every stage that will run, if each passes: their trials and estimates together. */
  readonly trials: number;
  readonly estimateUsd: number | null;
  /** No stage has a case to run: the start would be refused. */
  readonly nothingToRun: boolean;
  /** The first stage that runs does not fit what is left: 429 `evaluation_budget_insufficient`. */
  readonly firstNotCovered: boolean;
  /** A later stage may not fit by the time it is reached, and would be skipped (`budget`). */
  readonly laterMayBeSkipped: boolean;
}

/**
 * What a start would run on a suite's `cases` (its current version) with `mechanism` chosen (or
 * none), as the kernel plans it (`application/eval` draft-evaluations `planFrom`): each stage's
 * cases, k and trials, and its estimate against `budget` — what is left once the trials not ended
 * yet are paid for. The kernel checks each stage against the budget as it reaches it; this assumes
 * the stages before it cost what they were estimated to.
 */
export function draftEvaluationPlan(
  cases: readonly Pick<EvalCaseSummaryWire, 'partition' | 'mechanism'>[],
  mechanism: string | null,
  budget: Pick<
    EvalBudgetWire,
    'monthlyBudgetUsd' | 'spentUsd' | 'committedUsd' | 'trialCostUsd'
  > | null,
): DraftEvaluationPlan {
  const counts: Record<DraftEvaluationStageName, number> = {
    regression: cases.filter((row) => row.partition === 'regression').length,
    mechanism:
      mechanism === null
        ? 0
        : cases.filter(
            (row) => row.partition === 'mechanism' && row.mechanism?.trim() === mechanism.trim(),
          ).length,
    confirm: cases.filter((row) => row.partition === 'full').length,
  };
  const trialCost = budget?.trialCostUsd ?? null;
  // What a start can count on: the trials not ended yet (this one's or another's) are paid first.
  const left =
    budget === null ? null : budget.monthlyBudgetUsd - budget.spentUsd - budget.committedUsd;
  let spent = 0;
  let trials = 0;
  let estimateUsd: number | null = trialCost === null ? null : 0;
  let firstNotCovered = false;
  let laterMayBeSkipped = false;
  let first = true;
  const stages = DRAFT_EVALUATION_STAGE_VALUES.map((stage): StagePlan => {
    const caseCount = counts[stage];
    const skip =
      stage === 'mechanism' && mechanism === null
        ? 'no_mechanism'
        : caseCount === 0
          ? 'no_cases'
          : null;
    if (skip !== null) {
      return { stage, caseCount, k: 0, trials: 0, estimateUsd: null, skip, covered: null };
    }
    const stageTrials = draftEvaluationStageTrials(stage, caseCount);
    const estimate = trialCost === null ? null : stageTrials * trialCost;
    const covered = estimate === null || left === null ? null : spent + estimate <= left + 1e-9;
    if (covered === false) {
      if (first) firstNotCovered = true;
      else laterMayBeSkipped = true;
    }
    first = false;
    spent += estimate ?? 0;
    trials += stageTrials;
    if (estimateUsd !== null && estimate !== null) estimateUsd += estimate;
    return {
      stage,
      caseCount,
      k: draftEvaluationStageK(stage, caseCount),
      trials: stageTrials,
      estimateUsd: estimate,
      skip: null,
      covered,
    };
  });
  return {
    stages,
    trials,
    estimateUsd,
    nothingToRun: first,
    firstNotCovered,
    laterMayBeSkipped,
  };
}

/** What a start's refusals say in the evaluate dialog, beyond the kernel's own text. */
export function draftEvaluationStartErrors(t: Translate): ErrorOverrides {
  return {
    evaluation_probe_hold: evaluationPausedStartText(t),
    not_a_draft: t(
      '这个版本已经不是草稿了（发布了，或被丢弃、拒绝），只有草稿能评测，什么也没有启动。刷新后看它现在的状态。',
      'This version is no longer a draft (it was published, discarded or rejected); only a draft can be evaluated, and nothing was started. Refresh to see its current state.',
    ),
    draft_changed: t(
      '草稿在你打开之后换过内容，什么也没有启动。刷新后看过新的内容再评测。',
      'The draft changed after you opened it, and nothing was started. Refresh, look it over, then evaluate it.',
    ),
    version_changed: t(
      '用例集在你打开对话框之后改过（加减了用例，或换了钉住的 Worker），什么也没有启动。已重新读取用例集，看过阶段安排后再开始。',
      'The suite changed after you opened the dialog (cases added or removed, or another Worker pinned), and nothing was started. The suite has been read again; look over the stages, then start.',
    ),
    draft_evaluating: t(
      '这个草稿已经有一次评测在跑，什么也没有启动。到「评测 → 草稿评测」看它的进度。',
      'This draft is already being evaluated, and nothing was started. See its progress under Evaluation → Draft evaluations.',
    ),
    conflict: t(
      '没能启动，什么也没有启动：所选机制在用例集里已经没有用例，用例集没有可跑的用例，钉住的 Worker 版本不再发布，或 Worker 已经加载了另一个同名的 Skill（先给草稿改名）。技术细节里有具体原因。',
      'Nothing was started: the chosen mechanism has no case in the suite any more, the suite has no case to run, the pinned Worker version is no longer published, or the Worker already loads another Skill by this name (rename the draft first). The technical details say which.',
    ),
    not_found: t(
      '找不到这个草稿或用例集（可能已被丢弃、拒绝或删除），什么也没有启动。',
      'The draft or the suite is not there any more (discarded, rejected or deleted), and nothing was started.',
    ),
  };
}

/** A pass rate as "passed/trials (n%)"; "—" without a try. */
export function passRateText(passed: number, trials: number): string {
  if (trials === 0) return '—';
  return `${passed}/${trials} (${Math.round((passed / trials) * 100)}%)`;
}

/** A difference of pass rates in signed percentage points: 0.153 → "+15.3". */
export function pointsText(share: number | null): string {
  if (share === null) return '—';
  const value = Math.round(share * 1000) / 10;
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}`;
}

/** An evaluation's cost so far, or why it is not known. */
export function costText(costUsd: number | null, t: Translate): string {
  return costUsd === null
    ? t('费用未知（有模型没有价格）', 'cost unknown (a model has no price)')
    : formatUsd(costUsd);
}

/** One arm's trials as "n/m passed · e errored · …". */
export function tallyText(tally: DraftEvaluationArmTallyWire, t: Translate): string {
  const parts = [
    t(`${tally.passed}/${tally.trials} 通过`, `${tally.passed}/${tally.trials} passed`),
  ];
  if (tally.errored > 0) parts.push(t(`${tally.errored} 出错`, `${tally.errored} errored`));
  if (tally.voided > 0) parts.push(t(`${tally.voided} 作废`, `${tally.voided} voided`));
  if (tally.open > 0) parts.push(t(`${tally.open} 未结束`, `${tally.open} not ended`));
  return parts.join(' · ');
}

/** One arm's tries on one case, compact: "n/m (e errored, …)". */
export function cellText(tally: DraftEvaluationArmTallyWire, t: Translate): string {
  const base = `${tally.passed}/${tally.trials}`;
  const extra = [
    tally.errored > 0 ? t(`${tally.errored} 出错`, `${tally.errored} errored`) : null,
    tally.voided > 0 ? t(`${tally.voided} 作废`, `${tally.voided} voided`) : null,
    tally.open > 0 ? t(`${tally.open} 未结束`, `${tally.open} open`) : null,
  ].filter((part): part is string => part !== null);
  return extra.length === 0 ? base : `${base} (${extra.join(', ')})`;
}

/** "; n more without an outcome" after a pass rate — rates count the trials with one. */
export function noOutcomeText(none: number, t: Translate): string {
  return none === 0 ? '' : t(`，另 ${none} 次没有结果`, `, ${none} more without an outcome`);
}
