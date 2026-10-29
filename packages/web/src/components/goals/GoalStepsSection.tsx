import type { GoalDetailWire, PlanHint, StepAcceptanceWire, StepRunWire } from '@nexttime/shared';
import { DEFAULT_MAX_ATTEMPTS } from '@nexttime/shared';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  formatDateTime,
  formatRelative,
  prettyJsonVisible,
  redactSensitive,
  shortId,
} from '../../lib/format.js';
import {
  type StepView,
  absenceBaselineOf,
  absenceOperationKey,
  actionFailureLabel,
  bindingSentence,
  checkKindLabel,
  factCheckSentence,
  goalSteps,
  isStepAuthorityHint,
  observationSentence,
  planHintKey,
  planHintText,
  reconciliationLabel,
  stepAcceptanceLabel,
  stepFailureText,
  stepHintChipLabel,
  stepWaitingReasonLabel,
} from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { taskFailureReasonText } from '../../lib/labels.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from '../kit/notice.js';
import { RedactedNote } from '../kit/redacted-note.js';
import { RefChip } from '../kit/ref-chip.js';
import { DashboardCard } from '../kit/section.js';
import { StatusChip } from '../kit/status-chip.js';
import { AbsenceBaselineLine, AbsenceBasis } from './AbsenceBasis.js';
import { ActionChip } from './ActionChip.js';
import { OutputContractFields, OutputProblemList } from './OutputContract.js';
import type { AbsenceOperations } from './useAbsenceOperations.js';

export interface GoalStepsSectionProps {
  readonly detail: GoalDetailWire;
  readonly http: CapabilityCaller;
  readonly gateNames: ReadonlyMap<string, string>;
  /** Legacy 470: the Objects the checks name by id, 「名字 · 类型」 (`useObjectLabels`). */
  readonly objectNames?: ReadonlyMap<string, string>;
  /** S11 「门确认不存在」 B: what each absence check rests on (`useAbsenceOperations`). */
  readonly absenceOperations?: AbsenceOperations;
}

/**
 * components/goals/GoalStepsSection (S11 GO6): the plan in force, step by step — its Worker, what
 * it depends on, where its StepRun stands (and, while waiting or failed, why), its attempts (the
 * Tasks), the actions it raised (the ActionRequests, each opening its approval), its own
 * acceptance checks and reconcile declarations as sentences, and its input. S11 GO5d-1: the inputs
 * it takes from earlier steps' outputs as sentences (「输入 host 来自步骤 scan 输出的 hosts[0]」),
 * its output contract, the output it handed back, and per attempt whether it was the one automatic
 * rework and where its last refused report broke the contract. Steps a revision
 * replaced are listed under their own disclosure, oldest first. While the run is proposed, what the
 * requester's authority would stop now (S11 GO5c hints) heads the card, and each step it names
 * carries a chip.
 */
export function GoalStepsSection({
  detail,
  http,
  gateNames,
  objectNames,
  absenceOperations,
}: GoalStepsSectionProps) {
  const t = useT();
  const { current, superseded } = goalSteps(detail);
  const acceptanceByRun = new Map(detail.acceptance.steps.map((step) => [step.stepRunId, step]));
  const authorityHints = detail.planRevision.hints.filter(isStepAuthorityHint);
  const hintsByStep = new Map<string, PlanHint[]>();
  for (const hint of authorityHints) {
    if (hint.stepKey === undefined) continue;
    hintsByStep.set(hint.stepKey, [...(hintsByStep.get(hint.stepKey) ?? []), hint]);
  }
  return (
    <DashboardCard title={t('步骤', 'Steps')} data-testid="goal-steps">
      {authorityHints.length > 0 ? (
        <div className="stack-s">
          {authorityHints.map((hint) => (
            <Notice key={planHintKey(hint)} tone="warn" testId="goal-step-hint">
              {planHintText(hint, t, gateNames)}
            </Notice>
          ))}
        </div>
      ) : null}
      <ol className="stack-s goal-steps">
        {current.map((view) => (
          <StepItem
            key={view.key}
            view={view}
            acceptance={view.run ? acceptanceByRun.get(view.run.id) : undefined}
            hints={hintsByStep.get(view.key) ?? []}
            http={http}
            gateNames={gateNames}
            objectNames={objectNames}
            absenceOperations={absenceOperations}
            detail={detail}
            t={t}
          />
        ))}
      </ol>
      {superseded.length > 0 ? (
        <details className="disclosure" data-testid="goal-steps-superseded">
          <summary>
            {t(
              `已被修订替换的步骤（${superseded.length}）`,
              `Steps a revision replaced (${superseded.length})`,
            )}
          </summary>
          <div className="disclosure-body">
            <ol className="stack-s goal-steps">
              {superseded.map((run) => (
                <StepItem
                  key={run.id}
                  view={{ key: run.stepKey, planStep: null, run }}
                  acceptance={acceptanceByRun.get(run.id)}
                  hints={[]}
                  http={http}
                  gateNames={gateNames}
                  objectNames={objectNames}
                  t={t}
                />
              ))}
            </ol>
          </div>
        </details>
      ) : null}
    </DashboardCard>
  );
}

interface StepItemProps {
  readonly view: StepView;
  readonly acceptance: StepAcceptanceWire | undefined;
  /** The step's own authority hints (S11 GO5c), shown as chips by its status. */
  readonly hints: readonly PlanHint[];
  readonly http: CapabilityCaller;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly objectNames: ReadonlyMap<string, string> | undefined;
  /** What the plan in force's absence checks rest on; a superseded step's are not shown. */
  readonly absenceOperations?: AbsenceOperations;
  /** S11 「门确认不存在」 B-c: the run, for the platform's look before the goal's work at each of
   *  the step's absence checks; a superseded step's are not shown. */
  readonly detail?: GoalDetailWire;
  readonly t: Translate;
}

function StepItem({
  view,
  acceptance,
  hints,
  http,
  gateNames,
  objectNames,
  absenceOperations,
  detail,
  t,
}: StepItemProps) {
  const { planStep, run } = view;
  const dependsOn = planStep?.dependsOn ?? [];
  const maxAttempts = planStep?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const failure = run?.failureCategory ? stepFailureText(run.failureCategory, t) : null;
  return (
    <li
      className="goal-step stack-s"
      data-testid="goal-step"
      data-step-key={view.key}
      data-step-status={run?.status ?? 'not_started'}
    >
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <span className="row-wrap">
          <strong className="mono">{view.key}</strong>
          {planStep ? (
            <>
              <RefChip
                kind="workerDefinition"
                id={planStep.worker.definitionId}
                http={http}
                size="s"
              />
              <span className="text-3 text-small">v{planStep.worker.version}</span>
            </>
          ) : null}
        </span>
        <span className="row-wrap">
          {[...new Set(hints.map((hint) => stepHintChipLabel(hint, t)))].map((label) =>
            label ? (
              <span key={label} className="chip chip-warn chip-s" data-testid="goal-step-hint-chip">
                {label}
              </span>
            ) : null,
          )}
          {run ? (
            <StatusChip machine="stepRun" status={run.status} size="s" />
          ) : (
            <span className="text-3 text-small">{t('尚未开始', 'Not started')}</span>
          )}
        </span>
      </div>

      <span className="text-small text-3">
        {dependsOn.length > 0
          ? t(`在这些步骤之后：${dependsOn.join('、')}`, `After: ${dependsOn.join(', ')}`)
          : t('没有前置步骤', 'No earlier step')}
        {run?.supersededInRevision
          ? t(
              ` · 第 ${run.introducedInRevision} 版引入，第 ${run.supersededInRevision} 版替换`,
              ` · introduced in v${run.introducedInRevision}, replaced in v${run.supersededInRevision}`,
            )
          : ''}
      </span>

      {planStep?.bindings ? (
        <ul className="stack-s" data-testid="goal-step-bindings">
          {planStep.bindings.map((binding, index) => (
            <li
              key={`${binding.to}-${index}`}
              className="text-small text-3"
              data-testid="goal-step-binding"
            >
              {bindingSentence(binding, t)}
            </li>
          ))}
        </ul>
      ) : null}

      {run?.waitingReason ? (
        <span className="text-small text-warn" data-testid="goal-step-waiting">
          {stepWaitingReasonLabel(run.waitingReason, t)}
        </span>
      ) : null}
      {failure ? (
        <span className="stack-s" data-testid="goal-step-failure">
          <span className="text-small text-danger">{failure.short}</span>
          <span className="text-small text-3">{failure.detail}</span>
        </span>
      ) : null}
      {acceptance?.state ? (
        <span
          className={`text-small ${acceptance.state === 'passed' ? 'text-3' : 'text-warn'}`}
          data-testid="goal-step-acceptance"
        >
          {stepAcceptanceLabel(acceptance.state, t)}
        </span>
      ) : null}

      {run ? <Attempts run={run} maxAttempts={maxAttempts} http={http} t={t} /> : null}
      {run && run.actions.length > 0 ? <Actions run={run} http={http} t={t} /> : null}

      {run?.output ? (
        <details className="disclosure" data-testid="goal-step-output">
          <summary>{t('这一步交回的输出', 'The output this step handed back')}</summary>
          <div className="disclosure-body stack-s">
            <pre className="code-block">{prettyJsonVisible(redactSensitive(run.output))}</pre>
            <RedactedNote value={redactSensitive(run.output)} testId="goal-step-output-redacted" />
          </div>
        </details>
      ) : null}
      {planStep?.outputSchema ? (
        <details className="disclosure" data-testid="goal-step-output-contract">
          <summary>{t('输出约定', 'Output contract')}</summary>
          <div className="disclosure-body">
            <OutputContractFields schema={planStep.outputSchema} t={t} />
          </div>
        </details>
      ) : null}

      {planStep?.acceptance ? (
        <details className="disclosure">
          <summary>
            {t(
              `这一步的验收检查（${planStep.acceptance.length}）`,
              `This step’s checks (${planStep.acceptance.length})`,
            )}
          </summary>
          <div className="disclosure-body">
            <ul className="stack-s">
              {planStep.acceptance.map((check) => {
                const latest = acceptance?.rounds
                  .at(-1)
                  ?.checks.find((candidate) => candidate.checkKey === check.key);
                return (
                  <li key={check.key} className="row-wrap" data-testid="goal-step-check">
                    {latest ? (
                      <StatusChip machine="goalCheck" status={latest.status} size="s" />
                    ) : null}
                    <span className="text-3 text-small">{checkKindLabel(check.kind, t)}</span>
                    <span>
                      {check.kind === 'fact_predicate'
                        ? factCheckSentence(check.fact, t, objectNames)
                        : observationSentence(
                            check.check,
                            gateNames.get(check.check.gatekeeperId) ?? null,
                            t,
                          )}
                    </span>
                    {check.kind === 'observe_absent' && absenceOperations ? (
                      <AbsenceBasis
                        http={http}
                        operation={absenceOperations.get(absenceOperationKey(check.check))}
                      />
                    ) : null}
                    {check.kind === 'observe_absent' && detail ? (
                      <AbsenceBaselineLine
                        baseline={absenceBaselineOf(detail, view.key, check.key)}
                        goalStatus={detail.status}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </details>
      ) : null}
      {planStep?.reconcile ? (
        <details className="disclosure">
          <summary>
            {t(
              `结果不明时平台怎么核对（${planStep.reconcile.length}）`,
              `How the platform checks an unknown outcome (${planStep.reconcile.length})`,
            )}
          </summary>
          <div className="disclosure-body">
            <ul className="stack-s">
              {planStep.reconcile.map((declaration, index) => (
                <li
                  key={`${declaration.action.gatekeeperId}-${declaration.action.operation}-${index}`}
                >
                  {t(
                    `对门「${gateLabel(gateNames, declaration.action.gatekeeperId)}」上的 ${declaration.action.operation}：`,
                    `For ${declaration.action.operation} on gate “${gateLabel(gateNames, declaration.action.gatekeeperId)}”: `,
                  )}
                  {observationSentence(
                    declaration.check,
                    gateNames.get(declaration.check.gatekeeperId) ?? null,
                    t,
                  )}
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
      {planStep?.input !== undefined ? (
        <details className="disclosure">
          <summary>{t('输入', 'Input')}</summary>
          <div className="disclosure-body">
            <pre className="code-block">{prettyJsonVisible(redactSensitive(planStep.input))}</pre>
          </div>
        </details>
      ) : null}
    </li>
  );
}

function gateLabel(names: ReadonlyMap<string, string>, gatekeeperId: string): string {
  return names.get(gatekeeperId) ?? shortId(gatekeeperId);
}

function Attempts({
  run,
  maxAttempts,
  http,
  t,
}: {
  readonly run: StepRunWire;
  readonly maxAttempts: number;
  readonly http: CapabilityCaller;
  readonly t: Translate;
}) {
  return (
    <div className="stack-s" data-testid="goal-step-attempts">
      <span className="text-small text-3 tabular">
        {t(
          `尝试 ${run.attemptCount}/${maxAttempts}`,
          `Attempts ${run.attemptCount}/${maxAttempts}`,
        )}
      </span>
      {run.attempts.map((attempt) => (
        <div key={attempt.taskId} className="stack-s" data-testid="goal-step-attempt">
          <span className="row-wrap text-small">
            <span className="text-3 tabular">#{attempt.attempt}</span>
            <RefChip
              kind="task"
              id={attempt.taskId}
              http={http}
              href={hrefs.task(attempt.taskId)}
              size="s"
            />
            <StatusChip machine="task" status={attempt.status} size="s" />
            {attempt.rework ? (
              <span className="chip chip-info chip-s" data-testid="goal-step-attempt-rework">
                {t('自动返工', 'Automatic rework')}
              </span>
            ) : null}
            {attempt.status === 'failed' && attempt.failureReason ? (
              <span className="text-danger" data-testid="goal-step-attempt-failure">
                {taskFailureReasonText(attempt.failureReason, t).short}
              </span>
            ) : null}
            <time className="text-3" title={formatDateTime(attempt.createdAt)}>
              {formatRelative(attempt.createdAt)}
            </time>
          </span>
          {attempt.rework ? (
            <span className="text-small text-3" data-testid="goal-step-attempt-rework-note">
              {t(
                '上一次尝试没有交回平台接受的结果，平台自动重做了这一次，并把被拒的原因告诉了 Worker。',
                'The attempt before it handed back no result the platform accepted, so the platform redid the step once and told the Worker what was refused.',
              )}
            </span>
          ) : null}
          {attempt.outputProblems && attempt.outputProblemCount > 0 ? (
            <div className="stack-s goal-step-attempt-problems">
              <span className="text-small text-warn">
                {t(
                  `最后一次被拒的报告有 ${attempt.outputProblemCount} 处不符合输出约定：`,
                  `Its last refused report broke the output contract in ${attempt.outputProblemCount} place(s):`,
                )}
              </span>
              <OutputProblemList
                problems={attempt.outputProblems}
                problemCount={attempt.outputProblemCount}
                t={t}
                testId="goal-step-attempt-problems"
              />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Actions({
  run,
  http,
  t,
}: {
  readonly run: StepRunWire;
  readonly http: CapabilityCaller;
  readonly t: Translate;
}) {
  return (
    <div className="stack-s" data-testid="goal-step-actions">
      <span className="text-small text-3">{t('提交的动作', 'Actions raised')}</span>
      {run.actions.map((action) => (
        <span
          key={action.actionRequestId}
          className="row-wrap text-small"
          data-testid="goal-step-action"
        >
          <ActionChip actionRequestId={action.actionRequestId} http={http} />
          {action.failureKind === 'outcome_unknown' ? (
            // Whether it took effect is the open question (待核对的动作), so it reads as unknown,
            // not as failed — as everywhere else in the console (`actionOutcomeChip`).
            <span className="chip chip-s chip-danger" data-testid="goal-step-action-unknown">
              {actionFailureLabel(action.failureKind, t)}
            </span>
          ) : (
            <>
              <StatusChip machine="actionRequest" status={action.status} size="s" />
              {action.failureKind ? (
                <span className="text-danger">{actionFailureLabel(action.failureKind, t)}</span>
              ) : null}
            </>
          )}
          {action.reconciliation ? (
            <span className="text-3">{reconciliationLabel(action.reconciliation, t)}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}
