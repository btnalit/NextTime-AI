import type {
  DraftEvaluationSummaryWire,
  DraftEvaluationWire,
  EvalSuiteSummaryWire,
  EvalSuiteWire,
} from '@nexttime/shared';
import { useState } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  type DraftEvaluationPlan,
  budgetShortfallOf,
  draftCheckProblemText,
  draftCheckProblemsOf,
  draftEvaluationOutcome,
  draftEvaluationPlan,
  draftEvaluationStartErrors,
  skipReasonText,
  stageName,
  suiteMechanisms,
  verdictReasonText,
} from '../../lib/draft-evaluations.js';
import { describeError, isForbiddenError } from '../../lib/errors.js';
import { budgetStanding, formatUsd } from '../../lib/eval-runs.js';
import { formatRelative } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import {
  RaiseBudgetHint,
  budgetLine,
  budgetSpentText,
  trialEstimateLine,
  useEvalBudget,
  useIsOwner,
} from '../evaluation/EvalBudget.js';
import { useLoadWhen } from '../evaluation/hooks.js';
import { Button } from '../kit/button.js';
import { GuardedCancelButton } from '../kit/discard-guard.js';
import { Field } from '../kit/field.js';
import { InlineError } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { Select } from '../kit/select.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../kit/sheet.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { StillNeeded } from '../kit/still-needed.js';

/** How many of this version's evaluations the section lists (the 草稿评测 tab has them all). */
const SHOWN = 5;

export interface SkillDraftEvaluationsProps {
  readonly http: CapabilityCaller;
  readonly skill: {
    readonly id: string;
    readonly version: number;
    readonly name: string;
    readonly status: string;
    /** The draft as read (`SkillSummaryWire.draftDigest`) — what a start binds to. */
    readonly draftDigest?: string;
  };
  /** The version the draft would replace (`undefined`: a new Skill). */
  readonly inUseVersion: number | undefined;
}

/**
 * components/catalog/SkillDraftEvaluations (S10 E3-2b): 「评测」 on a Skill's detail — this
 * version's draft evaluations (`list_draft_evaluations{skillId}`), each with its state or verdict
 * and a link to it under 评测 → 草稿评测, and on a draft, 「评测」 (a builder or the owner), which
 * opens `StartDraftEvaluationSheet`. While one runs the draft cannot be discarded or rejected; the
 * section says so above those buttons. A published version shows the evaluations it had as a
 * draft, if any — evidence beside it, never a gate on publishing.
 */
export function SkillDraftEvaluations({ http, skill, inUseVersion }: SkillDraftEvaluationsProps) {
  const t = useT();
  const can = useRoleCan(http);
  const allowed = can('list_draft_evaluations') !== false;
  const list = useCapability<{ items: readonly DraftEvaluationSummaryWire[] }>(
    http,
    'list_draft_evaluations',
    { skillId: skill.id },
    { enabled: allowed },
  );
  const [starting, setStarting] = useState(false);
  const isDraft = skill.status === 'draft';
  const canStart =
    isDraft && skill.draftDigest !== undefined && can('start_draft_evaluation') !== false;
  const state = list.state;
  if (!allowed || (state.status === 'error' && isForbiddenError(state.error))) return null;
  const rows =
    state.status === 'ready'
      ? state.data.items.filter((row) => row.candidate.version === skill.version)
      : [];
  const running = rows.find((row) => row.status === 'running');
  const baselineText =
    inUseVersion !== undefined
      ? t(`在用的 v${inUseVersion}`, `v${inUseVersion}, the one in use`)
      : t('不加载它的 Worker', 'the Worker without it');
  // A published version without evaluations has nothing to show here.
  if (!isDraft && rows.length === 0) return null;

  return (
    <div className="stack-s" data-testid="skill-draft-evaluations">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <span className="section-title">{t('评测', 'Evaluation')}</span>
        {canStart ? (
          <Button
            variant="secondary"
            size="s"
            disabled={running !== undefined}
            title={
              running !== undefined
                ? t('这个草稿已经有一次评测在跑', 'This draft is already being evaluated')
                : undefined
            }
            onClick={() => setStarting(true)}
            data-testid="skill-draft-evaluate"
          >
            {t('评测', 'Evaluate')}
          </Button>
        ) : null}
      </div>
      {isDraft ? (
        <p className="text-3 text-small">
          {t(
            `用一个用例集把这个草稿和${baselineText}比一比：依次跑回归检查、机制检验、确认对比，哪一阶段不过就停。结果是给发布的人看的证据，不拦发布。`,
            `Compare this draft with ${baselineText} on an evaluation suite: a regression check, a mechanism test and a confirmation, stopping at the first that fails. The result is evidence for whoever publishes, never a gate.`,
          )}
          {isDraft && !canStart && can('start_draft_evaluation') === false
            ? t('评测由构建者或工作区所有者发起。', ' A builder or a workspace owner starts one.')
            : ''}
        </p>
      ) : null}
      {running !== undefined ? (
        <Notice testId="skill-draft-evaluating">
          {t(
            '评测进行中：结束或取消之前，这个草稿不能丢弃或拒绝。',
            'Being evaluated: until the evaluation ends or is cancelled, this draft cannot be discarded or rejected.',
          )}{' '}
          <RouteLink href={hrefs.evaluation('drafts', running.id)} className="link-inline">
            {t('查看进度', 'See its progress')}
          </RouteLink>
        </Notice>
      ) : null}
      {state.status === 'loading' ? (
        <SkeletonRows count={1} label={t('正在加载评测', 'Loading evaluations')} />
      ) : state.status === 'error' ? (
        <InlineError error={state.error} testId="skill-draft-evaluations-error" />
      ) : rows.length === 0 ? (
        <p className="text-3 text-small" data-testid="skill-draft-evaluations-empty">
          {t('这个版本还没有评测过。', 'This version has not been evaluated yet.')}
        </p>
      ) : (
        <ul className="eval-suite-history">
          {rows.slice(0, SHOWN).map((row) => (
            <li key={row.id} data-testid="skill-draft-evaluation">
              <span className="row-wrap">
                <StatusChip
                  machine="draftEvaluation"
                  status={draftEvaluationOutcome(row)}
                  size="s"
                />
                <RouteLink href={hrefs.evaluation('drafts', row.id)} className="link-inline">
                  {row.suite.name} v{row.suite.version}
                </RouteLink>
                <span className="text-3 text-small">{formatRelative(row.createdAt)}</span>
              </span>
              <span className="text-2 text-small">
                {row.status === 'running' && row.stage !== null
                  ? t(`进行中：${stageName(row.stage, t)}`, `Running: ${stageName(row.stage, t)}`)
                  : row.status === 'finished' && row.reason !== null
                    ? verdictReasonText(row.reason, t)
                    : row.status === 'cancelled'
                      ? t('已取消，没有结论。', 'Cancelled, with no verdict.')
                      : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > SHOWN ? (
        <RouteLink href={hrefs.evaluation('drafts')} className="link-inline">
          {t(`全部 ${rows.length} 次评测`, `All ${rows.length} evaluations`)}
        </RouteLink>
      ) : null}
      {canStart && skill.draftDigest !== undefined ? (
        <StartDraftEvaluationSheet
          http={http}
          open={starting}
          onOpenChange={setStarting}
          skill={{ ...skill, draftDigest: skill.draftDigest }}
          inUseVersion={inUseVersion}
          onStarted={() => {
            setStarting(false);
            void list.reload();
          }}
        />
      ) : null}
    </div>
  );
}

interface StartDraftEvaluationSheetProps {
  readonly http: CapabilityCaller;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly skill: {
    readonly id: string;
    readonly version: number;
    readonly name: string;
    readonly draftDigest: string;
  };
  readonly inUseVersion: number | undefined;
  readonly onStarted: (evaluation: DraftEvaluationWire) => void;
}

/**
 * The 「评测」 sheet: a suite picked from the workspace's suites (never a typed id), the mechanism
 * picked from those its mechanism cases name (or none: the mechanism test is skipped), then each
 * stage as it would run — cases, tries, trials and the estimate against what is left of this
 * month's evaluation budget — before anything starts. The draft's check before a start (400
 * `draft_check_failed`) lists each failed check in place; a suite that changed meanwhile (409
 * `version_changed`) is read again.
 */
function StartDraftEvaluationSheet({
  http,
  open,
  onOpenChange,
  skill,
  inUseVersion,
  onStarted,
}: StartDraftEvaluationSheetProps) {
  const t = useT();
  const isOwner = useIsOwner(http);
  const budget = useEvalBudget(http);
  const suites = useLoadWhen(open ? 'suites' : null, async () => {
    const page = await http.call<{ items: readonly EvalSuiteSummaryWire[] }>(
      'list_eval_suites',
      {},
    );
    return page.items;
  });
  const [suiteId, setSuiteId] = useState('');
  const [mechanism, setMechanism] = useState('');
  const [reads, setReads] = useState(0);
  const suite = useLoadWhen(open && suiteId !== '' ? `${suiteId}#${reads}` : null, () =>
    http.call<EvalSuiteWire>('get_eval_suite', { suiteId }),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const suiteData = suite.status === 'ready' ? suite.data : undefined;
  const budgetData = budget.state.status === 'ready' ? budget.state.data : null;
  const standing = budgetData === null ? null : budgetStanding(budgetData);
  const mechanisms = suiteData === undefined ? [] : suiteMechanisms(suiteData.cases);
  const plan =
    suiteData === undefined
      ? null
      : draftEvaluationPlan(suiteData.cases, mechanism === '' ? null : mechanism, budgetData);
  const deprecated = suiteData !== undefined && suiteData.workerDefinition.status !== 'published';
  const problems = draftCheckProblemsOf(error);
  const shortfall = budgetShortfallOf(error);
  const missing = [
    suiteId === '' ? t('选择用例集', 'choose a suite') : null,
    plan?.nothingToRun
      ? t('选一个有用例可跑的用例集或机制', 'choose a suite or mechanism with cases to run')
      : null,
    plan?.firstNotCovered
      ? t('等预算够第一个阶段', 'wait for budget to cover the first stage')
      : null,
    standing?.exhausted ? t('等评测预算重置', 'wait for the evaluation budget to reset') : null,
    deprecated
      ? t('用例集钉住的 Worker 版本已弃用', 'the suite’s pinned Worker version is deprecated')
      : null,
  ].filter((item): item is string => item !== null);
  const ready = suiteData !== undefined && budgetData !== null && missing.length === 0;

  function reset(): void {
    setSuiteId('');
    setMechanism('');
    setError(null);
  }

  function close(): void {
    reset();
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    if (!ready || suiteData === undefined) return;
    setSubmitting(true);
    setError(null);
    try {
      const evaluation = await http.call<DraftEvaluationWire>('start_draft_evaluation', {
        skillId: skill.id,
        version: skill.version,
        draftDigest: skill.draftDigest,
        suiteId: suiteData.id,
        suiteVersion: suiteData.version,
        ...(mechanism !== '' ? { mechanism } : {}),
      });
      reset();
      onStarted(evaluation);
    } catch (err) {
      setError(err);
      // The suite changed meanwhile: read it again, so the stages shown are the ones that would run.
      if (describeError(err).code === 'version_changed') setReads((n) => n + 1);
    } finally {
      setSubmitting(false);
      void budget.reload();
    }
  }

  const suiteRows = suites.status === 'ready' ? (suites.data ?? []) : undefined;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !submitting && (next ? onOpenChange(true) : close())}
    >
      <SheetContent data-testid="draft-eval-start" data-discard-guard>
        <SheetHeader>
          <SheetTitle>
            {t(`评测 ${skill.name} v${skill.version}`, `Evaluate ${skill.name} v${skill.version}`)}
          </SheetTitle>
          <SheetDescription>
            {inUseVersion !== undefined
              ? t(
                  `草稿组加载这个草稿，基线组加载在用的 v${inUseVersion}；两组用同一个钉住的 Worker 版本和同样的其他 Skill，跑用例集里的用例。对夹具门的调用由用例的夹具规则作答，不调用真实系统，不能出网。`,
                  `The draft arm loads this draft and the baseline arm v${inUseVersion}, the one in use; both run the suite’s cases on the same pinned Worker version with the same other Skills. Fixture gate calls are answered by the cases’ fixture rules: no real system is called and there is no network access.`,
                )
              : t(
                  '这是新 Skill：草稿组加载它，基线组是不加载它的同一个 Worker；两组跑用例集里的用例。对夹具门的调用由用例的夹具规则作答，不调用真实系统，不能出网。',
                  'A new Skill: the draft arm loads it and the baseline arm is the same Worker without it; both run the suite’s cases. Fixture gate calls are answered by the cases’ fixture rules: no real system is called and there is no network access.',
                )}
          </SheetDescription>
        </SheetHeader>

        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {suites.status === 'error' ? (
            <InlineError error={suites.error} testId="draft-eval-start-suites-error" />
          ) : suiteRows !== undefined && suiteRows.length === 0 ? (
            <Notice tone="warn" testId="draft-eval-start-no-suites">
              {t('工作区里还没有用例集。', 'The workspace has no evaluation suite yet.')}{' '}
              <RouteLink href={hrefs.evaluation('suites')} className="link-inline">
                {t('去新建一个', 'Create one')}
              </RouteLink>
            </Notice>
          ) : (
            <Field id="draft-eval-suite" label={t('用例集', 'Suite')} required>
              <Select
                id="draft-eval-suite"
                aria-label={t('用例集', 'Suite')}
                value={suiteId}
                disabled={submitting || suiteRows === undefined}
                onChange={(event) => {
                  setSuiteId(event.target.value);
                  setMechanism('');
                  setError(null);
                }}
                data-testid="draft-eval-start-suite"
              >
                <option value="">
                  {suiteRows === undefined
                    ? t('加载中…', 'Loading…')
                    : t('选择用例集', 'Choose a suite')}
                </option>
                {(suiteRows ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {t(
                      `${row.name}（v${row.version}，${row.caseCount} 条用例）`,
                      `${row.name} (v${row.version}, ${row.caseCount} case${row.caseCount === 1 ? '' : 's'})`,
                    )}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {suiteId !== '' && suite.status === 'loading' ? (
            <SkeletonRows count={2} label={t('正在读取用例集', 'Loading the suite')} />
          ) : null}
          {suite.status === 'error' ? (
            <InlineError error={suite.error} testId="draft-eval-start-suite-error" />
          ) : null}

          {suiteData !== undefined ? (
            <Field
              id="draft-eval-mechanism"
              label={t('机制', 'Mechanism')}
              hint={
                mechanisms.length === 0
                  ? t(
                      '这个用例集没有针对某个机制的用例，机制检验会跳过。',
                      'This suite has no case aimed at a mechanism, so the mechanism test is skipped.',
                    )
                  : t(
                      '这个草稿要修好的机制；选了就用针对它的用例检验草稿是不是真的修好了它。',
                      'The mechanism this draft is meant to fix; when chosen, the cases aimed at it test whether it really does.',
                    )
              }
            >
              <Select
                id="draft-eval-mechanism"
                aria-label={t('机制', 'Mechanism')}
                value={mechanism}
                disabled={submitting || mechanisms.length === 0}
                onChange={(event) => setMechanism(event.target.value)}
                data-testid="draft-eval-start-mechanism"
              >
                <option value="">
                  {t('不指定（跳过机制检验）', 'None (skip the mechanism test)')}
                </option>
                {mechanisms.map((entry) => (
                  <option key={entry.mechanism} value={entry.mechanism}>
                    {t(
                      `${entry.mechanism}（${entry.caseCount} 条用例）`,
                      `${entry.mechanism} (${entry.caseCount} case${entry.caseCount === 1 ? '' : 's'})`,
                    )}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {deprecated ? (
            <Notice tone="warn" testId="draft-eval-start-deprecated">
              {t(
                '这个用例集钉住的 Worker 版本已经弃用，不能评测。先到用例集换钉一个已发布的版本。',
                'This suite’s pinned Worker version is deprecated, so it cannot evaluate. Pin a published version on the suite first.',
              )}
            </Notice>
          ) : null}

          {plan !== null ? <PlanView plan={plan} t={t} /> : null}

          {budgetData !== null ? (
            <p className="text-3 text-small tabular" data-testid="draft-eval-start-budget">
              {budgetLine(budgetData, t)}
              {t('。', '. ')}
              {trialEstimateLine(budgetData, t)}
            </p>
          ) : budget.state.status === 'error' ? (
            <InlineError error={budget.state.error} testId="draft-eval-start-budget-error" />
          ) : null}
          {standing?.exhausted && budgetData !== null ? (
            <Notice tone="warn" testId="draft-eval-start-exhausted">
              {budgetSpentText(budgetData, t)} <RaiseBudgetHint isOwner={isOwner} />
            </Notice>
          ) : plan?.firstNotCovered ? (
            <Notice tone="warn" testId="draft-eval-start-short">
              {t(
                '本月剩下的评测预算不够跑第一个阶段，现在开始会被拒绝。',
                'What is left of this month’s evaluation budget does not cover the first stage, so a start would be refused.',
              )}{' '}
              <RaiseBudgetHint isOwner={isOwner} />
            </Notice>
          ) : plan?.laterMayBeSkipped ? (
            <Notice tone="warn" testId="draft-eval-start-later-short">
              {t(
                '按估算，剩下的预算可能撑不到后面的阶段。到时那个阶段不会启动，结论是「没有定论」（预算不够）；已经开始的阶段不会被中途停下。',
                'By the estimates, what is left may not reach the later stages. Such a stage is then not started and the verdict is Inconclusive (budget); a stage that has started is never stopped part-way.',
              )}
            </Notice>
          ) : null}
          {plan?.nothingToRun ? (
            <Notice tone="warn" testId="draft-eval-start-nothing">
              {mechanisms.length > 0 && mechanism === ''
                ? t(
                    '这个用例集只有针对机制的用例，不选机制就没有可跑的。选一个机制。',
                    'This suite only has cases aimed at a mechanism, so with none chosen there is nothing to run. Choose a mechanism.',
                  )
                : t(
                    '这个用例集还没有回归、机制或完整分区的用例，没有可跑的。先给它加用例。',
                    'This suite has no regression, mechanism or full case yet, so there is nothing to run. Add cases first.',
                  )}
            </Notice>
          ) : null}

          <p className="text-3 text-small">
            {t(
              '评测期间这个草稿不能丢弃、拒绝，也不会过期；评测会留下它当时的内容。',
              'While it runs the draft cannot be discarded, rejected or expire; the evaluation keeps its content as it was.',
            )}
          </p>

          {problems !== null ? (
            <Notice tone="danger" testId="draft-eval-start-check">
              <p>
                {t(
                  '草稿没有通过评测前的检查，什么也没有启动。改好下面几项（编辑草稿）后再评测：',
                  'The draft did not pass the check before an evaluation, and nothing was started. Fix these in the draft, then evaluate it:',
                )}
              </p>
              <ul>
                {problems.map((problem) => (
                  <li
                    key={problem.check}
                    data-testid="draft-eval-start-problem"
                    data-check={problem.check}
                  >
                    {draftCheckProblemText(problem, t)}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : shortfall !== null ? (
            <Notice tone="warn" testId="draft-eval-start-insufficient">
              {t(
                `第一个阶段预估 ${formatUsd(shortfall.estimateUsd)}，本月评测预算 ${formatUsd(shortfall.budgetUsd)} 已用 ${formatUsd(shortfall.spentUsd)}，不够，什么也没有启动。`,
                `The first stage is estimated at ${formatUsd(shortfall.estimateUsd)} and ${formatUsd(shortfall.spentUsd)} of the ${formatUsd(shortfall.budgetUsd)} monthly evaluation budget is spent, so nothing was started.`,
              )}{' '}
              <RaiseBudgetHint isOwner={isOwner} />
            </Notice>
          ) : error !== null ? (
            <InlineError
              error={error}
              overrides={draftEvaluationStartErrors(t)}
              testId="draft-eval-start-error"
            />
          ) : null}
        </form>

        <SheetFooter>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!ready || submitting}
            aria-busy={submitting || undefined}
            data-testid="draft-eval-start-submit"
          >
            {t('开始评测', 'Start evaluation')}
          </Button>
          <GuardedCancelButton variant="ghost" onCancel={close} disabled={submitting}>
            {t('取消', 'Cancel')}
          </GuardedCancelButton>
          <StillNeeded items={missing} hidden={submitting} testId="draft-eval-start-missing" />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function PlanView({ plan, t }: { readonly plan: DraftEvaluationPlan; readonly t: Translate }) {
  return (
    <div className="stack-s" data-testid="draft-eval-start-plan">
      <span className="text-2" style={{ fontWeight: 600 }}>
        {t('会怎么跑', 'What would run')}
      </span>
      <ol className="eval-suite-history">
        {plan.stages.map((stage) => (
          <li key={stage.stage} data-testid="draft-eval-start-stage" data-stage={stage.stage}>
            <span className="row-wrap">
              <span style={{ fontWeight: 600 }}>{stageName(stage.stage, t)}</span>
              {stage.skip !== null ? (
                <span className="text-3 text-small">{skipReasonText(stage.skip, t)}</span>
              ) : (
                <span className="text-2 text-small tabular">
                  {t(
                    `${stage.caseCount} 条用例 × 每组 ${stage.k} 次 × 两组 = ${stage.trials} 次试跑`,
                    `${stage.caseCount} case${stage.caseCount === 1 ? '' : 's'} × ${stage.k} per arm × 2 arms = ${stage.trials} trials`,
                  )}
                  {stage.estimateUsd !== null
                    ? t(
                        `，约 ${formatUsd(stage.estimateUsd)}`,
                        `, about ${formatUsd(stage.estimateUsd)}`,
                      )
                    : ''}
                </span>
              )}
              {stage.covered === false ? (
                <span className="text-warn text-small" data-testid="draft-eval-start-stage-short">
                  {t('预算可能不够', 'budget may not cover it')}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {!plan.nothingToRun ? (
        <p className="text-3 text-small tabular">
          {plan.estimateUsd !== null
            ? t(
                `每个阶段都通过的话一共 ${plan.trials} 次试跑，约 ${formatUsd(plan.estimateUsd)}；哪一阶段不过就停，花得更少。`,
                `If every stage passes: ${plan.trials} trials, about ${formatUsd(plan.estimateUsd)}; it stops at the first stage that fails, spending less.`,
              )
            : t(
                `每个阶段都通过的话一共 ${plan.trials} 次试跑。还没有算得出费用的试跑，估不出花费。`,
                `If every stage passes: ${plan.trials} trials. No trial with a known cost yet, so there is no estimate.`,
              )}
        </p>
      ) : null}
    </div>
  );
}
