import type {
  DraftEvaluationCaseRowWire,
  DraftEvaluationMeasureWire,
  DraftEvaluationStageWire,
  DraftEvaluationSummaryWire,
  DraftEvaluationWire,
  EvalCaseWire,
  EvalRunWire,
  EvalSuiteWire,
  EvalTrialWire,
} from '@nexttime/shared';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type Resource, useResource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  cellText,
  costText,
  draftEvaluationOutcome,
  noOutcomeText,
  passRateText,
  pointsText,
  skipReasonText,
  stageName,
  stageResult,
  stageRuleText,
  tallyText,
  verdictReasonText,
} from '../../lib/draft-evaluations.js';
import { formatUsd, trialOutcomeStatus } from '../../lib/eval-runs.js';
import { pinnedWorkerName } from '../../lib/evaluation.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { nameOf } from '../approvals/useDirectoryNames.js';
import { MarkdownPreview } from '../catalog/MarkdownPreview.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue, type KeyValueItem } from '../kit/key-value.js';
import { List, ListRow } from '../kit/list-row.js';
import { MasterDetail, nothingToPick } from '../kit/master-detail.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { runEnvironmentRows } from '../run-environment-rows.js';
import { TrialView } from './CaseTrials.js';
import { useIsOwner } from './EvalBudget.js';
import { useLoadWhen } from './hooks.js';

/** How often a running evaluation is read again. */
const RUNNING_POLL_MS = 3000;

/** The summary fields of an evaluation read whole — what its list row shows. */
export function draftEvaluationSummaryOf(row: DraftEvaluationWire): DraftEvaluationSummaryWire {
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    verdict: row.verdict,
    reason: row.reason,
    decidedBy: row.decidedBy,
    costUsd: row.costUsd,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    cancelledBy: row.cancelledBy,
    suite: row.suite,
    workerDefinition: row.workerDefinition,
    candidate: row.candidate,
    baseline: row.baseline,
    mechanism: row.mechanism,
  };
}

/** "notes v3 vs v2" — what an evaluation compares, in a line. */
function comparisonText(
  row: Pick<DraftEvaluationSummaryWire, 'candidate' | 'baseline'>,
  t: Translate,
): string {
  const candidate = `${row.candidate.name} v${row.candidate.version}`;
  if (row.baseline === null) return t(`${candidate}（新 Skill）`, `${candidate} (new Skill)`);
  const baseline = `v${row.baseline.version}`;
  return t(`${candidate} 对比 ${baseline}`, `${candidate} vs ${baseline}`);
}

export interface DraftEvaluationsTabProps {
  readonly http: CapabilityCaller;
  readonly evaluations: Resource<readonly DraftEvaluationSummaryWire[]>;
  readonly evaluationId: string | undefined;
  readonly onSelect: (evaluationId: string | null) => void;
  readonly definitions: readonly WorkerDefinitionSummary[] | undefined;
  readonly principalNames: ReadonlyMap<string, string>;
  /** An evaluation moved on while shown (a stage, its verdict, its cancel): the budget moves too. */
  readonly onEvaluationChanged: () => void;
}

/**
 * components/evaluation/DraftEvaluations (S10 E3-2b): 评测 → 草稿评测 — the Skill draft
 * evaluations the reader may see (`list_draft_evaluations`: the draft's proposer and the draft
 * reviewers, or anyone once the draft is published as evaluated), newest first, and one whole
 * (`get_draft_evaluation`): what it compares, its three stages in order — the rule each is judged
 * by, its trials per arm, what it measured, the case × arm matrix with each trial a click away —
 * the verdict and why, and the environments its trials ran in (one, or the warning that they
 * differed). Read again every few seconds while it runs; a builder or the owner can cancel it.
 * Evaluations start from a Skill draft's detail (`catalog/SkillDraftEvaluations`).
 */
export function DraftEvaluationsTab({
  http,
  evaluations,
  evaluationId,
  onSelect,
  definitions,
  principalNames,
  onEvaluationChanged,
}: DraftEvaluationsTabProps) {
  const t = useT();
  const can = useRoleCan(http);
  const rows = evaluations.state.status === 'ready' ? evaluations.state.data : [];
  const mutate = evaluations.mutate;
  const onChanged = useCallback(
    (row: DraftEvaluationWire) => {
      const summary = draftEvaluationSummaryOf(row);
      mutate((current) =>
        current.some((item) => item.id === summary.id)
          ? current.map((item) => (item.id === summary.id ? summary : item))
          : [summary, ...current],
      );
      onEvaluationChanged();
    },
    [mutate, onEvaluationChanged],
  );

  return (
    <MasterDetail
      list={
        <EvaluationsList
          t={t}
          evaluations={evaluations}
          rows={rows}
          selectedId={evaluationId}
          onSelect={onSelect}
          canStart={can('start_draft_evaluation') !== false}
        />
      }
      detail={
        nothingToPick(evaluations.state.status, rows.length, evaluationId) ? null : evaluationId !==
          undefined ? (
          <DraftEvaluationDetail
            key={evaluationId}
            http={http}
            evaluationId={evaluationId}
            definitions={definitions}
            principalNames={principalNames}
            onChanged={onChanged}
          />
        ) : (
          <EmptyState
            title={t('还没有选择评测', 'No evaluation selected yet')}
            body={t(
              '选择左侧一次草稿评测，查看每个阶段的结果和结论。',
              'Pick a draft evaluation on the left to see each stage and its verdict.',
            )}
            testId="draft-eval-detail-empty"
          />
        )
      }
      open={evaluationId !== undefined}
      onClose={() => onSelect(null)}
      sheetTitle={t('草稿评测', 'Draft evaluation')}
      detailTestId="draft-eval-drawer"
    />
  );
}

function EvaluationsList({
  t,
  evaluations,
  rows,
  selectedId,
  onSelect,
  canStart,
}: {
  readonly t: Translate;
  readonly evaluations: Resource<readonly DraftEvaluationSummaryWire[]>;
  readonly rows: readonly DraftEvaluationSummaryWire[];
  readonly selectedId: string | undefined;
  readonly onSelect: (evaluationId: string | null) => void;
  /** Whether the reader may start one: only then does the empty state point at the catalog. */
  readonly canStart: boolean;
}) {
  if (evaluations.state.status === 'loading') {
    return (
      <SkeletonRows
        count={4}
        label={t('正在加载草稿评测', 'Loading draft evaluations')}
        testId="draft-evals-loading"
      />
    );
  }
  if (evaluations.state.status === 'error') {
    return (
      <ErrorBanner
        error={evaluations.state.error}
        title={t('无法加载草稿评测', 'Could not load draft evaluations')}
        onRetry={() => void evaluations.reload()}
        testId="draft-evals-error"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t('还没有草稿评测', 'No draft evaluation yet')}
        body={
          canStart ? (
            <>
              {t(
                '在能力目录打开一个 Skill 草稿，点「评测」，用一个用例集把它和要替换的版本比一比。你能看到的草稿的评测会列在这里。',
                'Open a Skill draft in the catalog and choose Evaluate to compare it with the version it would replace on a suite. Evaluations of drafts you can see are listed here.',
              )}{' '}
              <RouteLink href={hrefs.catalog('skills')} className="link-inline">
                {t('去能力目录', 'Go to the catalog')}
              </RouteLink>
            </>
          ) : (
            t(
              '评测由构建者或工作区所有者从 Skill 草稿发起；你能看到的草稿的评测会列在这里。',
              'A builder or the workspace owner starts an evaluation from a Skill draft; evaluations of drafts you can see are listed here.',
            )
          )
        }
        testId="draft-evals-empty"
      />
    );
  }
  return (
    <div className="stack-s">
      {evaluations.state.refreshError ? (
        <ErrorBanner
          error={evaluations.state.refreshError}
          onRetry={() => void evaluations.reload()}
        />
      ) : null}
      <List ariaLabel={t('草稿评测', 'Draft evaluations')} testId="draft-evals-list">
        {rows.map((row) => (
          <ListRow
            key={row.id}
            testId="draft-eval-row"
            selected={row.id === selectedId}
            onSelect={() => onSelect(row.id)}
          >
            <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <span className="truncate" style={{ fontWeight: 600 }}>
                {comparisonText(row, t)}
              </span>
              <StatusChip
                machine="draftEvaluation"
                status={draftEvaluationOutcome(row)}
                size="s"
                testId="draft-eval-row-outcome"
              />
            </span>
            <span className="row-wrap text-3">
              <span className="truncate">
                {row.suite.name} v{row.suite.version}
              </span>
              <span className="meta-sep" />
              <span>
                {row.status === 'running' && row.stage !== null
                  ? t(`进行中：${stageName(row.stage, t)}`, `Running: ${stageName(row.stage, t)}`)
                  : row.decidedBy !== null
                    ? t(
                        `由${stageName(row.decidedBy, t)}给出`,
                        `Decided by the ${stageName(row.decidedBy, t).toLowerCase()}`,
                      )
                    : null}
              </span>
              <span className="meta-sep" />
              <span className="tabular">{costText(row.costUsd, t)}</span>
              <span className="meta-sep" />
              <time title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</time>
            </span>
          </ListRow>
        ))}
      </List>
    </div>
  );
}

export interface DraftEvaluationDetailProps {
  readonly http: CapabilityCaller;
  readonly evaluationId: string;
  readonly definitions: readonly WorkerDefinitionSummary[] | undefined;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly onChanged: (row: DraftEvaluationWire) => void;
}

export function DraftEvaluationDetail({
  http,
  evaluationId,
  definitions,
  principalNames,
  onChanged,
}: DraftEvaluationDetailProps) {
  const t = useT();
  const can = useRoleCan(http);
  const isOwner = useIsOwner(http);
  const load = useCallback(
    () => http.call<DraftEvaluationWire>('get_draft_evaluation', { evaluationId }),
    [http, evaluationId],
  );
  const evaluation = useResource(load);
  const data = evaluation.state.status === 'ready' ? evaluation.state.data : null;
  const running = data?.status === 'running';
  const reload = evaluation.reload;
  const state = evaluation.state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each read, or failed re-read, of the evaluation arms the next one
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => void reload(), RUNNING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [running, reload, state]);
  // The list row and the budget move with what is shown.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (data === null) return;
    const key = `${data.status}:${data.stage ?? ''}:${data.costUsd ?? ''}`;
    if (shown.current !== null && shown.current !== key) onChanged(data);
    shown.current = key;
  }, [data, onChanged]);
  const [cancelOpen, setCancelOpen] = useState(false);

  if (evaluation.state.status === 'loading') {
    return <SkeletonRows count={4} label={t('正在读取草稿评测', 'Loading the draft evaluation')} />;
  }
  if (evaluation.state.status === 'error') {
    return (
      <ErrorBanner
        error={evaluation.state.error}
        title={t('无法读取这次草稿评测', 'Could not load this draft evaluation')}
        onRetry={() => void evaluation.reload()}
        testId="draft-eval-error"
      />
    );
  }
  const row = evaluation.state.data;
  const outcome = draftEvaluationOutcome(row);
  const workerName = pinnedWorkerName(definitions, row.workerDefinition);
  const who = (id: string) => nameOf(principalNames, id) ?? shortId(id);
  const items: KeyValueItem[] = [
    {
      key: 'suite',
      label: t('用例集', 'Suite'),
      value: (
        <RouteLink
          href={hrefs.evaluation('suites', row.suite.id)}
          className="link-inline"
          testId="draft-eval-suite-link"
        >
          {row.suite.name} v{row.suite.version}
        </RouteLink>
      ),
    },
    {
      key: 'worker',
      label: t('Worker', 'Worker'),
      value: `${workerName ?? shortId(row.workerDefinition.id)} v${row.workerDefinition.version}`,
    },
    {
      key: 'candidate',
      label: t('草稿（草稿组）', 'Draft (candidate arm)'),
      value: (
        <RouteLink
          href={hrefs.catalog('skills', row.candidate.skillId)}
          className="link-inline"
          whenRefused="text"
          testId="draft-eval-skill-link"
        >
          {row.candidate.name} v{row.candidate.version}
        </RouteLink>
      ),
    },
    {
      key: 'baseline',
      label: t('基线组', 'Baseline arm'),
      value:
        row.baseline === null
          ? t('新 Skill：同一个 Worker，不加载它', 'A new Skill: the same Worker without it')
          : t(`在用的 v${row.baseline.version}`, `v${row.baseline.version}, the one in use`),
    },
    {
      key: 'mechanism',
      label: t('机制', 'Mechanism'),
      value: row.mechanism ?? t('未指定（跳过机制检验）', 'None chosen (mechanism test skipped)'),
    },
    {
      key: 'others',
      label: t('两组都加载的其他 Skill', 'Other Skills both arms load'),
      value:
        row.otherSkills.length === 0
          ? t('无', 'None')
          : row.otherSkills.map((skill) => `${skill.name} v${skill.version}`).join('、'),
    },
    {
      key: 'started',
      label: t('发起', 'Started'),
      value: (
        <span>
          {who(row.createdBy)} ·{' '}
          <time title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</time>
        </span>
      ),
    },
    ...(row.finishedAt !== null
      ? [
          {
            key: 'finished',
            label: row.status === 'cancelled' ? t('取消', 'Cancelled') : t('结束', 'Ended'),
            value: (
              <span>
                {row.cancelledBy !== null ? `${who(row.cancelledBy)} · ` : ''}
                <time title={formatDateTime(row.finishedAt)}>{formatRelative(row.finishedAt)}</time>
              </span>
            ),
          },
        ]
      : []),
    {
      key: 'cost',
      label: t('花费', 'Cost'),
      value: <span className="tabular">{costText(row.costUsd, t)}</span>,
    },
  ];

  return (
    <div className="stack" data-testid="draft-eval-detail" data-status={row.status}>
      <header className="stack-s">
        <div className="row-wrap">
          <StatusChip machine="draftEvaluation" status={outcome} testId="draft-eval-outcome" />
          <strong className="wrap-anywhere">{comparisonText(row, t)}</strong>
        </div>
        {row.status === 'finished' && row.reason !== null ? (
          <p data-testid="draft-eval-reason">
            {verdictReasonText(row.reason, t)}
            {row.decidedBy !== null ? (
              <span className="text-3">
                {t(
                  `（由${stageName(row.decidedBy, t)}给出）`,
                  ` (decided by the ${stageName(row.decidedBy, t).toLowerCase()})`,
                )}
              </span>
            ) : null}
          </p>
        ) : row.status === 'running' ? (
          <p className="text-2" data-testid="draft-eval-running">
            {row.stage !== null
              ? t(
                  `正在跑${stageName(row.stage, t)}。一个阶段跑完才判下一步，这里每隔几秒自动刷新。`,
                  `Running the ${stageName(row.stage, t).toLowerCase()}. Each stage is judged once all its trials end; this refreshes every few seconds.`,
                )
              : null}{' '}
            {t(
              '评测结束或取消之前，这个草稿不能发布、丢弃或拒绝。',
              'Until it ends or is cancelled, the draft cannot be published, discarded or rejected.',
            )}
          </p>
        ) : row.status === 'cancelled' ? (
          <p className="text-2" data-testid="draft-eval-cancelled">
            {t(
              '评测被取消了，没有结论。已经跑完的试跑结果和花费保留在下面。',
              'The evaluation was cancelled, with no verdict. What its trials already measured, and their cost, stay below.',
            )}
          </p>
        ) : null}
        {row.status === 'running' && can('cancel_draft_evaluation') !== false ? (
          <div className="row-wrap">
            <Confirm
              tier="medium"
              open={cancelOpen}
              onOpenChange={setCancelOpen}
              anchor={
                <Button
                  variant="secondary"
                  size="s"
                  onClick={() => setCancelOpen(true)}
                  data-testid="draft-eval-cancel"
                >
                  {t('取消评测', 'Cancel evaluation')}
                </Button>
              }
              title={t('取消这次评测？', 'Cancel this evaluation?')}
              description={t(
                '排队的试跑作废，正在跑的评测任务被终止，后面的阶段不再开始，也不会给出结论。已经跑完的结果和花费保留。',
                'Queued trials are dropped, running evaluation tasks are terminated, no later stage starts, and there is no verdict. What already ran, and its cost, stay.',
              )}
              target={comparisonText(row, t)}
              danger
              confirmLabel={t('取消评测', 'Cancel evaluation')}
              cancelLabel={t('继续评测', 'Keep it running')}
              onConfirm={async () => {
                const next = await http.call<DraftEvaluationWire>('cancel_draft_evaluation', {
                  evaluationId: row.id,
                });
                evaluation.mutate(() => next);
                onChanged(next);
              }}
              errorOverrides={{
                conflict: t(
                  '这次评测刚好已经结束了，不用再取消。已重新读取。',
                  'This evaluation had already ended, so there is nothing to cancel. It has been read again.',
                ),
              }}
              testId="draft-eval-cancel-confirm"
            />
          </div>
        ) : null}
      </header>

      <KeyValue items={items} />

      <section className="stack" data-testid="draft-eval-stages">
        {row.stages.map((stage, index) => (
          <StageCard
            key={stage.stage}
            http={http}
            index={index}
            stage={stage}
            evaluation={row}
            isOwner={isOwner}
          />
        ))}
      </section>

      <Environments evaluation={row} workerName={workerName} t={t} />

      <section className="stack-s" data-testid="draft-eval-content">
        <span className="section-title">{t('评测的内容', 'What was evaluated')}</span>
        <p className="text-3 text-small">
          {t(
            '评测开始时的草稿和基线，草稿后来被改、发布或丢弃，这里都不变。',
            'The draft and the baseline as the evaluation started; they stay as they were whatever happens to the draft afterwards.',
          )}
        </p>
        <details className="disclosure" data-testid="draft-eval-candidate-content">
          <summary>
            {t(
              `草稿 v${row.candidate.version}：${row.candidateContent.name}`,
              `Draft v${row.candidate.version}: ${row.candidateContent.name}`,
            )}
          </summary>
          <p className="text-2">{row.candidateContent.description}</p>
          <MarkdownPreview markdown={row.candidateContent.markdown} />
        </details>
        {row.baselineContent !== null && row.baseline !== null ? (
          <details className="disclosure" data-testid="draft-eval-baseline-content">
            <summary>
              {t(
                `基线 v${row.baseline.version}：${row.baselineContent.name}`,
                `Baseline v${row.baseline.version}: ${row.baselineContent.name}`,
              )}
            </summary>
            <p className="text-2">{row.baselineContent.description}</p>
            <MarkdownPreview markdown={row.baselineContent.markdown} />
          </details>
        ) : null}
      </section>
    </div>
  );
}

function StageCard({
  http,
  index,
  stage,
  evaluation,
  isOwner,
}: {
  readonly http: CapabilityCaller;
  readonly index: number;
  readonly stage: DraftEvaluationStageWire;
  readonly evaluation: DraftEvaluationWire;
  readonly isOwner: boolean;
}) {
  const t = useT();
  const result = stageResult(stage, evaluation);
  const trials = 2 * stage.caseCount * stage.k;
  const ran = stage.baseline.trials + stage.candidate.trials > 0;
  return (
    <section
      className="stack-s draft-eval-stage"
      data-testid="draft-eval-stage"
      data-stage={stage.stage}
      data-status={stage.status}
    >
      <div className="row-wrap">
        <span className="section-title">
          {index + 1}. {stageName(stage.stage, t)}
        </span>
        <StatusChip
          machine="draftEvaluationStage"
          status={stage.status}
          size="s"
          testId="draft-eval-stage-status"
        />
        {result === 'passed' ? (
          <span className="text-ok text-small" data-testid="draft-eval-stage-passed">
            {t('通过，进入下一阶段', 'Passed; on to the next stage')}
          </span>
        ) : result === 'decided' ? (
          <span className="text-small" data-testid="draft-eval-stage-decided">
            {t('给出了结论', 'Gave the verdict')}
          </span>
        ) : null}
      </div>
      <p className="text-3 text-small">{stageRuleText(stage.stage, t)}</p>
      {stage.skipReason !== null ? (
        <p className="text-2 text-small" data-testid="draft-eval-stage-skip">
          {skipReasonText(stage.skipReason, t)}
        </p>
      ) : null}
      {stage.caseCount > 0 && stage.k > 0 ? (
        <p className="text-2 text-small tabular" data-testid="draft-eval-stage-plan">
          {t(
            `${stage.caseCount} 条用例 × 每组 ${stage.k} 次 × 两组 = ${trials} 次试跑`,
            `${stage.caseCount} case${stage.caseCount === 1 ? '' : 's'} × ${stage.k} per arm × 2 arms = ${trials} trials`,
          )}
          {stage.estimateUsd !== null
            ? t(`，预估 ${formatUsd(stage.estimateUsd)}`, `, about ${formatUsd(stage.estimateUsd)}`)
            : ''}
        </p>
      ) : null}
      {ran ? (
        <p className="text-small tabular" data-testid="draft-eval-stage-tally">
          {t('基线组', 'Baseline')} {tallyText(stage.baseline, t)}
          {t('；草稿组', '; draft')} {tallyText(stage.candidate, t)}
        </p>
      ) : null}
      {stage.measure !== null ? (
        <DraftEvaluationMeasure measure={stage.measure} stage={stage} t={t} />
      ) : null}
      {stage.cases.length > 0 && ran ? (
        <CaseMatrix
          http={http}
          stage={stage}
          suiteId={evaluation.suite.id}
          isOwner={isOwner}
          lostCaseIds={stage.measure?.stage === 'regression' ? stage.measure.lostCaseIds : []}
          unsettledCaseIds={
            stage.measure?.stage === 'regression' ? stage.measure.unsettledCaseIds : []
          }
        />
      ) : null}
    </section>
  );
}

/** What a stage's rule measured, in its own terms (also the publish review's evidence card,
 *  `catalog/SkillPublishReview`). */
export function DraftEvaluationMeasure({
  measure,
  stage,
  t,
}: {
  readonly measure: DraftEvaluationMeasureWire;
  readonly stage: DraftEvaluationStageWire;
  readonly t: Translate;
}) {
  switch (measure.stage) {
    case 'regression': {
      const titleOf = (id: string) =>
        stage.cases.find((row) => row.caseId === id)?.title ?? shortId(id);
      const lost = measure.lostCaseIds.map(titleOf);
      const unsettled = measure.unsettledCaseIds.map(titleOf);
      return (
        <div className="text-small stack-s" data-testid="draft-eval-measure">
          <p>
            {lost.length === 0
              ? t(
                  '没有一条回归用例草稿比基线通过得少。',
                  'On no regression case did the draft pass fewer times than the baseline.',
                )
              : t(
                  `草稿比基线通过得少的回归用例：${lost.join('、')}`,
                  `Regression cases the draft passed fewer times than the baseline: ${lost.join(', ')}`,
                )}
          </p>
          {unsettled.length > 0 ? (
            <p data-testid="draft-eval-measure-unsettled">
              {t(
                `定不下来的回归用例（没有结果的试跑能让它倒向任何一边）：${unsettled.join('、')}`,
                `Regression cases left open (trials without an outcome could tip them either way): ${unsettled.join(', ')}`,
              )}
            </p>
          ) : null}
        </div>
      );
    }
    case 'mechanism':
      return (
        <p className="text-small tabular" data-testid="draft-eval-measure">
          {t(
            `草稿组 ${passRateText(measure.candidatePassed, measure.candidateTrials)}${noOutcomeText(measure.candidateNoOutcome, t)}（要求全部通过），基线组 ${passRateText(measure.baselinePassed, measure.baselineTrials)}${noOutcomeText(measure.baselineNoOutcome, t)}（最多 ${measure.baselineMaxPassed} 次）。`,
            `Draft ${passRateText(measure.candidatePassed, measure.candidateTrials)}${noOutcomeText(measure.candidateNoOutcome, t)} (every try must pass); baseline ${passRateText(measure.baselinePassed, measure.baselineTrials)}${noOutcomeText(measure.baselineNoOutcome, t)} (at most ${measure.baselineMaxPassed}).`,
          )}
        </p>
      );
    case 'confirm': {
      const split = (label: string, value: typeof measure.dev) =>
        t(
          `${label}：草稿 ${passRateText(value.candidatePassed, value.candidateTrials)}${noOutcomeText(value.candidateNoOutcome, t)}，基线 ${passRateText(value.baselinePassed, value.baselineTrials)}${noOutcomeText(value.baselineNoOutcome, t)}，差 ${pointsText(value.difference)} 个百分点，下界 ${pointsText(value.lowerBound)}`,
          `${label}: draft ${passRateText(value.candidatePassed, value.candidateTrials)}${noOutcomeText(value.candidateNoOutcome, t)}, baseline ${passRateText(value.baselinePassed, value.baselineTrials)}${noOutcomeText(value.baselineNoOutcome, t)}, difference ${pointsText(value.difference)} points, lower bound ${pointsText(value.lowerBound)}`,
        );
      return (
        <ul className="text-small tabular stack-s" data-testid="draft-eval-measure">
          <li>{split('dev', measure.dev)}</li>
          <li>
            {measure.holdout === null
              ? t('holdout：用例集没有 holdout 用例', 'holdout: the suite has no holdout case')
              : split('holdout', measure.holdout)}
          </li>
          <li className="text-3">
            {t(
              `δ = ${Math.round(measure.delta * 100)} 个百分点，单侧 ${Math.round(measure.confidence * 100)}% 置信`,
              `δ = ${Math.round(measure.delta * 100)} points, one-sided ${Math.round(measure.confidence * 100)}% confidence`,
            )}
          </li>
        </ul>
      );
    }
  }
}

function CaseMatrix({
  http,
  stage,
  suiteId,
  isOwner,
  lostCaseIds,
  unsettledCaseIds,
}: {
  readonly http: CapabilityCaller;
  readonly stage: DraftEvaluationStageWire;
  readonly suiteId: string;
  readonly isOwner: boolean;
  readonly lostCaseIds: readonly string[];
  readonly unsettledCaseIds: readonly string[];
}) {
  const t = useT();
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  // The stage's run, read when a case row opens — and again when the stage's tallies move.
  const revision = [stage.baseline, stage.candidate]
    .map(
      (tally) => `${tally.passed}.${tally.failed}.${tally.errored}.${tally.voided}.${tally.open}`,
    )
    .join('|');
  const runId = stage.runId;
  const run = useLoadWhen(
    openCaseId !== null && runId !== null ? `${runId}@${revision}` : null,
    () => http.call<EvalRunWire>('get_eval_run', { runId: runId as string }),
  );
  return (
    <div className="table-scroll">
      <table className="data-table data-table-cards" data-testid="draft-eval-matrix">
        <thead>
          <tr>
            <th>{t('用例', 'Case')}</th>
            <th>{t('基线组', 'Baseline')}</th>
            <th>{t('草稿组', 'Draft')}</th>
            <th>
              <span className="visually-hidden">{t('试跑', 'Trials')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {stage.cases.map((row) => {
            const open = openCaseId === row.caseId;
            const mark = lostCaseIds.includes(row.caseId)
              ? 'lost'
              : unsettledCaseIds.includes(row.caseId)
                ? 'unsettled'
                : null;
            return (
              <MatrixRow
                key={row.caseId}
                row={row}
                open={open}
                mark={mark}
                onToggle={() => setOpenCaseId(open ? null : row.caseId)}
                t={t}
              >
                {open ? (
                  run.status === 'ready' && run.data !== undefined ? (
                    <CaseStageTrials
                      http={http}
                      suiteId={suiteId}
                      caseId={row.caseId}
                      run={run.data}
                      isOwner={isOwner}
                    />
                  ) : run.status === 'error' ? (
                    <ErrorBanner
                      error={run.error}
                      title={t('无法读取这个阶段的试跑', 'Could not load this stage’s trials')}
                      testId="draft-eval-run-error"
                    />
                  ) : (
                    <SkeletonRows count={2} label={t('正在读取试跑', 'Loading the trials')} />
                  )
                ) : null}
              </MatrixRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MatrixRow({
  row,
  open,
  mark,
  onToggle,
  t,
  children,
}: {
  readonly row: DraftEvaluationCaseRowWire;
  readonly open: boolean;
  /** How the regression rule read the case: lost, or left open by trials without an outcome. */
  readonly mark: 'lost' | 'unsettled' | null;
  readonly onToggle: () => void;
  readonly t: Translate;
  readonly children: ReactNode;
}) {
  return (
    <>
      <tr
        data-testid="draft-eval-matrix-row"
        data-case-id={row.caseId}
        data-lost={mark === 'lost' || undefined}
        data-unsettled={mark === 'unsettled' || undefined}
      >
        <td>
          <span className="row-wrap">
            <span className="wrap-anywhere">{row.title}</span>
            <span className="tag">{row.split}</span>
            {mark === 'lost' ? (
              <span className="text-warn text-small">{t('比基线少', 'fewer than baseline')}</span>
            ) : mark === 'unsettled' ? (
              <span className="text-3 text-small">{t('定不下来', 'left open')}</span>
            ) : null}
          </span>
        </td>
        <td className="tabular" data-label={t('基线组', 'Baseline')}>
          {cellText(row.baseline, t)}
        </td>
        <td className="tabular" data-label={t('草稿组', 'Draft')}>
          {cellText(row.candidate, t)}
        </td>
        <td>
          <Button
            variant="ghost"
            size="s"
            aria-expanded={open}
            onClick={onToggle}
            data-testid="draft-eval-matrix-open"
          >
            {open ? t('收起试跑', 'Hide trials') : t('看试跑', 'Show trials')}
          </Button>
        </td>
      </tr>
      {open ? (
        <tr data-testid="draft-eval-matrix-trials">
          <td colSpan={4}>{children}</td>
        </tr>
      ) : null}
    </>
  );
}

/** One case's trials in a stage, both arms, each opening whole (`TrialView`). */
function CaseStageTrials({
  http,
  suiteId,
  caseId,
  run,
  isOwner,
}: {
  readonly http: CapabilityCaller;
  readonly suiteId: string;
  readonly caseId: string;
  readonly run: EvalRunWire;
  readonly isOwner: boolean;
}) {
  const t = useT();
  const [openTrialId, setOpenTrialId] = useState<string | null>(null);
  const trials = run.trials
    .filter((trial) => trial.caseId === caseId)
    .sort((a, b) => (a.arm === b.arm ? a.rep - b.rep : a.arm === 'baseline' ? -1 : 1));
  // The case whole (its assertions) and the suite's fixture gates, read once a trial opens.
  const detail = useLoadWhen(openTrialId === null ? null : caseId, async () => {
    const [evalCase, suite] = await Promise.all([
      http.call<EvalCaseWire>('get_eval_case', { suiteId, caseId }),
      http.call<EvalSuiteWire>('get_eval_suite', { suiteId }),
    ]);
    return { evalCase, gates: suite.fixtureGates };
  });
  // The opened trial shows under its own row, not after the whole list (a mechanism stage runs
  // 20 tries — the content must appear where it was asked for).
  const openedContent = (trial: EvalTrialWire) =>
    detail.status === 'ready' && detail.data !== undefined ? (
      <TrialView
        trial={trial}
        runAt={run.createdAt}
        evalCase={detail.data.evalCase}
        gates={detail.data.gates}
        isOwner={isOwner}
      />
    ) : detail.status === 'error' ? (
      <ErrorBanner
        error={detail.error}
        title={t('无法读取这条用例', 'Could not load this case')}
        testId="draft-eval-trial-case-error"
      />
    ) : (
      <SkeletonRows count={2} label={t('正在读取用例', 'Loading the case')} />
    );
  return (
    <div className="stack-s" data-testid="draft-eval-case-trials">
      <ul className="eval-suite-history">
        {trials.map((trial) => (
          <li key={trial.id} data-testid="draft-eval-trial" data-arm={trial.arm}>
            <span className="row-wrap">
              <span>
                {trial.arm === 'baseline' ? t('基线组', 'Baseline') : t('草稿组', 'Draft')}{' '}
                {t(`第 ${trial.rep} 次`, `try ${trial.rep}`)}
              </span>
              <StatusChip machine="evalTrial" status={trialOutcomeStatus(trial)} size="s" />
              {trial.costUsd !== null ? (
                <span className="text-3 text-small tabular">{formatUsd(trial.costUsd)}</span>
              ) : null}
              <Button
                variant="ghost"
                size="s"
                aria-expanded={trial.id === openTrialId}
                onClick={() => setOpenTrialId(trial.id === openTrialId ? null : trial.id)}
                data-testid="draft-eval-trial-open"
              >
                {trial.id === openTrialId ? t('收起', 'Hide') : t('查看', 'Open')}
              </Button>
            </span>
            {trial.id === openTrialId ? openedContent(trial) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Environments({
  evaluation,
  workerName,
  t,
}: {
  readonly evaluation: DraftEvaluationWire;
  readonly workerName: string | undefined;
  readonly t: Translate;
}) {
  const environments = evaluation.environments;
  // As the kernel reads them: an environment not fully reported is checked before a second one.
  const unknown = environments.some((entry) => entry.environment.environmentDigest === null);
  return (
    <section className="stack-s" data-testid="draft-eval-environments">
      <span className="section-title">{t('运行环境', 'Environment')}</span>
      {environments.length === 0 ? (
        <p className="text-3 text-small">
          {t('还没有试跑报告运行环境。', 'No trial has reported its environment yet.')}
        </p>
      ) : unknown ? (
        <Notice tone="warn" testId="draft-eval-environments-unknown">
          {t(
            '有试跑没有完整上报运行环境（看下面的环境指纹），没法确认两组是在同一个环境里跑的。',
            'Some trials did not fully report their environment (see the environment fingerprint below), so the two arms cannot be shown to have run in one environment.',
          )}
          {evaluation.reason === 'environment_unknown'
            ? t('所以结论是「无法比较」。', ' That is why the verdict is Unmeasured.')
            : ''}
        </Notice>
      ) : environments.length > 1 ? (
        <Notice tone="warn" testId="draft-eval-environments-differ">
          {t(
            `试跑分别在 ${environments.length} 个运行环境里跑过（下面逐个列出），两组不能直接比较，结论是「无法比较」。等环境稳定后重新评测。`,
            `The trials ran in ${environments.length} environments (each listed below), so the two arms cannot be compared and the verdict is Unmeasured. Evaluate again once the environment is steady.`,
          )}
        </Notice>
      ) : (
        <p className="text-3 text-small">
          {t(
            '两组的所有试跑都在同一个运行环境里。',
            'Every trial of both arms ran in this one environment.',
          )}
        </p>
      )}
      {environments.map((entry, index) => (
        <div
          key={entry.environment.environmentDigest ?? index}
          className="stack-s"
          data-testid="draft-eval-environment"
        >
          <KeyValue
            items={[
              ...runEnvironmentRows(
                entry.environment,
                evaluation.workerDefinition.id,
                workerName,
                t,
              ),
              {
                key: 'trials',
                label: t('试跑', 'Trials'),
                value: t(
                  `基线组 ${entry.baselineTrials} 次，草稿组 ${entry.candidateTrials} 次`,
                  `baseline ${entry.baselineTrials}, draft ${entry.candidateTrials}`,
                ),
              },
            ]}
          />
        </div>
      ))}
    </section>
  );
}
