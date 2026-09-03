import type { ActionRequestRowLike } from '../lib/action-card.js';
import { formatDateTime, formatDuration, humanizeKind, prettyJson } from '../lib/format.js';
import {
  type TaskSummary,
  asResultContract,
  isCancellable,
  taskFinishedAt,
  taskNeed,
} from '../lib/tasks.js';
import { Button } from './ui/Button.js';
import { CopyId } from './ui/CopyId.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { StatusChip } from './ui/StatusChip.js';

export interface TaskDetailProps {
  readonly task: TaskSummary;
  readonly definitionName: string | undefined;
  /** Pending ActionRequests raised by this Task's WorkerRuns (matched on `parentWorkerRunId`). */
  readonly linkedApprovals: readonly ActionRequestRowLike[];
  readonly onOpenApproval: (actionRequestId: string) => void;
  readonly onCancel: (taskId: string) => void;
  readonly cancelling: boolean;
  readonly cancelError: unknown | null;
}

/**
 * components/TaskDetail: one Task — identity and budget, the result contract (S2.9 shape when it
 * matches, raw JSON otherwise), WorkerRuns, linked approvals, and Cancel while the shared Task
 * transition table allows it (`lib/tasks.ts` `isCancellable`).
 */
export function TaskDetail({
  task,
  definitionName,
  linkedApprovals,
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
        <span className="tag">
          {definitionName ?? task.workerDefinitionId}@{task.workerDefinitionVersion}
        </span>
        {isCancellable(task.status) ? (
          <Button
            variant="danger"
            size="s"
            icon="stop"
            onClick={() => onCancel(task.id)}
            loading={cancelling}
            className="grow-0"
            style={{ marginLeft: 'auto' }}
          >
            Cancel task
          </Button>
        ) : null}
      </div>

      {cancelError !== null && cancelError !== undefined ? (
        <ErrorBanner error={cancelError} title="Could not cancel" />
      ) : null}

      {need ? <p className="pre-wrap">{need}</p> : null}

      <dl className="definition-list">
        <dt>Task</dt>
        <dd>
          <CopyId id={task.id} label="task" />
        </dd>
        <dt>Definition</dt>
        <dd className="row-wrap">
          <CopyId id={task.workerDefinitionId} label="worker definition" />
          <span className="text-3">v{task.workerDefinitionVersion}</span>
        </dd>
        <dt>On behalf of</dt>
        <dd>
          <CopyId id={task.onBehalfOf} label="principal" />
        </dd>
        <dt>Created</dt>
        <dd>{formatDateTime(task.createdAt)}</dd>
        <dt>{finished ? 'Finished' : 'Elapsed'}</dt>
        <dd>
          {finished ? `${formatDateTime(finished)} · ` : ''}
          {formatDuration(task.createdAt, finished)}
          {task.durationLimitSec ? (
            <span className="text-3"> / limit {task.durationLimitSec}s</span>
          ) : null}
        </dd>
        <dt>Tokens</dt>
        <dd className="stack-s">
          <span className="tabular">
            {task.tokensUsed.toLocaleString()}
            {task.tokenBudget ? ` / ${task.tokenBudget.toLocaleString()}` : ' used'}
          </span>
          {budgetPct !== null ? (
            <span className={`quota-bar${budgetPct >= 80 ? ' quota-bar-warn' : ''}`}>
              <span style={{ width: `${budgetPct}%` }} />
            </span>
          ) : null}
        </dd>
        {task.failureReason ? (
          <>
            <dt>Failure</dt>
            <dd className="text-danger">{task.failureReason}</dd>
          </>
        ) : null}
      </dl>

      {contract ? (
        <div className="stack-s">
          <span className="section-title">Result</span>
          <p className="pre-wrap">{contract.summary}</p>
          {contract.findings.length > 0 ? (
            <ul className="finding-list">
              {contract.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          ) : null}
          <div className="row-wrap text-small text-3">
            <span>{contract.factsToAssert.length} facts written</span>
            <span className="meta-sep" />
            <span>{contract.evidence.length} evidence refs</span>
            <span className="meta-sep" />
            <span>{contract.artifacts.length} artifacts</span>
            {contract.proposedOperations.length > 0 ? (
              <>
                <span className="meta-sep" />
                <span>{contract.proposedOperations.length} proposed operations</span>
              </>
            ) : null}
            {contract.proposedSkill !== undefined ? (
              <>
                <span className="meta-sep" />
                <span>proposed a Skill</span>
              </>
            ) : null}
          </div>
          {contract.factsToAssert.length > 0 ? (
            <details className="disclosure">
              <summary>Facts and evidence</summary>
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
          <span className="section-title">Result</span>
          <pre className="code-block">{prettyJson(task.result)}</pre>
        </div>
      ) : null}

      {task.input !== null && task.input !== undefined && !need ? (
        <details className="disclosure">
          <summary>Input</summary>
          <div className="disclosure-body">
            <pre className="code-block">{prettyJson(task.input)}</pre>
          </div>
        </details>
      ) : null}

      <div className="stack-s">
        <span className="section-title">Worker runs</span>
        {task.workerRuns.length === 0 ? (
          <span className="text-3 text-small">No WorkerRun has been provisioned yet.</span>
        ) : (
          <table className="worker-run-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Depth</th>
                <th>Attempt</th>
                <th>Started</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {task.workerRuns.map((run) => (
                <tr key={run.id}>
                  <td>
                    <CopyId id={run.id} label="worker run" />
                  </td>
                  <td>
                    <StatusChip machine="workerRun" status={run.status} size="s" />
                  </td>
                  <td className="tabular">{run.depth}</td>
                  <td className="tabular">{run.attempt}</td>
                  <td>
                    <time title={formatDateTime(run.startedAt)}>{formatDateTime(run.startedAt)}</time>
                  </td>
                  <td className="tabular">{formatDuration(run.startedAt, run.terminatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="stack-s">
        <span className="section-title">Linked approvals</span>
        {linkedApprovals.length === 0 ? (
          <Notice>
            No pending approval is linked to this Task's runs. Decided requests are not listed by
            the kernel (no Task → ActionRequest read exists yet).
          </Notice>
        ) : (
          <div className="stack-s">
            {linkedApprovals.map((row) => (
              <Button
                key={row.id}
                variant="secondary"
                size="s"
                onClick={() => onOpenApproval(row.id)}
                icon="approvals"
              >
                {humanizeKind(row.actionKind)}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
