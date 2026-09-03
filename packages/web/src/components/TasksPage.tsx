import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import { useResource } from '../hooks/useResource.js';
import type { ActionRequestRowLike } from '../lib/action-card.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { excerpt, formatDateTime, formatDuration, formatRelative } from '../lib/format.js';
import {
  type TaskSummary,
  type WorkerDefinitionSummary,
  definitionName,
  isTerminalTaskStatus,
  taskFinishedAt,
  taskNeed,
} from '../lib/tasks.js';
import { TaskDetail } from './TaskDetail.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Icon } from './ui/Icon.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { Tabs } from './ui/Tabs.js';
import { useToast } from './ui/Toast.js';

export interface TasksPageProps {
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly selectedId?: string;
  readonly onSelect: (taskId: string | null) => void;
  readonly onOpenApproval: (actionRequestId: string) => void;
}

type Filter = 'active' | 'all' | 'done';

/**
 * components/TasksPage: the caller's own Tasks (`list_tasks`, S2.10 deliverable 4) with a detail
 * drawer. Live: `task.updated` re-reads that one Task (`get_task`) and swaps it into the list.
 * Worker definition names come from `list_worker_definitions` (best effort — ids when it fails);
 * linked approvals from `list_pending` rows whose `parentWorkerRunId` is one of the Task's runs
 * (best effort — skipped for non-operators).
 */
export function TasksPage({ http, pushes, selectedId, onSelect, onOpenApproval }: TasksPageProps) {
  const permissions = usePermissions();
  const toast = useToast();
  const load = useCallback(() => http.call<readonly TaskSummary[]>('list_tasks'), [http]);
  const tasks = useResource(load);
  const loadDefinitions = useCallback(
    () => http.call<readonly WorkerDefinitionSummary[]>('list_worker_definitions', {}),
    [http],
  );
  const definitions = useResource(loadDefinitions);
  const pendingDenied = permissions.isDenied('list_pending');
  const loadPending = useCallback(
    () =>
      pendingDenied
        ? Promise.resolve<readonly ActionRequestRowLike[]>([])
        : http.call<readonly ActionRequestRowLike[]>('list_pending'),
    [http, pendingDenied],
  );
  const pendingApprovals = useResource(loadPending);
  useEffect(() => {
    if (pendingApprovals.state.status === 'error' && isForbiddenError(pendingApprovals.state.error)) {
      permissions.markDenied('list_pending');
    }
  }, [pendingApprovals.state, permissions]);

  const [filter, setFilter] = useState<Filter>('all');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<unknown | null>(null);

  const refreshOne = useCallback(
    async (taskId: string) => {
      try {
        const fresh = await http.call<TaskSummary>('get_task', { taskId });
        tasks.mutate((rows) =>
          rows.some((row) => row.id === fresh.id)
            ? rows.map((row) => (row.id === fresh.id ? fresh : row))
            : [fresh, ...rows],
        );
      } catch {
        await tasks.reload();
      }
    },
    [http, tasks.mutate, tasks.reload],
  );

  useEffect(
    () => pushes.onTaskUpdated((event) => void refreshOne(event.taskId)),
    [pushes, refreshOne],
  );
  useEffect(() => {
    const unsubPending = pushes.onActionPending(() => void pendingApprovals.reload());
    const unsubUpdated = pushes.onActionUpdated(() => void pendingApprovals.reload());
    return () => {
      unsubPending();
      unsubUpdated();
    };
  }, [pushes, pendingApprovals.reload]);

  const allRows = tasks.state.status === 'ready' ? tasks.state.data : [];
  const rows = useMemo(() => {
    if (filter === 'all') return allRows;
    return allRows.filter((task) =>
      filter === 'done' ? isTerminalTaskStatus(task.status) : !isTerminalTaskStatus(task.status),
    );
  }, [allRows, filter]);
  const activeCount = allRows.filter((task) => !isTerminalTaskStatus(task.status)).length;
  const definitionRows = definitions.state.status === 'ready' ? definitions.state.data : undefined;
  const pendingRows = pendingApprovals.state.status === 'ready' ? pendingApprovals.state.data : [];

  const selected = selectedId ? allRows.find((task) => task.id === selectedId) : undefined;
  useEffect(() => {
    if (selectedId && !selected && tasks.state.status === 'ready') void refreshOne(selectedId);
  }, [selectedId, selected, tasks.state.status, refreshOne]);

  async function handleCancel(taskId: string): Promise<void> {
    setCancelling(taskId);
    setCancelError(null);
    try {
      const result = await http.call<{ id: string; status: string }>('cancel_task', { taskId });
      tasks.mutate((current) =>
        current.map((task) => (task.id === result.id ? { ...task, status: result.status } : task)),
      );
      toast.push({ tone: 'info', title: 'Task cancelled' });
      await refreshOne(taskId);
    } catch (err) {
      setCancelError(err);
    } finally {
      setCancelling(null);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Tasks"
        description="Work delegated to Workers on your behalf, with their runs and results."
        actions={
          <Button
            variant="ghost"
            icon="refresh"
            onClick={() => void tasks.reload()}
            loading={tasks.state.status === 'ready' && tasks.state.refreshing}
          >
            Refresh
          </Button>
        }
      />

      <div className="page-toolbar">
        <Tabs<Filter>
          ariaLabel="Filter tasks"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: allRows.length },
            { value: 'active', label: 'Active', count: activeCount },
            { value: 'done', label: 'Finished', count: allRows.length - activeCount },
          ]}
        />
      </div>

      {tasks.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading tasks" testId="tasks-loading" />
      ) : tasks.state.status === 'error' ? (
        <ErrorBanner
          error={tasks.state.error}
          title="Could not load tasks"
          onRetry={() => void tasks.reload()}
          testId="tasks-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="cpu"
          title={allRows.length === 0 ? 'No tasks yet' : 'No tasks match this filter'}
          body="A Task is created when the entry agent delegates work to a Worker (invoke_worker). Its runs, result contract and approvals show up here."
          testId="tasks-empty"
        />
      ) : (
        <>
          {tasks.state.refreshError ? (
            <ErrorBanner error={tasks.state.refreshError} onRetry={() => void tasks.reload()} />
          ) : null}
          <DataList ariaLabel="Tasks" testId="tasks-list">
            {rows.map((task) => {
              const finished = taskFinishedAt(task);
              const name = definitionName(
                definitionRows,
                task.workerDefinitionId,
                task.workerDefinitionVersion,
              );
              const need = taskNeed(task.input) ?? excerpt(task.input, 100);
              return (
                <DataRow
                  key={task.id}
                  testId="task-row"
                  selected={task.id === selectedId}
                  onSelect={() => onSelect(task.id)}
                  leading={<StatusChip machine="task" status={task.status} size="s" />}
                  title={
                    <>
                      <span className="truncate">{name ?? task.workerDefinitionId}</span>
                      <span className="text-3 text-small">v{task.workerDefinitionVersion}</span>
                    </>
                  }
                  meta={
                    <>
                      {need ? <span className="truncate">{excerpt(need, 90)}</span> : null}
                      {need ? <span className="meta-sep" /> : null}
                      <time title={formatDateTime(task.createdAt)}>{formatRelative(task.createdAt)}</time>
                      <span className="meta-sep" />
                      <span className="tabular">
                        {finished ? 'took ' : 'running '}
                        {formatDuration(task.createdAt, finished)}
                      </span>
                      {task.tokenBudget ? (
                        <>
                          <span className="meta-sep" />
                          <span className="tabular">
                            {task.tokensUsed.toLocaleString()} / {task.tokenBudget.toLocaleString()}{' '}
                            tokens
                          </span>
                        </>
                      ) : null}
                      {task.failureReason ? (
                        <>
                          <span className="meta-sep" />
                          <span className="text-danger truncate">{task.failureReason}</span>
                        </>
                      ) : null}
                    </>
                  }
                  trailing={<Icon name="chevron-right" />}
                />
              );
            })}
          </DataList>
        </>
      )}

      <Drawer
        open={selectedId !== undefined}
        onClose={() => onSelect(null)}
        title={
          selected
            ? (definitionName(definitionRows, selected.workerDefinitionId, selected.workerDefinitionVersion) ??
              'Task')
            : 'Task'
        }
        subtitle={selectedId ? <span className="mono">{selectedId}</span> : undefined}
        wide
        testId="task-drawer"
      >
        {selected ? (
          <TaskDetail
            task={selected}
            definitionName={definitionName(
              definitionRows,
              selected.workerDefinitionId,
              selected.workerDefinitionVersion,
            )}
            linkedApprovals={pendingRows.filter(
              (row) =>
                row.parentWorkerRunId !== undefined &&
                row.parentWorkerRunId !== null &&
                selected.workerRuns.some((run) => run.id === row.parentWorkerRunId),
            )}
            onOpenApproval={onOpenApproval}
            onCancel={(taskId) => void handleCancel(taskId)}
            cancelling={cancelling === selected.id}
            cancelError={cancelError}
          />
        ) : (
          <SkeletonRows count={3} label="Loading task" />
        )}
      </Drawer>
    </div>
  );
}
