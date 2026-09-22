import { auditHref } from '../lib/audit.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { formatDateTime, formatDuration, formatRelative, prettyJson } from '../lib/format.js';
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
import { Button } from './ui/Button.js';
import { CopyId } from './ui/CopyId.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { RefChip } from './ui/RefChip.js';
import { StatusChip } from './ui/StatusChip.js';

export interface TaskDetailProps {
  readonly task: TaskSummary;
  readonly definitionName: string | undefined;
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly principalNames?: ReadonlyMap<string, string>;
  readonly onOpenApproval: (actionRequestId: string) => void;
  /** Asks the page to cancel — the page confirms through `ConfirmTier` before `cancel_task`. */
  readonly onCancel: (taskId: string) => void;
  readonly cancelling: boolean;
  readonly cancelError: unknown | null;
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
 * Cancel is a request to the page, which confirms it (tier `high`, §5.8 "确认态").
 */
export function TaskDetail({
  task,
  definitionName,
  http,
  pushes,
  principalNames,
  onOpenApproval,
  onCancel,
  cancelling,
  cancelError,
}: TaskDetailProps) {
  const finished = taskFinishedAt(task);
  const contract = asResultContract(task.result);
  const need = taskNeed(task.input);
  const budgetPct =
    task.tokenBudget && task.tokenBudget > 0
      ? Math.min(100, Math.round((task.tokensUsed / task.tokenBudget) * 100))
      : null;

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
          <Button
            variant="danger"
            size="s"
            icon="stop"
            onClick={() => onCancel(task.id)}
            loading={cancelling}
            className="grow-0"
            style={{ marginLeft: 'auto' }}
            data-testid="task-cancel"
          >
            取消任务 Cancel task
          </Button>
        ) : null}
      </div>

      {cancelError !== null && cancelError !== undefined ? (
        <ErrorBanner
          error={cancelError}
          title="无法取消 Could not cancel"
          testId="task-cancel-error"
        />
      ) : null}

      {need ? <p className="pre-wrap">{need}</p> : null}

      <dl className="definition-list">
        <dt>任务 Task</dt>
        <dd className="row-wrap">
          <CopyId id={task.id} label="task" />
          <a
            href={auditHref({ resourceType: 'task', resourceId: task.id })}
            data-testid="task-provenance-link"
          >
            查看溯源 View provenance
          </a>
        </dd>
        <dt>定义 Definition</dt>
        <dd className="row-wrap">
          <CopyId id={task.workerDefinitionId} label="worker definition" />
          <span className="text-3">v{task.workerDefinitionVersion}</span>
        </dd>
        <dt>代表 On behalf of</dt>
        <dd>
          <RefChip
            kind="principal"
            id={task.onBehalfOf}
            name={nameOf(principalNames, task.onBehalfOf)}
            size="s"
            testId="task-on-behalf-of"
          />
        </dd>
        <dt>创建 Created</dt>
        <dd>
          <time title={formatDateTime(task.createdAt)}>{formatRelative(task.createdAt)}</time>
          <span className="text-3"> · {formatDateTime(task.createdAt)}</span>
        </dd>
        <dt>{finished ? '结束 Finished' : '已用时 Elapsed'}</dt>
        <dd>
          {finished ? `${formatDateTime(finished)} · ` : ''}
          {formatDuration(task.createdAt, finished)}
          {task.durationLimitSec ? (
            <span className="text-3"> / 上限 limit {task.durationLimitSec}s</span>
          ) : null}
        </dd>
        <dt>Token</dt>
        <dd className="stack-s">
          <span className="tabular">
            {task.tokensUsed.toLocaleString()}
            {task.tokenBudget ? ` / ${task.tokenBudget.toLocaleString()}` : ' 已用 used'}
          </span>
          {budgetPct !== null ? (
            <span className={`quota-bar${budgetPct >= 80 ? ' quota-bar-warn' : ''}`}>
              <span style={{ width: `${budgetPct}%` }} />
            </span>
          ) : null}
        </dd>
        {task.failureReason ? (
          <>
            <dt>失败原因 Failure</dt>
            <dd className="text-danger">{task.failureReason}</dd>
          </>
        ) : null}
      </dl>

      {contract ? (
        <div className="stack-s">
          <span className="section-title">结果 Result</span>
          <p className="pre-wrap">{contract.summary}</p>
          {contract.findings.length > 0 ? (
            <ul className="finding-list">
              {contract.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          ) : null}
          <div className="row-wrap text-small text-3">
            <span>{contract.factsToAssert.length} 条事实 facts written</span>
            <span className="meta-sep" />
            <span>{contract.evidence.length} 条证据 evidence refs</span>
            <span className="meta-sep" />
            <span>{contract.artifacts.length} 个产物 artifacts</span>
            {contract.proposedOperations.length > 0 ? (
              <>
                <span className="meta-sep" />
                <span>{contract.proposedOperations.length} 个提议的 Operation proposed</span>
              </>
            ) : null}
            {contract.proposedSkill !== undefined ? (
              <>
                <span className="meta-sep" />
                <span>提议了一个 Skill proposed a Skill</span>
              </>
            ) : null}
          </div>
          {contract.factsToAssert.length > 0 ? (
            <details className="disclosure">
              <summary>事实与证据 Facts and evidence</summary>
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
          <span className="section-title">结果 Result</span>
          <pre className="code-block">{prettyJson(task.result)}</pre>
        </div>
      ) : null}

      {task.input !== null && task.input !== undefined && !need ? (
        <details className="disclosure">
          <summary>输入 Input</summary>
          <div className="disclosure-body">
            <pre className="code-block">{prettyJson(task.input)}</pre>
          </div>
        </details>
      ) : null}

      <div className="stack-s">
        <span className="section-title">Worker 运行 Worker runs</span>
        {task.workerRuns.length === 0 ? (
          <span className="text-3 text-small">
            尚未分配 WorkerRun。 No WorkerRun has been provisioned yet.
          </span>
        ) : (
          <table className="worker-run-table">
            <thead>
              <tr>
                <th>运行 Run</th>
                <th>状态 Status</th>
                <th>深度 Depth</th>
                <th>尝试 Attempt</th>
                <th>开始 Started</th>
                <th>用时 Duration</th>
                <th>溯源 Provenance</th>
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
                      查看 View
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="stack-s">
        <span className="section-title">关联审批 Linked approvals</span>
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
