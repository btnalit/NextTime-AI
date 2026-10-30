import {
  type ObjectiveOutcomeWire,
  type OutputSchema,
  type RejectedOutputWire,
  type ReworkOfWire,
  type SkillLoadWire,
  visibleLines,
} from '@nexttime/shared';
import { type ReactNode, useState } from 'react';
import { useCanOpen } from '../hooks/useCanOpen.js';
import { auditHref } from '../lib/audit.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  prettyJsonVisible,
  redactSensitive,
  shortId,
} from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { taskFailureReasonText } from '../lib/labels.js';
import { hrefs } from '../lib/router.js';
import {
  type TaskSummary,
  type WorkerRunSummary,
  asResultContract,
  isCancellable,
  taskFinishedAt,
  taskNeed,
} from '../lib/tasks.js';
import { ProxyOutcomeNote } from './ProxyOutcomeNote.js';
import { LinkedApprovals } from './approvals/LinkedApprovals.js';
import { nameOf } from './approvals/useDirectoryNames.js';
import {
  OutputContractExplanation,
  OutputContractFields,
  OutputProblemList,
} from './goals/OutputContract.js';
import { Button } from './kit/button.js';
import { Confirm } from './kit/confirm.js';
import { KeyValue, type KeyValueItem } from './kit/key-value.js';
import { RedactedNote } from './kit/redacted-note.js';
import { RefChip } from './kit/ref-chip.js';
import { RouteLink } from './kit/route-link.js';
import { StatusChip } from './kit/status-chip.js';
import { runEnvironmentRows } from './run-environment-rows.js';

export interface TaskDetailProps {
  readonly task: TaskSummary;
  readonly definitionName: string | undefined;
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly principalNames?: ReadonlyMap<string, string>;
  /** Absent when the reader cannot open an approval (`hooks/useCanOpen`): no entry leads there. */
  readonly onOpenApproval?: (actionRequestId: string) => void;
  /** The confirmed cancel — throws so the confirm stays open with the kernel's error (`kit/confirm`
   *  renders it inline; there is no separate parent-level error banner any more, S8 W1-A7). */
  readonly onCancel: (task: TaskSummary) => Promise<void>;
  /** `false` hides 取消任务 for a role that may not `cancel_task` (#541 review M3). */
  readonly canCancel?: boolean;
}

/**
 * components/TaskDetail (console redesign P3-4 part B, on `components/kit/*` only — no more
 * `components/ui/*` imports, following `approvals/ApprovalDetail`'s own P3-4 part A rewrite):
 * one Task — identity (`kit/ref-chip`), budget, the result contract (S2.9 shape when it matches,
 * raw JSON otherwise), WorkerRuns (`kit/table`), linked approvals, and Cancel while the shared
 * Task transition table allows it (`lib/tasks.ts` `isCancellable`). Rendered as the master-detail
 * pane's (wide layout) / `kit/sheet`'s (narrow layout) detail content — `TasksPage` decides which.
 *
 * S6-A (C28 / B3 / B4 / §5.5): "关联审批" is `approvals/LinkedApprovals` over
 * `list_action_requests{taskId}` (decided rows included, paged); the on-behalf-of principal and
 * the WorkerDefinition are `kit/ref-chip`s (names from the directory hooks / `list_worker_
 * definitions`); "查看溯源" links open the audit page pre-filtered on this Task (`resourceType:
 * 'task'`) or on one WorkerRun (`resourceType: 'worker_run'` — `application/task/
 * transition-log.ts` writes both); Cancel is a `kit/confirm` `medium` popover (S8 W1-A7, audit
 * S13) anchored to the Cancel button itself, owned locally — the confirmation used to be a
 * page-level sibling of the detail drawer (tier `high`); now that `medium` is a Popover anchored
 * to its own trigger there is no separate surface to route Escape/focus through, so the confirm
 * lives exactly where its button does.
 *
 * S11 GO5d-1: for an attempt of a goal step, 输出约定 — the fields its result's output must carry,
 * the last report that contract refused (each place, and the output as sent, masked), and, when it
 * redoes an earlier attempt that handed back no accepted result, a link to that attempt's Task and
 * where its last report broke the contract.
 *
 * S11 W1a: 运行环境 under the runs — for each run, what it ran with (WorkerDefinition version,
 * model, platform build, runtime image, the system prompt's digest — never the prompt). A proxy
 * outcome (an agent's own report) says it is not counted toward attainment.
 */
export function TaskDetail({
  task,
  definitionName,
  http,
  pushes,
  principalNames,
  onOpenApproval,
  onCancel,
  canCancel = false,
}: TaskDetailProps) {
  const t = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const finished = taskFinishedAt(task);
  const contract = asResultContract(task.result);
  const need = taskNeed(task.input);
  const budgetPct =
    task.tokenBudget && task.tokenBudget > 0
      ? Math.min(100, Math.round((task.tokensUsed / task.tokenBudget) * 100))
      : null;
  const runningRuns = task.workerRuns.filter((run) => run.terminatedAt === null).length;
  const tokensUsedText = task.tokensUsed.toLocaleString();
  const provenance = auditHref({ resourceType: 'task', resourceId: task.id });
  const canOpen = useCanOpen();
  const attributionItems = attributionRows(task, principalNames, t);

  const overviewItems: KeyValueItem[] = [
    {
      key: 'definition',
      label: t('定义', 'Definition'),
      value: (
        <RefChip
          kind="workerDefinition"
          id={task.workerDefinitionId}
          name={definitionName ? `${definitionName} v${task.workerDefinitionVersion}` : null}
          href={hrefs.catalog('workers')}
          size="s"
          testId="task-definition"
        />
      ),
    },
    {
      key: 'onBehalfOf',
      label: t('代表', 'On behalf of'),
      value: (
        <RefChip
          kind="principal"
          id={task.onBehalfOf}
          name={
            // S10 E3-2a: an evaluation Task acts for the workspace's evaluation service principal,
            // whose `__…__` name is internal.
            task.purpose === 'evaluation'
              ? t('评测服务', 'Evaluation service')
              : nameOf(principalNames, task.onBehalfOf)
          }
          size="s"
          testId="task-on-behalf-of"
        />
      ),
    },
    ...(task.purpose === 'evaluation'
      ? [
          {
            key: 'purpose',
            label: t('用途', 'Purpose'),
            value: (
              <span className="stack-s" data-testid="task-purpose">
                <span>{t('评测试跑', 'Evaluation trial')}</span>
                <span className="text-3 text-small">
                  {t(
                    '这个任务是一次评测试跑：Worker 只能读自己的任务、调用用例集的夹具门（由用例的夹具规则作答，不调用真实系统）和汇报结果，不能出网；结果和判分在「治理 → 评测」的用例里查看，不进入知识图谱，也不计入技能的使用统计。',
                    'This task is an evaluation trial: its Worker can only read its own task, call the suite’s fixture gates (answered by the case’s fixture rules, never a real system) and report, with no network access. Its result and verdict are on the case under Govern → Evaluation; nothing from it enters the knowledge graph or a Skill’s usage statistics.',
                  )}
                </span>
              </span>
            ),
          },
        ]
      : []),
    {
      key: 'createdAt',
      label: t('创建', 'Created'),
      value: (
        <>
          <time title={formatDateTime(task.createdAt)}>{formatRelative(task.createdAt)}</time>
          <span className="text-3"> · {formatDateTime(task.createdAt)}</span>
        </>
      ),
    },
    {
      key: 'elapsed',
      label: finished ? t('结束', 'Finished') : t('已用时', 'Elapsed'),
      value: (
        <>
          {finished ? `${formatDateTime(finished)} · ` : ''}
          {formatDuration(task.createdAt, finished)}
          {task.durationLimitSec ? (
            <span className="text-3">
              {' '}
              {t('/ 上限', 'limit')} {task.durationLimitSec}s
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: 'tokens',
      label: 'Token',
      value: (
        <div className="stack-s">
          <span className="tabular">
            {task.tokensUsed.toLocaleString()}
            {task.tokenBudget ? ` / ${task.tokenBudget.toLocaleString()}` : ` ${t('已用', 'used')}`}
          </span>
          {budgetPct !== null ? (
            <span className={`quota-bar${budgetPct >= 80 ? ' quota-bar-warn' : ''}`}>
              <span style={{ width: `${budgetPct}%` }} />
            </span>
          ) : null}
        </div>
      ),
    },
  ];
  // S11 GO11: a Task that fixes what its Workers may read says so; one that sets no scope shows no row.
  if (task.observeScope) {
    const scope = task.observeScope;
    overviewItems.push({
      key: 'observeScope',
      label: t('观察范围', 'Observation scope'),
      value: (
        <span className="stack-s" data-testid="task-observe-scope">
          {scope.length > 0 ? (
            <span className="row-wrap">
              {scope.map((gatekeeperId) => (
                <RefChip
                  key={gatekeeperId}
                  kind="gatekeeper"
                  id={gatekeeperId}
                  http={http}
                  size="s"
                  testId="task-observe-scope-gate"
                />
              ))}
            </span>
          ) : null}
          <span className="text-3 text-small">
            {scope.length > 0
              ? t(
                  '这个任务的 Worker 只能读取这些门，创建任务时定下，不会改变。',
                  "This task's Workers can read only through these gatekeepers. Set when the task was created; it never changes.",
                )
              : t(
                  '这个任务的 Worker 不能读取任何门，创建任务时定下，不会改变。',
                  "This task's Workers cannot read through any gatekeeper. Set when the task was created; it never changes.",
                )}
          </span>
        </span>
      ),
    });
  }
  if (task.failureReason) {
    overviewItems.push({
      key: 'failure',
      label: <span className="text-danger">{t('失败原因', 'Failure')}</span>,
      value: (
        <span className="stack-s" data-testid="task-detail-failure-reason">
          <span className="text-danger">{taskFailureReasonText(task.failureReason, t).short}</span>
          <span className="text-3">{taskFailureReasonText(task.failureReason, t).detail}</span>
        </span>
      ),
    });
  }

  return (
    <div className="stack" data-testid="task-detail" data-task-id={task.id}>
      <header className="stack-s">
        <div className="row-wrap">
          <StatusChip machine="task" status={task.status} size="s" />
          <RefChip kind="task" id={task.id} name={t('本任务', 'This task')} size="s" />
          {canCancel && isCancellable(task.status) ? (
            <Confirm
              tier="medium"
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              anchor={
                <Button
                  variant="danger"
                  size="s"
                  onClick={() => setConfirmOpen(true)}
                  style={{ marginLeft: 'auto' }}
                  data-testid="task-cancel"
                >
                  {t('取消任务', 'Cancel task')}
                </Button>
              }
              title={t('取消任务', 'Cancel task')}
              description={t(
                '取消后任务进入 cancelled，正在运行的 WorkerRun 会被终止；已写入的事实与审计不受影响。',
                'The Task becomes cancelled and its running WorkerRuns are terminated; facts already written and the audit trail stay.',
              )}
              target={definitionName ?? task.id}
              impact={[
                t(`任务 ${task.id}`, `Task: ${task.id}`),
                t(`运行中的 WorkerRun ${runningRuns}`, `Running runs: ${runningRuns}`),
                t(`已用 Token ${tokensUsedText}`, `Tokens used: ${tokensUsedText}`),
                t('取消后不能恢复；需要时重新委派', 'Cannot be resumed — delegate again if needed'),
              ]}
              confirmLabel={t('确认取消', 'Cancel task')}
              danger
              onConfirm={() => onCancel(task)}
              testId="task-cancel-confirm"
            />
          ) : null}
        </div>
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <h2 className="task-detail-title">{definitionName ?? t('任务', 'Task')}</h2>
          {canOpen(provenance) !== false ? (
            <Button variant="secondary" size="s" asChild>
              <a href={provenance} data-testid="task-provenance-link">
                {t('查看溯源', 'View provenance')}
              </a>
            </Button>
          ) : null}
        </div>
        {/* Legacy 428: free text under the same rule as a goal's statement — characters nobody
         *  can see are shown as \u{…}, line breaks kept. */}
        {need ? <p className="pre-wrap">{visibleLines(need)}</p> : null}
        <RedactedNote value={need} testId="task-need-redacted" />
      </header>

      <section className="stack-s">
        <span className="section-title">{t('概览', 'Overview')}</span>
        <KeyValue items={overviewItems} />
      </section>

      <section className="stack-s" data-testid="task-attribution">
        <span className="section-title">{t('结果归因', 'Attribution')}</span>
        <KeyValue items={attributionItems} />
      </section>

      {contract ? (
        <div className="stack-s">
          <span className="section-title">{t('结果', 'Result')}</span>
          <p className="pre-wrap">{contract.summary}</p>
          {contract.findings.length > 0 ? (
            <ul className="finding-list">
              {contract.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          ) : null}
          <RedactedNote value={task.result} testId="task-result-redacted" />
          <div className="row-wrap text-small text-3">
            <span>
              {contract.factsToAssert.length} {t('条事实', 'facts written')}
            </span>
            <span className="meta-sep" />
            <span>
              {contract.evidence.length} {t('条证据', 'evidence refs')}
            </span>
            <span className="meta-sep" />
            <span>
              {contract.artifacts.length} {t('个产物', 'artifacts')}
            </span>
            {contract.proposedOperations.length > 0 ? (
              <>
                <span className="meta-sep" />
                <span>
                  {contract.proposedOperations.length} {t('个提议的', 'Operation proposed')}
                </span>
              </>
            ) : null}
            {contract.proposedSkill !== undefined ? (
              <>
                <span className="meta-sep" />
                <span>{t('提议了一个', 'Skill proposed a Skill')}</span>
              </>
            ) : null}
          </div>
          {contract.factsToAssert.length > 0 ? (
            <details className="disclosure">
              <summary>{t('事实与证据', 'Facts and evidence')}</summary>
              <div className="disclosure-body">
                <pre className="code-block">
                  {prettyJsonVisible({
                    facts: contract.factsToAssert,
                    evidence: contract.evidence,
                  })}
                </pre>
              </div>
            </details>
          ) : null}
          {contract.artifacts.length > 0 ? (
            <details className="disclosure" data-testid="task-artifacts">
              <summary>{t('产物', 'Artifacts')}</summary>
              <div className="disclosure-body stack-s">
                {contract.artifacts.map((artifact, index) => (
                  <div
                    key={`${artifact.path}-${index}`}
                    className="stack-s"
                    data-testid="task-artifact-row"
                  >
                    <div className="row-wrap text-small">
                      <span className="mono">{artifact.path}</span>
                      {artifact.description ? (
                        <span className="text-3">— {artifact.description}</span>
                      ) : null}
                    </div>
                    {artifact.content !== undefined ? (
                      <pre className="code-block">{artifact.content}</pre>
                    ) : (
                      <p className="text-3 text-small">
                        {t(
                          '未随结果提交内容，容器已退出，无法再读取。',
                          'No content was submitted with the result, and the container it ran in is gone — not retrievable.',
                        )}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : task.result !== null && task.result !== undefined ? (
        <div className="stack-s">
          <span className="section-title">{t('结果', 'Result')}</span>
          <pre className="code-block">{prettyJsonVisible(task.result)}</pre>
          <RedactedNote value={task.result} testId="task-result-redacted" />
        </div>
      ) : null}

      {task.outputSchema || task.rejectedOutput || task.reworkOf ? (
        <OutputContractSection
          schema={task.outputSchema ?? null}
          rejected={task.rejectedOutput ?? null}
          reworkOf={task.reworkOf ?? null}
          t={t}
        />
      ) : null}

      {task.input !== null && task.input !== undefined && !need ? (
        <details className="disclosure">
          <summary>{t('输入', 'Input')}</summary>
          <div className="disclosure-body">
            <pre className="code-block">{prettyJsonVisible(task.input)}</pre>
            <RedactedNote value={task.input} testId="task-input-redacted" />
          </div>
        </details>
      ) : null}

      <div className="stack-s">
        <span className="section-title">{t('Worker 运行', 'Worker runs')}</span>
        {task.workerRuns.length === 0 ? (
          <span className="text-3 text-small">
            {t('尚未分配 WorkerRun。', 'No WorkerRun has been provisioned yet.')}
          </span>
        ) : (
          // Legacy 401: eight columns — a native card table (styles/pages.css), so on a narrow
          // window each run is a card instead of a row scrolled sideways.
          <div className="table-scroll">
            <table className="data-table data-table-cards" data-testid="worker-runs-table">
              <thead>
                <tr>
                  <th>{t('运行', 'Run')}</th>
                  <th>{t('状态', 'Status')}</th>
                  <th>{t('深度', 'Depth')}</th>
                  <th>{t('尝试', 'Attempt')}</th>
                  <th>Skill</th>
                  <th>{t('开始', 'Started')}</th>
                  <th>{t('用时', 'Duration')}</th>
                  <th>{t('溯源', 'Provenance')}</th>
                </tr>
              </thead>
              <tbody>
                {task.workerRuns.map((run) => (
                  <tr key={run.id} data-testid="worker-run-row">
                    <td>
                      <span className="mono" title={run.id}>
                        {shortId(run.id)}
                      </span>
                    </td>
                    <td data-label={t('状态', 'Status')}>
                      <StatusChip machine="workerRun" status={run.status} size="s" />
                    </td>
                    <td className="tabular" data-label={t('深度', 'Depth')}>
                      {run.depth}
                    </td>
                    <td className="tabular" data-label={t('尝试', 'Attempt')}>
                      {run.attempt}
                    </td>
                    <td data-testid="worker-run-skills" data-label="Skill">
                      <SkillLoads skills={run.skills} t={t} />
                    </td>
                    <td data-label={t('开始', 'Started')}>
                      <time title={formatDateTime(run.startedAt)}>
                        {formatRelative(run.startedAt)}
                      </time>
                    </td>
                    <td className="tabular" data-label={t('用时', 'Duration')}>
                      {formatDuration(run.startedAt, run.terminatedAt)}
                    </td>
                    <td data-label={t('溯源', 'Provenance')}>
                      <RouteLink
                        href={auditHref({ resourceType: 'worker_run', resourceId: run.id })}
                        whenRefused="hide"
                        testId="worker-run-provenance-link"
                      >
                        {t('查看', 'View')}
                      </RouteLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {task.workerRuns.length > 0 ? (
          <RunEnvironments
            runs={task.workerRuns}
            definitionId={task.workerDefinitionId}
            definitionName={definitionName}
            t={t}
          />
        ) : null}
      </div>

      <div className="stack-s">
        <span className="section-title">{t('关联审批', 'Linked approvals')}</span>
        <LinkedApprovals
          http={http}
          pushes={pushes}
          taskId={task.id}
          principalNames={principalNames}
          onOpenApproval={onOpenApproval}
        />
      </div>
    </div>
  );
}

type Translate = ReturnType<typeof useT>;

/** 输出约定 of a goal step's attempt — see the component comment. */
function OutputContractSection({
  schema,
  rejected,
  reworkOf,
  t,
}: {
  readonly schema: OutputSchema | null;
  readonly rejected: RejectedOutputWire | null;
  readonly reworkOf: ReworkOfWire | null;
  readonly t: Translate;
}) {
  return (
    <section className="stack-s" data-testid="task-output-contract">
      <span className="section-title">{t('输出约定', 'Output contract')}</span>
      {schema ? <OutputContractExplanation t={t} /> : null}
      {reworkOf ? (
        <div className="stack-s" data-testid="task-rework-of">
          <span className="row-wrap text-small">
            <span>
              {t(
                `这次尝试重做第 ${reworkOf.attempt} 次尝试，那次没有交回平台接受的结果：`,
                `This attempt redoes attempt ${reworkOf.attempt}, which handed back no result the platform accepted:`,
              )}
            </span>
            <RefChip
              kind="task"
              id={reworkOf.taskId}
              href={hrefs.task(reworkOf.taskId)}
              size="s"
              testId="task-rework-of-link"
            />
          </span>
          {reworkOf.rejectedOutput ? (
            <>
              <span className="text-small text-3">
                {t(
                  `那次最后被拒的报告有 ${reworkOf.rejectedOutput.problemCount} 处不符合约定（Worker 这次读到了这些）：`,
                  `Its last refused report broke the contract in ${reworkOf.rejectedOutput.problemCount} place(s) (this attempt’s Worker was told):`,
                )}
              </span>
              <OutputProblemList
                problems={reworkOf.rejectedOutput.problems}
                problemCount={reworkOf.rejectedOutput.problemCount}
                t={t}
                testId="task-rework-of-problems"
              />
            </>
          ) : (
            <span className="text-small text-3">
              {t(
                '平台没有记下那次被输出约定拒绝的报告：它可能没有报告结果。',
                'The platform recorded no report of it that the output contract refused: it may never have reported a result.',
              )}
            </span>
          )}
        </div>
      ) : null}
      {schema ? (
        <OutputContractFields schema={schema} t={t} testId="task-output-fields" explain={false} />
      ) : null}
      {rejected ? (
        <div className="stack-s" data-testid="task-rejected-output">
          <span className="text-small text-warn">
            {t(
              `最后一次被拒的报告在 ${formatDateTime(rejected.at)}，有 ${rejected.problemCount} 处不符合约定：`,
              `The last refused report, at ${formatDateTime(rejected.at)}, broke the contract in ${rejected.problemCount} place(s):`,
            )}
          </span>
          <OutputProblemList
            problems={rejected.problems}
            problemCount={rejected.problemCount}
            t={t}
            testId="task-rejected-output-problems"
          />
          {rejected.output ? (
            <details className="disclosure">
              <summary>{t('被拒报告里的 output', 'The output that report carried')}</summary>
              <div className="disclosure-body stack-s">
                <pre className="code-block">
                  {prettyJsonVisible(redactSensitive(rejected.output))}
                </pre>
                <RedactedNote
                  value={redactSensitive(rejected.output)}
                  testId="task-rejected-output-redacted"
                />
              </div>
            </details>
          ) : (
            <span className="text-small text-3">
              {t('那次报告没有带 output。', 'That report carried no output.')}
            </span>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Shown wherever a field was never written — an old row, or a Task started outside a Turn. Never
 *  folded into "none": 未记录 says we do not know, "无" says we know it was empty. */
function NotRecorded({ t }: { readonly t: Translate }) {
  return <span className="text-3">{t('未记录', 'Not recorded')}</span>;
}

/** Whose judgement an outcome is reads from the wire's own `basis`, never from where it sits on
 *  the page: an agent's verify-step report is attributed to the agent acting for a person, not to
 *  that person. */
function OutcomeValue({
  outcome,
  principalNames,
  t,
}: {
  readonly outcome: ObjectiveOutcomeWire | null | undefined;
  readonly principalNames: ReadonlyMap<string, string> | undefined;
  readonly t: Translate;
}) {
  if (!outcome) return <NotRecorded t={t} />;
  const who = nameOf(principalNames, outcome.givenBy) ?? shortId(outcome.givenBy);
  const source =
    outcome.basis === 'agent_reported'
      ? t(`agent 校验步骤上报（代表 ${who}）`, `reported by the agent's verify step (for ${who})`)
      : t(`请求人 ${who} 判定`, `judged by the requester, ${who}`);
  const previous =
    outcome.revision === 2 && outcome.previousOutcome !== null
      ? outcome.previousOutcome === 'achieved'
        ? t('达成', 'achieved')
        : t('未达成', 'not achieved')
      : null;
  return (
    <span className="row-wrap" data-testid="outcome-value" data-basis={outcome.basis}>
      <StatusChip machine="objectiveOutcome" status={outcome.outcome} size="s" />
      <span className="text-3 text-small">
        {source} ·{' '}
        <time title={formatDateTime(outcome.givenAt)}>{formatRelative(outcome.givenAt)}</time>
        {previous ? ` · ${t('已更正，原为', 'corrected from')} ${previous}` : null}
      </span>
      <ProxyOutcomeNote basis={outcome.basis} />
    </span>
  );
}

/** S10 E1 结果归因 rows: the Task's own outcome (the delegating agent's verify step), its generating
 *  Turn, the Procedure that Turn claimed, and the requester's outcome for the Turn. */
function attributionRows(
  task: TaskSummary,
  principalNames: ReadonlyMap<string, string> | undefined,
  t: Translate,
): KeyValueItem[] {
  const turn = task.turn ?? null;
  let turnValue: ReactNode;
  if (!task.turnId) turnValue = <NotRecorded t={t} />;
  else if (turn === null)
    turnValue = (
      <span className="text-3">
        <span className="mono">{shortId(task.turnId)}</span> ·{' '}
        {t('所在对话对你不可见', 'in a chat you cannot see')}
      </span>
    );
  else
    turnValue = (
      <span className="row-wrap">
        {turn.chatId ? (
          <a href={hrefs.chat(turn.chatId)} className="mono" data-testid="task-turn-link">
            {shortId(turn.id)}
          </a>
        ) : (
          <span className="mono">{shortId(turn.id)}</span>
        )}
        <span className="text-3 text-small">
          <time title={formatDateTime(turn.startedAt)}>{formatRelative(turn.startedAt)}</time>
        </span>
      </span>
    );
  const procedure = turn?.procedure ?? null;
  return [
    {
      key: 'taskOutcome',
      label: t('任务目标结果', 'Task outcome'),
      value: <OutcomeValue outcome={task.objectiveOutcome} principalNames={principalNames} t={t} />,
    },
    { key: 'turn', label: t('所属 Turn', 'Turn'), value: turnValue },
    {
      key: 'procedure',
      label: t('流程', 'Procedure'),
      value:
        procedure === null ? (
          <NotRecorded t={t} />
        ) : (
          <span className="row-wrap">
            <span>
              {procedure.name} v{procedure.version}
            </span>
            <span
              className="turn-outcome-basis text-3 text-small"
              title={t(
                '入口 agent 自己报告的，内核没有核验它是否真的照做',
                'Reported by the entry agent itself; the kernel did not verify it was followed',
              )}
            >
              {t('agent 自报', 'agent-reported')}
            </span>
          </span>
        ),
    },
    {
      key: 'turnOutcome',
      label: t('Turn 目标结果', 'Turn outcome'),
      value: <OutcomeValue outcome={turn?.outcome} principalNames={principalNames} t={t} />,
    },
  ];
}

function SkillLoads({
  skills,
  t,
}: {
  readonly skills: readonly SkillLoadWire[] | null | undefined;
  readonly t: Translate;
}) {
  if (skills === null || skills === undefined) return <NotRecorded t={t} />;
  if (skills.length === 0) return <span className="text-3">{t('无', 'None')}</span>;
  return (
    <span className="text-small">
      {skills.map((skill, index) => (
        <span key={skill.skillId} title={skill.skillId} className="whitespace-nowrap">
          {index > 0 ? ', ' : null}
          {skill.name} v{skill.version}
        </span>
      ))}
    </span>
  );
}

/** 运行环境 — see the component comment. One block per run; a crash retry is a second run that may
 *  have started on another build. */
function RunEnvironments({
  runs,
  definitionId,
  definitionName,
  t,
}: {
  readonly runs: readonly WorkerRunSummary[];
  readonly definitionId: string;
  readonly definitionName: string | undefined;
  readonly t: Translate;
}) {
  return (
    <section className="stack-s" data-testid="run-environments">
      <span className="section-title">{t('运行环境', 'Run environment')}</span>
      {runs.length > 1 ? (
        <p className="text-small text-3" data-testid="run-environment-summary">
          {sameEnvironmentText(runs, t)}
          {t(
            '环境指纹相同，说明 Worker 定义版本、模型、运行时镜像、平台版本和系统提示都相同。',
            'The same fingerprint means the same Worker definition version, model, runtime image, platform version and system prompt.',
          )}
        </p>
      ) : null}
      {runs.map((run) => (
        <div key={run.id} className="stack-s" data-testid="run-environment" data-run={run.id}>
          {runs.length > 1 ? (
            <span className="text-small text-3">
              {t(
                `运行 ${shortId(run.id)} · 第 ${run.attempt} 次尝试`,
                `Run ${shortId(run.id)} · attempt ${run.attempt}`,
              )}
            </span>
          ) : null}
          {run.environment ? (
            <KeyValue
              items={runEnvironmentRows(run.environment, definitionId, definitionName, t)}
            />
          ) : (
            <span className="text-small" data-testid="run-environment-not-recorded">
              <NotRecorded t={t} />
              <span className="text-3">
                {t(
                  '：这次运行早于平台记录运行环境。',
                  ': this run predates the platform recording what runs ran with.',
                )}
              </span>
            </span>
          )}
        </div>
      ))}
    </section>
  );
}

/** For more than one run: which of them ran in the same environment, by their fingerprints. */
function sameEnvironmentText(runs: readonly WorkerRunSummary[], t: Translate): string {
  const byDigest = new Map<string, number[]>();
  const unknown: number[] = [];
  for (const run of runs) {
    const digest = run.environment?.environmentDigest ?? null;
    if (digest === null) unknown.push(run.attempt);
    else byDigest.set(digest, [...(byDigest.get(digest) ?? []), run.attempt]);
  }
  const groups = [...byDigest.values()];
  if (unknown.length === 0 && groups.length === 1)
    return t(
      `这 ${runs.length} 次运行的环境指纹相同。`,
      `All ${runs.length} runs have the same environment fingerprint. `,
    );
  const parts: string[] = [];
  for (const group of groups)
    if (group.length > 1)
      parts.push(
        t(
          `第 ${group.join('、')} 次尝试的环境指纹相同`,
          `attempts ${group.join(', ')} share a fingerprint`,
        ),
      );
  const singles = groups.filter((group) => group.length === 1).map((group) => group[0]);
  if (groups.length > 1 && singles.length > 0)
    parts.push(
      t(
        `第 ${singles.join('、')} 次尝试与其他几次不同`,
        `attempt(s) ${singles.join(', ')} differ from the others`,
      ),
    );
  if (unknown.length > 0)
    parts.push(
      t(
        `第 ${unknown.join('、')} 次尝试没有指纹，无法比较`,
        `attempt(s) ${unknown.join(', ')} have no fingerprint to compare`,
      ),
    );
  return t(`${parts.join('；')}。`, `${parts.join('; ')}. `);
}
