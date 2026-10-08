import type { ObjectiveOutcomeWire, SkillLoadWire } from '@nexttime/shared';
import { type ReactNode, useState } from 'react';
import { auditHref } from '../lib/audit.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  prettyJson,
  shortId,
} from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { hrefs } from '../lib/router.js';
import {
  type TaskSummary,
  asResultContract,
  isCancellable,
  taskFinishedAt,
  taskNeed,
} from '../lib/tasks.js';
import { LinkedApprovals } from './approvals/LinkedApprovals.js';
import { nameOf } from './approvals/useDirectoryNames.js';
import { Button } from './kit/button.js';
import { Confirm } from './kit/confirm.js';
import { KeyValue, type KeyValueItem } from './kit/key-value.js';
import { RefChip } from './kit/ref-chip.js';
import { StatusChip } from './kit/status-chip.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './kit/table.js';

export interface TaskDetailProps {
  readonly task: TaskSummary;
  readonly definitionName: string | undefined;
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly principalNames?: ReadonlyMap<string, string>;
  readonly onOpenApproval: (actionRequestId: string) => void;
  /** The confirmed cancel — throws so the confirm stays open with the kernel's error (`kit/confirm`
   *  renders it inline; there is no separate parent-level error banner any more, S8 W1-A7). */
  readonly onCancel: (task: TaskSummary) => Promise<void>;
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
 */
export function TaskDetail({
  task,
  definitionName,
  http,
  pushes,
  principalNames,
  onOpenApproval,
  onCancel,
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
          name={nameOf(principalNames, task.onBehalfOf)}
          size="s"
          testId="task-on-behalf-of"
        />
      ),
    },
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
  if (task.failureReason) {
    overviewItems.push({
      key: 'failure',
      label: <span className="text-danger">{t('失败原因', 'Failure')}</span>,
      value: <span className="text-danger">{task.failureReason}</span>,
    });
  }

  return (
    <div className="stack" data-testid="task-detail" data-task-id={task.id}>
      <header className="stack-s">
        <div className="row-wrap">
          <StatusChip machine="task" status={task.status} size="s" />
          <RefChip kind="task" id={task.id} name={null} size="s" />
          {isCancellable(task.status) ? (
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
          <Button variant="secondary" size="s" asChild>
            <a href={provenance} data-testid="task-provenance-link">
              {t('查看溯源', 'View provenance')}
            </a>
          </Button>
        </div>
        {need ? <p className="pre-wrap">{need}</p> : null}
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
                  {prettyJson({ facts: contract.factsToAssert, evidence: contract.evidence })}
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
          <pre className="code-block">{prettyJson(task.result)}</pre>
        </div>
      ) : null}

      {task.input !== null && task.input !== undefined && !need ? (
        <details className="disclosure">
          <summary>{t('输入', 'Input')}</summary>
          <div className="disclosure-body">
            <pre className="code-block">{prettyJson(task.input)}</pre>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('运行', 'Run')}</TableHead>
                <TableHead>{t('状态', 'Status')}</TableHead>
                <TableHead>{t('深度', 'Depth')}</TableHead>
                <TableHead>{t('尝试', 'Attempt')}</TableHead>
                <TableHead>Skill</TableHead>
                <TableHead>{t('开始', 'Started')}</TableHead>
                <TableHead>{t('用时', 'Duration')}</TableHead>
                <TableHead>{t('溯源', 'Provenance')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {task.workerRuns.map((run) => (
                <TableRow key={run.id} data-testid="worker-run-row">
                  <TableCell>
                    <span className="mono" title={run.id}>
                      {shortId(run.id)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusChip machine="workerRun" status={run.status} size="s" />
                  </TableCell>
                  <TableCell className="tabular">{run.depth}</TableCell>
                  <TableCell className="tabular">{run.attempt}</TableCell>
                  <TableCell data-testid="worker-run-skills">
                    <SkillLoads skills={run.skills} t={t} />
                  </TableCell>
                  <TableCell>
                    <time title={formatDateTime(run.startedAt)}>
                      {formatRelative(run.startedAt)}
                    </time>
                  </TableCell>
                  <TableCell className="tabular">
                    {formatDuration(run.startedAt, run.terminatedAt)}
                  </TableCell>
                  <TableCell>
                    <a
                      href={auditHref({ resourceType: 'worker_run', resourceId: run.id })}
                      data-testid="worker-run-provenance-link"
                    >
                      {t('查看', 'View')}
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
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

/** Shown wherever a field was never written — an old row, or a Task started outside a Turn. Never
 *  folded into "none": 未记录 says we do not know, "无" says we know it was empty. */
function NotRecorded({ t }: { readonly t: Translate }) {
  return <span className="text-3">{t('未记录', 'Not recorded')}</span>;
}

function OutcomeValue({
  outcome,
  principalNames,
  basis,
  t,
}: {
  readonly outcome: ObjectiveOutcomeWire | null | undefined;
  readonly principalNames: ReadonlyMap<string, string> | undefined;
  readonly basis: string;
  readonly t: Translate;
}) {
  if (!outcome) return <NotRecorded t={t} />;
  const previous =
    outcome.revision === 2 && outcome.previousOutcome !== null
      ? outcome.previousOutcome === 'achieved'
        ? t('达成', 'achieved')
        : t('未达成', 'not achieved')
      : null;
  return (
    <span className="row-wrap">
      <StatusChip machine="objectiveOutcome" status={outcome.outcome} size="s" />
      <span className="text-3 text-small">
        {basis} · {nameOf(principalNames, outcome.givenBy) ?? shortId(outcome.givenBy)} ·{' '}
        <time title={formatDateTime(outcome.givenAt)}>{formatRelative(outcome.givenAt)}</time>
        {previous ? ` · ${t('已更正，原为', 'corrected from')} ${previous}` : null}
      </span>
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
      value: (
        <OutcomeValue
          outcome={task.objectiveOutcome}
          principalNames={principalNames}
          basis={t('agent 校验', 'agent verify step')}
          t={t}
        />
      ),
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
      value: (
        <OutcomeValue
          outcome={turn?.outcome}
          principalNames={principalNames}
          basis={t('请求人', 'requester')}
          t={t}
        />
      ),
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
