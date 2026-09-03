import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../lib/errors.js';
import type { HttpClient } from '../lib/http-client.js';
import type { WsClient } from '../lib/ws-client.js';
import { NavBar } from './NavBar.js';

/** The wire shape one `list_tasks`/`get_task` array entry carries (`toWireWorkerRun`/
 *  `listTasksHandler`, packages/kernel/src/application/gateway/handlers.ts) — same fields
 *  `get_task` already returns, just one array entry per Task instead of one object. */
export interface TaskSummary {
  readonly id: string;
  readonly status: string;
  readonly onBehalfOf: string;
  readonly workerDefinitionId: string;
  readonly workerDefinitionVersion: number;
  readonly result: unknown;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly cancelledAt: string | null;
  readonly workerRuns: readonly WorkerRunSummary[];
}

export interface WorkerRunSummary {
  readonly id: string;
  readonly status: string;
  readonly containerId: string | null;
  readonly depth: number;
  readonly attempt: number;
  readonly startedAt: string;
  readonly terminatedAt: string | null;
}

export interface TasksPageProps {
  readonly httpClient: HttpClient;
  readonly wsClient: WsClient;
  readonly onForgetKey: () => void;
}

/** `result` is arbitrary JSON from the worker's own result contract (S2.9) — no schema this page
 *  can rely on beyond "JSON-serializable". Rendered as a truncated one-line summary, not a full
 *  dump (a WorkerRun's own detail is already shown in the table below it). */
function summarizeResult(result: unknown): string | undefined {
  if (result === null || result === undefined) return undefined;
  try {
    const text = JSON.stringify(result);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return undefined;
  }
}

/**
 * components/TasksPage: the caller's own Tasks and their WorkerRuns (design doc §7.6; docs/
 * development-tasks.md S2.10 deliverable 4: "list the user's Tasks with status/failure reason/
 * result summary and their WorkerRuns; live task.updated"). Uses the S2.10-added `list_tasks`
 * capability (packages/shared/src/capabilities.ts) — `get_task`/§9.3 never defined a list
 * capability; see this component's own README section for why one had to be added.
 */
export function TasksPage({ httpClient, wsClient, onForgetKey }: TasksPageProps) {
  const [tasks, setTasks] = useState<readonly TaskSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await httpClient.call<readonly TaskSummary[]>('list_tasks');
      setTasks(result);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [httpClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return wsClient.onTaskUpdated(() => void refresh());
  }, [wsClient, refresh]);

  return (
    <div className="page">
      <NavBar active="tasks" />
      <header className="page-header">
        <h1>Tasks</h1>
        <div className="header-actions">
          <button type="button" className="secondary" onClick={onForgetKey}>
            Forget key
          </button>
        </div>
      </header>

      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}

      {tasks === null ? (
        <p className="hint">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="hint">No Tasks yet.</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => {
            const summary = summarizeResult(task.result);
            return (
              <li key={task.id} className="task-row">
                <div className="task-row-header">
                  <span>
                    {task.workerDefinitionId}@{task.workerDefinitionVersion}
                  </span>
                  <span className={`action-card-status action-card-status-${task.status}`}>
                    {task.status}
                  </span>
                </div>
                {task.failureReason && <p className="hint">failure: {task.failureReason}</p>}
                {summary && <p className="hint">result: {summary}</p>}

                {task.workerRuns.length > 0 && (
                  <table className="worker-run-table">
                    <thead>
                      <tr>
                        <th>WorkerRun</th>
                        <th>status</th>
                        <th>depth</th>
                        <th>attempt</th>
                        <th>started</th>
                        <th>terminated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {task.workerRuns.map((run) => (
                        <tr key={run.id}>
                          <td>{run.id}</td>
                          <td>{run.status}</td>
                          <td>{run.depth}</td>
                          <td>{run.attempt}</td>
                          <td>{new Date(run.startedAt).toLocaleString()}</td>
                          <td>
                            {run.terminatedAt ? new Date(run.terminatedAt).toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
