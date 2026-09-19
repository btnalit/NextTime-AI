import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useResource } from '../hooks/useResource.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { excerpt, formatDateTime, formatDuration, formatRelative } from '../lib/format.js';
import { hrefs } from '../lib/router.js';
import {
  type TaskSummary,
  type WorkerDefinitionSummary,
  definitionName,
  isTerminalTaskStatus,
  taskFinishedAt,
  taskNeed,
} from '../lib/tasks.js';
import { TaskDetail } from './TaskDetail.js';
import { usePrincipalNames } from './approvals/useDirectoryNames.js';
import { Button } from './ui/Button.js';
import { ConfirmTier } from './ui/ConfirmTier.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Icon } from './ui/Icon.js';
import { PageHeader } from './ui/PageHeader.js';
import { RefChip } from './ui/RefChip.js';
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
 * components/TasksPage: 任务 Tasks — the caller's own Tasks (`list_tasks`, S2.10 deliverable 4;
 * `list_tasks` takes no params — no keyset paging exists for it, B5 does not apply) with a
 * detail drawer. Live: `task.updated` re-reads that one Task (`get_task`) and swaps it into the
 * list (C7). Worker definition names come from `list_worker_definitions` (best effort — ids when
 * it fails).
 *
 * S6-A (C28 / B2 / B4): linked approvals moved into `TaskDetail` → `approvals/LinkedApprovals`
 * (`list_action_requests{taskId}`, decided rows included, reloaded per push for the open Task
 * only) — the page no longer holds a `list_pending` mirror or reconciles approval pushes itself.
 * Cancel goes through `ui/ConfirmTier` (tier `high`, §5.8 "确认态": Cancel task listed with the
 * confirmations) rendered as a sibling of the detail drawer — the drawer's `onClose` is a stable
 * callback that no-ops while the confirmation is open (both register Escape on `document`).
 */
export function TasksPage({ http, pushes, selectedId, onSelect, onOpenApproval }: TasksPageProps) {
  const toast = useToast();
  const load = useCallback(
    () => http.call<{ items: readonly TaskSummary[] }>('list_tasks').then((page) => page.items),
    [http],
  );
  const tasks = useResource(load);
  const loadDefinitions = useCallback(
    () =>
      http
        .call<{ items: readonly WorkerDefinitionSummary[] }>('list_worker_definitions', {})
        .then((page) => page.items),
    [http],
  );
  const definitions = useResource(loadDefinitions);
  const principalNames = usePrincipalNames(http);

  const [filter, setFilter] = useState<Filter>('all');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<unknown | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<TaskSummary | null>(null);

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

  useEffect(() => pushes.onTaskUpdated((event) => void refreshOne(event.id)), [pushes, refreshOne]);

  const allRows = tasks.state.status === 'ready' ? tasks.state.data : [];
  const rows = useMemo(() => {
    if (filter === 'all') return allRows;
    return allRows.filter((task) =>
      filter === 'done' ? isTerminalTaskStatus(task.status) : !isTerminalTaskStatus(task.status),
    );
  }, [allRows, filter]);
  const activeCount = allRows.filter((task) => !isTerminalTaskStatus(task.status)).length;
  const definitionRows = definitions.state.status === 'ready' ? definitions.state.data : undefined;

  const selected = selectedId ? allRows.find((task) => task.id === selectedId) : undefined;
  useEffect(() => {
    if (selectedId && !selected && tasks.state.status === 'ready') void refreshOne(selectedId);
  }, [selectedId, selected, tasks.state.status, refreshOne]);

  // Stable for `Drawer`'s focus-trap effect; ignores Escape / overlay clicks that reach the
  // detail drawer while the `ConfirmTier` drawer is on top of it.
  const confirmOpenRef = useRef(false);
  confirmOpenRef.current = confirmCancel !== null;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const closeDetail = useCallback(() => {
    if (confirmOpenRef.current) return;
    onSelectRef.current(null);
  }, []);

  /** The `cancel_task` call — throws so the `ConfirmTier` keeps its drawer open with the
   *  kernel's error (also mirrored into `cancelError` for the detail view). */
  async function performCancel(task: TaskSummary): Promise<void> {
    setCancelling(task.id);
    setCancelError(null);
    try {
      const result = await http.call<{ id: string; status: string }>('cancel_task', {
        taskId: task.id,
      });
      tasks.mutate((current) =>
        current.map((row) => (row.id === result.id ? { ...row, status: result.status } : row)),
      );
      toast.push({ tone: 'info', title: '任务已取消 Task cancelled' });
      await refreshOne(task.id);
    } catch (err) {
      setCancelError(err);
      throw err;
    } finally {
      setCancelling(null);
    }
  }

  const runningRuns = confirmCancel
    ? confirmCancel.workerRuns.filter((run) => run.terminatedAt === null).length
    : 0;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: '工作 Work', href: hrefs.chats() }, { label: '任务 Tasks' }]}
        title="任务 Tasks"
        description="代表你委派给 Worker 的工作，及其运行与结果。 Work delegated to Workers on your behalf, with their runs and results."
        actions={
          <Button
            variant="ghost"
            icon="refresh"
            onClick={() => void tasks.reload()}
            loading={tasks.state.status === 'ready' && tasks.state.refreshing}
          >
            刷新 Refresh
          </Button>
        }
      />

      <div className="page-toolbar">
        <Tabs<Filter>
          ariaLabel="Filter tasks"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部 All', count: allRows.length },
            { value: 'active', label: '进行中 Active', count: activeCount },
            { value: 'done', label: '已结束 Finished', count: allRows.length - activeCount },
          ]}
        />
      </div>

      {tasks.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading tasks" testId="tasks-loading" />
      ) : tasks.state.status === 'error' ? (
        <ErrorBanner
          error={tasks.state.error}
          title="无法加载任务 Could not load tasks"
          onRetry={() => void tasks.reload()}
          testId="tasks-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="cpu"
          title={
            allRows.length === 0
              ? '还没有任务 No tasks yet'
              : '没有符合筛选的任务 No tasks match this filter'
          }
          body="入口智能体把工作委派给 Worker（invoke_worker）时会创建任务；它的运行、结果契约与审批都在这里。 A Task is created when the entry agent delegates work to a Worker (invoke_worker). Its runs, result contract and approvals show up here."
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
                      <time title={formatDateTime(task.createdAt)}>
                        {formatRelative(task.createdAt)}
                      </time>
                      <span className="meta-sep" />
                      <span className="tabular">
                        {finished
                          ? '用时 took '
                          : task.status === 'running'
                            ? '运行中 running '
                            : '等待中 waiting '}
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
        onClose={closeDetail}
        title={
          selected
            ? (definitionName(
                definitionRows,
                selected.workerDefinitionId,
                selected.workerDefinitionVersion,
              ) ?? '任务 Task')
            : '任务 Task'
        }
        subtitle={
          selectedId ? <RefChip kind="object" id={selectedId} name="Task" size="s" /> : undefined
        }
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
            http={http}
            pushes={pushes}
            principalNames={principalNames}
            onOpenApproval={onOpenApproval}
            onCancel={(taskId) => {
              const task = allRows.find((row) => row.id === taskId);
              if (task) setConfirmCancel(task);
            }}
            cancelling={cancelling === selected.id}
            cancelError={cancelError}
          />
        ) : (
          <SkeletonRows count={3} label="Loading task" />
        )}
      </Drawer>

      <ConfirmTier
        tier="high"
        open={confirmCancel !== null}
        title="取消任务 Cancel task"
        description="取消后任务进入 cancelled，正在运行的 WorkerRun 会被终止；已写入的事实与审计不受影响。 The Task becomes cancelled and its running WorkerRuns are terminated; facts already written and the audit trail stay."
        target={
          confirmCancel
            ? (definitionName(
                definitionRows,
                confirmCancel.workerDefinitionId,
                confirmCancel.workerDefinitionVersion,
              ) ?? confirmCancel.id)
            : undefined
        }
        impact={
          confirmCancel
            ? [
                `任务 Task: ${confirmCancel.id}`,
                `运行中的 WorkerRun Running runs: ${runningRuns}`,
                `已用 Token Tokens used: ${confirmCancel.tokensUsed.toLocaleString()}`,
                '取消后不能恢复；需要时重新委派 Cannot be resumed — delegate again if needed',
              ]
            : undefined
        }
        confirmLabel="确认取消 Cancel task"
        danger
        onConfirm={async () => {
          if (confirmCancel) await performCancel(confirmCancel);
        }}
        onClose={() => setConfirmCancel(null)}
        testId="task-cancel-confirm"
      />
    </div>
  );
}
