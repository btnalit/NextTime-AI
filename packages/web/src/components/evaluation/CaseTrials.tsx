import type {
  EvalCaseWire,
  EvalFixtureGateWire,
  EvalRunSummaryWire,
  EvalRunWire,
  EvalSuiteWire,
  EvalTrialWire,
} from '@nexttime/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useResource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { assertionSentence } from '../../lib/eval-cases.js';
import {
  budgetStanding,
  callAnswerText,
  callTargetText,
  formatUsd,
  reportSummary,
  trialErrorText,
  trialOutcomeStatus,
  trialStartErrors,
} from '../../lib/eval-runs.js';
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  prettyJsonVisible,
} from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import {
  RaiseBudgetHint,
  budgetLine,
  budgetSpentText,
  trialEstimateLine,
  useEvalBudget,
  useIsOwner,
} from './EvalBudget.js';

/** How often a running trial is read again. */
const RUNNING_POLL_MS = 3000;

export interface CaseTrialsProps {
  readonly http: CapabilityCaller;
  readonly suite: EvalSuiteWire;
  readonly evalCase: EvalCaseWire;
}

/**
 * components/evaluation/CaseTrials (S10 E3-2a 「试跑」): a case's trial runs, in its sheet. 试跑
 * (a builder or the owner, a case the suite holds now) runs the case once as it would run now —
 * the pinned Worker version, its calls to the fixture gates answered by the case's fixture rules,
 * no real system called, no egress — after a confirm that says what it costs against this month's
 * evaluation budget; once the budget is spent the button is off and says why, before anything
 * starts. The latest run is shown whole and read again while it runs: its outcome, each assertion
 * as the case states it and whether it held, every fixture call in order with the rule that
 * answered it, the Worker's report, cost and tokens. Earlier runs of this case row are listed
 * below it and open in its place.
 *
 * The evaluation Task itself acts for the workspace's evaluation service principal, so only the
 * owner can open it under 任务; everyone else reads the trial here.
 */
export function CaseTrials({ http, suite, evalCase }: CaseTrialsProps) {
  const t = useT();
  const can = useRoleCan(http);
  const isOwner = useIsOwner(http);
  const budget = useEvalBudget(http);
  const loadRuns = useCallback(async () => {
    // This case's own 试跑 — not the draft evaluations' stages that ran it (草稿评测 shows those).
    const page = await http.call<{ items: readonly EvalRunSummaryWire[] }>('list_eval_runs', {
      suiteId: suite.id,
      caseId: evalCase.id,
      kind: 'case_trial',
    });
    return page.items;
  }, [http, suite.id, evalCase.id]);
  const runs = useResource(loadRuns);
  const [shownId, setShownId] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const runRows = runs.state.status === 'ready' ? runs.state.data : [];
  const selectedId = shownId ?? runRows[0]?.id ?? null;
  const live = evalCase.retiredInVersion === null;
  const canStart = live && can('start_eval_case_trial') !== false;
  const budgetData = budget.state.status === 'ready' ? budget.state.data : null;
  const standing = budgetData === null ? null : budgetStanding(budgetData);
  const reloadRuns = runs.reload;
  const reloadBudget = budget.reload;
  const onRunEnded = useCallback(() => {
    void reloadRuns();
    void reloadBudget();
  }, [reloadRuns, reloadBudget]);

  return (
    <section className="stack-s" data-testid="eval-case-trials">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <span className="section-title">{t('试跑', 'Trial runs')}</span>
        {canStart ? (
          <Confirm
            tier="medium"
            open={startOpen}
            onOpenChange={setStartOpen}
            anchor={
              <Button
                variant="secondary"
                size="s"
                disabled={standing === null || standing.exhausted}
                title={
                  standing?.exhausted && budgetData !== null
                    ? budgetSpentText(budgetData, t)
                    : standing === null
                      ? budget.state.status === 'error'
                        ? t(
                            '读不到本月评测预算，先在下面重试',
                            'Could not load this month’s evaluation budget; retry below',
                          )
                        : t('正在读取本月评测预算', 'Loading this month’s evaluation budget')
                      : undefined
                }
                onClick={() => setStartOpen(true)}
                data-testid="eval-case-trial-start"
              >
                {t('试跑', 'Try it')}
              </Button>
            }
            title={t(`试跑「${evalCase.title}」`, `Try “${evalCase.title}”`)}
            description={t(
              '用钉住的 Worker 版本把这条用例跑一次。它对夹具门的调用由上面的夹具规则作答，不会调用真实系统，也不能出网；它汇报后用断言判分。',
              'Runs this case once with the pinned Worker version. Its calls to the fixture gates are answered by the fixture rules above — no real system is called and it has no network access — and its report is judged by the assertions.',
            )}
            target={evalCase.title}
            impact={[
              t(
                `按 Worker v${suite.workerDefinition.version}、用例集 v${suite.version} 运行`,
                `Runs Worker v${suite.workerDefinition.version}, suite v${suite.version}`,
              ),
              ...(budgetData !== null
                ? [
                    budgetData.trialCostUsd === null
                      ? t(
                          '费用：还估不出来，计入本月评测预算',
                          'Cost: no estimate yet; counted against this month’s evaluation budget',
                        )
                      : t(
                          `费用约 ${formatUsd(budgetData.trialCostUsd)}，计入本月评测预算`,
                          `Costs about ${formatUsd(budgetData.trialCostUsd)}, counted against this month’s evaluation budget`,
                        ),
                    budgetLine(budgetData, t),
                  ]
                : []),
            ]}
            confirmLabel={t('开始试跑', 'Start')}
            onConfirm={async () => {
              try {
                const run = await http.call<EvalRunWire>('start_eval_case_trial', {
                  suiteId: suite.id,
                  suiteVersion: suite.version,
                  caseId: evalCase.id,
                });
                setShownId(run.id);
              } finally {
                void reloadRuns();
                void reloadBudget();
              }
            }}
            errorOverrides={trialStartErrors(t)}
            testId="eval-case-trial-confirm"
          >
            {standing?.short ? (
              <Notice tone="warn" testId="eval-case-trial-short">
                {t(
                  '本月剩余的评测预算可能不够这次试跑。已经开始的试跑不会被中途停下，所以可能稍微超出预算。',
                  'What is left of this month’s evaluation budget may not cover this trial. A trial that has started is not stopped part-way, so it may go slightly over.',
                )}
              </Notice>
            ) : null}
          </Confirm>
        ) : null}
      </div>
      <p className="text-3 text-small">
        {live
          ? t(
              '试跑用钉住的 Worker 版本把这条用例跑一次：调用夹具门由夹具规则作答，不调用真实系统，不能出网；跑完用断言判分。会花模型费用，计入本月评测预算。',
              'A trial runs this case once with the pinned Worker version: calls to the fixture gates are answered by the fixture rules, no real system is called and there is no network access; the assertions then judge it. It spends model cost against this month’s evaluation budget.',
            ) +
            (canStart
              ? ''
              : t(
                  '试跑由构建者或工作区所有者发起。',
                  ' A builder or a workspace owner starts trials.',
                ))
          : t(
              '这条用例已经不在用例集里，不能再试跑；下面是它之前的试跑。',
              'This case is no longer in the suite and cannot be tried again; its earlier trials are below.',
            )}
      </p>
      {live && budgetData !== null ? (
        <p className="text-3 text-small tabular" data-testid="eval-case-trial-budget">
          {budgetLine(budgetData, t)}
          {t('。', '. ')}
          {trialEstimateLine(budgetData, t)}
        </p>
      ) : null}
      {live && budget.state.status === 'error' ? (
        <ErrorBanner
          error={budget.state.error}
          title={t(
            '无法读取评测预算，暂时不能试跑',
            'Could not load the evaluation budget, so a trial cannot start yet',
          )}
          onRetry={() => void budget.reload()}
          testId="eval-case-trial-budget-error"
        />
      ) : null}
      {canStart && standing?.exhausted ? (
        <Notice tone="warn" testId="eval-case-trial-exhausted">
          {budgetData !== null ? budgetSpentText(budgetData, t) : null}{' '}
          <RaiseBudgetHint isOwner={isOwner} />
        </Notice>
      ) : null}

      {runs.state.status === 'loading' ? (
        <SkeletonRows count={2} label={t('正在加载试跑', 'Loading trial runs')} />
      ) : runs.state.status === 'error' ? (
        <ErrorBanner
          error={runs.state.error}
          title={t('无法加载试跑', 'Could not load trial runs')}
          onRetry={() => void runs.reload()}
          testId="eval-case-trials-error"
        />
      ) : selectedId === null ? (
        <p className="text-3" data-testid="eval-case-trials-empty">
          {t('还没有试跑过。', 'Not tried yet.')}
        </p>
      ) : (
        <>
          <RunResult
            key={selectedId}
            http={http}
            runId={selectedId}
            evalCase={evalCase}
            gates={suite.fixtureGates}
            isOwner={isOwner}
            onEnded={onRunEnded}
          />
          {runRows.length > 1 ? (
            <details className="disclosure" data-testid="eval-case-trials-earlier">
              <summary>
                {t(`全部试跑（${runRows.length}）`, `All trial runs (${runRows.length})`)}
              </summary>
              <ul className="eval-suite-history">
                {runRows.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    selected={run.id === selectedId}
                    onOpen={() => setShownId(run.id)}
                  />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function RunRow({
  run,
  selected,
  onOpen,
}: {
  readonly run: EvalRunSummaryWire;
  readonly selected: boolean;
  readonly onOpen: () => void;
}) {
  const t = useT();
  const status =
    run.running > 0
      ? 'running'
      : run.errored > 0
        ? 'errored'
        : run.failed > 0
          ? 'failed'
          : 'passed';
  return (
    <li data-testid="eval-case-trial-row" data-run-id={run.id}>
      <span className="row-wrap">
        <Button
          variant="ghost"
          size="s"
          aria-current={selected ? 'true' : undefined}
          onClick={onOpen}
          data-testid="eval-case-trial-open"
        >
          <time title={formatDateTime(run.createdAt)}>{formatRelative(run.createdAt)}</time>
        </Button>
        <StatusChip machine="evalTrial" status={status} size="s" />
        <span className="text-3 text-small tabular">
          {t(`用例集 v${run.suiteVersion}`, `suite v${run.suiteVersion}`)}
          {` · Worker v${run.workerDefinition.version}`}
          {run.costUsd !== null ? ` · ${formatUsd(run.costUsd)}` : ''}
        </span>
      </span>
    </li>
  );
}

/** One run whole, read again every few seconds while a trial of it runs. */
function RunResult({
  http,
  runId,
  evalCase,
  gates,
  isOwner,
  onEnded,
}: {
  readonly http: CapabilityCaller;
  readonly runId: string;
  readonly evalCase: EvalCaseWire;
  readonly gates: readonly EvalFixtureGateWire[];
  readonly isOwner: boolean;
  readonly onEnded: () => void;
}) {
  const t = useT();
  const load = useCallback(() => http.call<EvalRunWire>('get_eval_run', { runId }), [http, runId]);
  const run = useResource(load);
  const data = run.state.status === 'ready' ? run.state.data : null;
  const running = data?.status === 'running';
  const reload = run.reload;
  const state = run.state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each read, or failed re-read, of the run arms the next one
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => void reload(), RUNNING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [running, reload, state]);
  // The run ended while shown: the list and the budget move with it.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (data === null) return;
    if (running) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      onEnded();
    }
  }, [running, data, onEnded]);

  if (run.state.status === 'loading') {
    return <SkeletonRows count={3} label={t('正在读取试跑', 'Loading the trial run')} />;
  }
  if (run.state.status === 'error') {
    return (
      <ErrorBanner
        error={run.state.error}
        title={t('无法读取这次试跑', 'Could not load this trial run')}
        onRetry={() => void run.reload()}
        testId="eval-case-trial-error"
      />
    );
  }
  const trial = run.state.data.trials[0];
  if (trial === undefined) return null;
  return (
    <TrialView
      trial={trial}
      runAt={run.state.data.createdAt}
      evalCase={evalCase}
      gates={gates}
      isOwner={isOwner}
    />
  );
}

/** One trial whole: its outcome, assertions, fixture calls and report (E3-2b: a draft
 *  evaluation's trials open the same way, `DraftEvaluations`). */
export function TrialView({
  trial,
  runAt,
  evalCase,
  gates,
  isOwner,
}: {
  readonly trial: EvalTrialWire;
  readonly runAt: string;
  readonly evalCase: EvalCaseWire;
  readonly gates: readonly EvalFixtureGateWire[];
  readonly isOwner: boolean;
}) {
  const t = useT();
  const status = trialOutcomeStatus(trial);
  const summary = reportSummary(trial.result);
  return (
    <div className="stack-s" data-testid="eval-case-trial" data-status={status}>
      <span className="row-wrap">
        <StatusChip machine="evalTrial" status={status} testId="eval-case-trial-status" />
        <span className="text-3 text-small">
          <time title={formatDateTime(runAt)}>{formatRelative(runAt)}</time>
          {' · '}
          {formatDuration(trial.startedAt, trial.finishedAt ?? undefined)}
          {trial.finishedAt !== null ? (
            <>
              {' · '}
              <span className="tabular" data-testid="eval-case-trial-cost">
                {trial.costUsd === null
                  ? t('费用未知（模型没有价格）', 'cost unknown (the model has no price)')
                  : formatUsd(trial.costUsd)}
                {' · '}
                {t(
                  `${trial.tokens.toLocaleString()} token`,
                  `${trial.tokens.toLocaleString()} tokens`,
                )}
              </span>
            </>
          ) : null}
        </span>
        {isOwner && trial.taskId !== null ? (
          <RouteLink
            href={hrefs.task(trial.taskId)}
            className="link-inline"
            whenRefused="hide"
            testId="eval-case-trial-task"
          >
            {t('评测任务', 'Evaluation task')}
          </RouteLink>
        ) : null}
      </span>
      {trial.status === 'running' ? (
        <p className="text-3 text-small">
          {t(
            'Worker 正在跑。它汇报后会按断言判分，这里会自动刷新。',
            'The Worker is running. Once it reports, the assertions judge it and this updates on its own.',
          )}
        </p>
      ) : trial.status === 'queued' ? (
        <p className="text-3 text-small">
          {t(
            '排队中：评测服务同时只跑有限几个任务，轮到它就会开始。',
            'Queued: the evaluation service runs only so many tasks at once, and this one starts when its turn comes.',
          )}
        </p>
      ) : null}
      {trial.status === 'errored' && trial.error !== null ? (
        <Notice tone="warn" testId="eval-case-trial-errored">
          {trialErrorText(trial.error, t)}
        </Notice>
      ) : null}

      {trial.status === 'scored' ? (
        <section className="stack-s" data-testid="eval-case-trial-assertions">
          <span className="text-2" style={{ fontWeight: 600 }}>
            {t('断言', 'Assertions')}
          </span>
          <ol className="eval-suite-history">
            {trial.assertions.map((result) => {
              const assertion = evalCase.assertions[result.index];
              return (
                <li key={result.index} data-testid="eval-case-trial-assertion">
                  <span className="row-wrap">
                    <StatusChip machine="evalAssertion" status={result.outcome} size="s" />
                    <span className="wrap-anywhere">
                      {assertion !== undefined
                        ? assertionSentence(assertion, gates, t)
                        : t(`断言 ${result.index + 1}`, `Assertion ${result.index + 1}`)}
                    </span>
                  </span>
                  {result.note !== null ? (
                    <span className="text-3 text-small">{result.note}</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {trial.assertions.some((result) => result.outcome === 'undetermined') ? (
            <p className="text-3 text-small">
              {t(
                '「无法判断」是断言要读的值在汇报或调用里不存在，按不成立算。',
                '“Undetermined” means the value an assertion reads is not in the report or the calls; it counts as not holding.',
              )}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="stack-s" data-testid="eval-case-trial-calls">
        <span className="text-2" style={{ fontWeight: 600 }}>
          {t(`夹具调用（${trial.calls.length}）`, `Fixture calls (${trial.calls.length})`)}
        </span>
        {trial.calls.length === 0 ? (
          <p className="text-3 text-small">
            {trial.status === 'running' || trial.status === 'queued'
              ? t('还没有调用夹具门。', 'No fixture gate called yet.')
              : t('Worker 没有调用夹具门。', 'The Worker called no fixture gate.')}
          </p>
        ) : (
          <ol className="eval-suite-history">
            {trial.calls.map((call) => (
              <li key={call.seq} data-testid="eval-case-trial-call" data-answer={call.answer}>
                <span className="row-wrap">
                  <span className="tag tabular">{call.seq}</span>
                  <span className="mono wrap-anywhere">{callTargetText(call)}</span>
                </span>
                <span
                  className={`text-small${call.answer === 'unanswered' ? ' text-warn' : ' text-2'}`}
                >
                  {callAnswerText(call, t)}
                </span>
                {Object.keys(call.params).length > 0 ? (
                  <details className="disclosure">
                    <summary>{t('调用参数', 'Parameters')}</summary>
                    <pre className="code-block">{prettyJsonVisible(call.params)}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {trial.result !== null && trial.result !== undefined ? (
        <section className="stack-s" data-testid="eval-case-trial-report">
          <span className="text-2" style={{ fontWeight: 600 }}>
            {t('Worker 的汇报', 'The Worker’s report')}
          </span>
          {summary !== null ? <p className="pre-wrap wrap-anywhere">{summary}</p> : null}
          <details className="disclosure">
            <summary>{t('完整汇报', 'Full report')}</summary>
            <pre className="code-block">{prettyJsonVisible(trial.result)}</pre>
          </details>
        </section>
      ) : null}
    </div>
  );
}
