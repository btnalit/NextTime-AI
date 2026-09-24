import { useState } from 'react';
import { auditHref } from '../lib/audit.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { formatDateTime, formatDuration, formatRelative, prettyJson } from '../lib/format.js';
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
import { Confirm } from './kit/confirm.js';
import { Button } from './ui/Button.js';
import { CopyId } from './ui/CopyId.js';
import { RefChip } from './ui/RefChip.js';
import { StatusChip } from './ui/StatusChip.js';

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
 * components/TaskDetail: one Task — identity and budget, the result contract (S2.9 shape when it
 * matches, raw JSON otherwise), WorkerRuns, linked approvals, and Cancel while the shared Task
 * transition table allows it (`lib/tasks.ts` `isCancellable`).
 *
 * S6-A (C28 / B3 / B4 / §5.5): "关联审批" is `approvals/LinkedApprovals` over
 * `list_action_requests{taskId}` (decided rows included, paged); the on-behalf-of principal and
 * the WorkerDefinition are `RefChip`s (names from the directory hooks / `list_worker_definitions`);
 * "查看溯源" links open the audit page pre-filtered on this Task (`resourceType: 'task'`) or on
 * one WorkerRun (`resourceType: 'worker_run'` — `application/task/transition-log.ts` writes both);
 * Cancel is a `kit/confirm` `medium` popover (S8 W1-A7, audit S13) anchored to the Cancel button
 * itself, owned locally — the confirmation used to be a page-level sibling of the detail drawer
 * (tier `high`); now that `medium` is a Popover anchored to its own trigger there is no separate
 * surface to route Escape/focus through, so the confirm lives exactly where its button does.
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

  return (
    <div className="stack" data-testid="task-detail" data-task-id={task.id}>
      <div className="row-wrap">
        <StatusChip machine="task" status={task.status} />
        <RefChip
          kind="workerDefinition"
          id={task.workerDefinitionId}
          name={definitionName ? `${definitionName} v${task.workerDefinitionVersion}` : null}
          href={hrefs.catalog('workers')}
          size="s"
          testId="task-definition"
        />
        {isCancellable(task.status) ? (
          <Confirm
            tier="medium"
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            anchor={
              <Button
                variant="danger"
                size="s"
                icon="stop"
                onClick={() => setConfirmOpen(true)}
                className="grow-0"
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
              `任务 Task: ${task.id}`,
              `运行中的 WorkerRun Running runs: ${runningRuns}`,
              `已用 Token Tokens used: ${task.tokensUsed.toLocaleString()}`,
              t('取消后不能恢复；需要时重新委派', 'Cannot be resumed — delegate again if needed'),
            ]}
            confirmLabel={t('确认取消', 'Cancel task')}
            danger
            onConfirm={() => onCancel(task)}
            testId="task-cancel-confirm"
          />
        ) : null}
      </div>

      {need ? <p className="pre-wrap">{need}</p> : null}

      <dl className="definition-list">
        <dt>{t('任务', 'Task')}</dt>
        <dd className="row-wrap">
          <CopyId id={task.id} label="task" />
          <a
            href={auditHref({ resourceType: 'task', resourceId: task.id })}
            data-testid="task-provenance-link"
          >
            {t('查看溯源', 'View provenance')}
          </a>
        </dd>
        <dt>{t('定义', 'Definition')}</dt>
        <dd className="row-wrap">
          <CopyId id={task.workerDefinitionId} label="worker definition" />
          <span className="text-3">v{task.workerDefinitionVersion}</span>
        </dd>
        <dt>{t('代表', 'On behalf of')}</dt>
        <dd>
          <RefChip
            kind="principal"
            id={task.onBehalfOf}
            name={nameOf(principalNames, task.onBehalfOf)}
            size="s"
            testId="task-on-behalf-of"
          />
        </dd>
        <dt>{t('创建', 'Created')}</dt>
        <dd>
          <time title={formatDateTime(task.createdAt)}>{formatRelative(task.createdAt)}</time>
          <span className="text-3"> · {formatDateTime(task.createdAt)}</span>
        </dd>
        <dt>{finished ? t('结束', 'Finished') : t('已用时', 'Elapsed')}</dt>
        <dd>
          {finished ? `${formatDateTime(finished)} · ` : ''}
          {formatDuration(task.createdAt, finished)}
          {task.durationLimitSec ? (
            <span className="text-3">
              {' '}
              {t('/ 上限', 'limit')} {task.durationLimitSec}s
            </span>
          ) : null}
        </dd>
        <dt>Token</dt>
        <dd className="stack-s">
          <span className="tabular">
            {task.tokensUsed.toLocaleString()}
            {task.tokenBudget ? ` / ${task.tokenBudget.toLocaleString()}` : ` ${t('已用', 'used')}`}
          </span>
          {budgetPct !== null ? (
            <span className={`quota-bar${budgetPct >= 80 ? ' quota-bar-warn' : ''}`}>
              <span style={{ width: `${budgetPct}%` }} />
            </span>
          ) : null}
        </dd>
        {task.failureReason ? (
          <>
            <dt>{t('失败原因', 'Failure')}</dt>
            <dd className="text-danger">{task.failureReason}</dd>
          </>
        ) : null}
      </dl>

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
          <table className="worker-run-table">
            <thead>
              <tr>
                <th>{t('运行', 'Run')}</th>
                <th>{t('状态', 'Status')}</th>
                <th>{t('深度', 'Depth')}</th>
                <th>{t('尝试', 'Attempt')}</th>
                <th>{t('开始', 'Started')}</th>
                <th>{t('用时', 'Duration')}</th>
                <th>{t('溯源', 'Provenance')}</th>
              </tr>
            </thead>
            <tbody>
              {task.workerRuns.map((run) => (
                <tr key={run.id} data-testid="worker-run-row">
                  <td>
                    <CopyId id={run.id} label="worker run" />
                  </td>
                  <td>
                    <StatusChip machine="workerRun" status={run.status} size="s" />
                  </td>
                  <td className="tabular">{run.depth}</td>
                  <td className="tabular">{run.attempt}</td>
                  <td>
                    <time title={formatDateTime(run.startedAt)}>
                      {formatRelative(run.startedAt)}
                    </time>
                  </td>
                  <td className="tabular">{formatDuration(run.startedAt, run.terminatedAt)}</td>
                  <td>
                    <a
                      href={auditHref({ resourceType: 'worker_run', resourceId: run.id })}
                      data-testid="worker-run-provenance-link"
                    >
                      {t('查看', 'View')}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
