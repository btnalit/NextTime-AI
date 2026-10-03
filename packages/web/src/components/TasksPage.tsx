import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Resource, useResource } from '../hooks/useResource.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { excerpt, formatDateTime, formatDuration, formatRelative, shortId } from '../lib/format.js';
import { type Translate, useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
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
import { Button } from './kit/button.js';
import { EmptyState } from './kit/empty-state.js';
import { ErrorBanner } from './kit/error-banner.js';
import { List, ListRow } from './kit/list-row.js';
import { MasterDetail } from './kit/master-detail.js';
import { PageHeader } from './kit/page-header.js';
import { SkeletonRows } from './kit/skeleton.js';
import { StatusChip } from './kit/status-chip.js';
import { Tabs } from './kit/tabs.js';
// `useToast` stays on `components/ui/Toast` — `App.tsx` mounts that provider (not `kit/toast`'s
// own, separate context), so `kit/toast`'s hook would make this page's "任务已取消" toast a silent
// no-op (same reason as `ApprovalQueuePage.tsx`/`AgentProfilePage.tsx`).
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
 * components/TasksPage: 任务 Tasks — the caller's own Tasks (`list_tasks`, S2.10 deliverable 4) as
 * a master-detail layout (console redesign P3-4 part B, following 待我审批's own V6): a list pane
 * (or, ≤1179px, a list-only page) and a detail pane/`kit/sheet` for one selected Task, on
 * `components/kit/master-detail` (shared with `ApprovalQueuePage`). Live: `task.updated` re-reads
 * that one Task (`get_task`) and swaps it into the list (C7). Worker definition names come from
 * `list_worker_definitions` (best effort — ids when it fails).
 *
 * S8 W1-C (#243) made both `list_tasks` and `list_worker_definitions` keyset-paginated (default
 * 100, max 500) — the comment this carried until S8 W1-A4 ("no keyset paging exists, B5 does not
 * apply") predates that. This page keeps its own `useResource(loader)` (per `hooks/useCapability`'s
 * own module doc: Tasks/Approvals/Chats are additive, not migrated to `useCapabilityList`), so
 * both loaders below walk every page themselves rather than exposing a "加载更多" button — the
 * 全部/进行中/已结束 tabs above already promise the reader's *complete* Task history, not a
 * browsable first page of it, and `list_worker_definitions` only ever backs the definition-name
 * lookup, never a list of its own.
 *
 * S6-A (C28 / B2 / B4): linked approvals moved into `TaskDetail` → `approvals/LinkedApprovals`
 * (`list_action_requests{taskId}`, decided rows included, reloaded per push for the open Task
 * only) — the page no longer holds a `list_pending` mirror or reconciles approval pushes itself.
 * Cancel is a `kit/confirm` `medium` popover owned by `TaskDetail` itself (S8 W1-A7, audit S13),
 * anchored to its own Cancel button — this page only hands down the plain `performCancel` mutation
 * (which still throws on failure so the confirm keeps its own inline error and stays open).
 *
 * Selection stays URL-driven exactly as before (`selectedId`/`onSelect`) — no auto-select. In the
 * wide layout, nothing selected renders a `kit/empty-state` naming the object instead of a blank
 * pane (the same pattern `ApprovalQueuePage` established).
 */
export function TasksPage({ http, pushes, selectedId, onSelect, onOpenApproval }: TasksPageProps) {
  const t = useT();
  const toast = useToast();
  const load = useCallback(async () => {
    let items: readonly TaskSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await http.call<{ items: readonly TaskSummary[]; nextCursor?: string }>(
        'list_tasks',
        cursor ? { cursor } : {},
      );
      items = [...items, ...page.items];
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }, [http]);
  const tasks = useResource(load);
  const loadDefinitions = useCallback(async () => {
    let items: readonly WorkerDefinitionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await http.call<{
        items: readonly WorkerDefinitionSummary[];
        nextCursor?: string;
      }>('list_worker_definitions', cursor ? { cursor } : {});
      items = [...items, ...page.items];
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }, [http]);
  const definitions = useResource(loadDefinitions);
  const principalNames = usePrincipalNames(http);

  const [filter, setFilter] = useState<Filter>('all');

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
  // R-63: `task.updated` pushes sent while the socket was down are lost — after a reconnect the
  // whole list is re-read, not just the rows a push would have named.
  useEffect(() => pushes.onResynced(() => void tasks.reload()), [pushes, tasks.reload]);

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

  /** The `cancel_task` call, passed straight to `TaskDetail`'s confirm as `onConfirm` — throws so
   *  the confirm keeps its own inline error and stays open. */
  async function performCancel(task: TaskSummary): Promise<void> {
    const result = await http.call<{ id: string; status: string }>('cancel_task', {
      taskId: task.id,
    });
    tasks.mutate((current) =>
      current.map((row) => (row.id === result.id ? { ...row, status: result.status } : row)),
    );
    toast.push({ tone: 'info', title: t('任务已取消', 'Task cancelled') });
    await refreshOne(task.id);
  }

  const selectedDefinitionName = selected
    ? definitionName(definitionRows, selected.workerDefinitionId, selected.workerDefinitionVersion)
    : undefined;

  const detailContent = (
    <TaskDetailContent
      t={t}
      selectedId={selectedId}
      selected={selected}
      definitionName={selectedDefinitionName}
      http={http}
      pushes={pushes}
      principalNames={principalNames}
      onOpenApproval={onOpenApproval}
      onCancel={performCancel}
    />
  );

  return (
    <div className="page tasks-page">
      <PageHeader
        breadcrumb={breadcrumbFor('tasks')}
        title={t('任务', 'Tasks')}
        description={t(
          '代表你委派给 Worker 的工作，及其运行与结果。',
          'Work delegated to Workers on your behalf, with their runs and results.',
        )}
        actions={
          <Button
            variant="ghost"
            aria-busy={tasks.state.status === 'ready' && tasks.state.refreshing}
            disabled={tasks.state.status === 'ready' && tasks.state.refreshing}
            onClick={() => void tasks.reload()}
          >
            {t('刷新', 'Refresh')}
          </Button>
        }
      />

      <div className="page-toolbar">
        <Tabs<Filter>
          ariaLabel="Filter tasks"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('全部', 'All'), count: allRows.length },
            { value: 'active', label: t('进行中', 'Active'), count: activeCount },
            { value: 'done', label: t('已结束', 'Finished'), count: allRows.length - activeCount },
          ]}
        />
      </div>

      <MasterDetail
        list={
          <TasksList
            t={t}
            tasks={tasks}
            rows={rows}
            allRows={allRows}
            definitionRows={definitionRows}
            principalNames={principalNames}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        }
        detail={
          tasks.state.status === 'ready' && rows.length === 0 && selectedId === undefined
            ? null
            : detailContent
        }
        open={selectedId !== undefined}
        onClose={() => onSelect(null)}
        // Generic on purpose (P3-4 screenshot review precedent, ApprovalQueuePage): the detail's
        // own h2 already names the Task's definition, so a specific sheet title would repeat it
        // one line above.
        sheetTitle={t('任务详情', 'Task detail')}
        detailTestId="task-drawer"
      />
    </div>
  );
}

interface TaskDetailContentProps {
  readonly t: Translate;
  readonly selectedId: string | undefined;
  readonly selected: TaskSummary | undefined;
  readonly definitionName: string | undefined;
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly onOpenApproval: (actionRequestId: string) => void;
  readonly onCancel: (task: TaskSummary) => Promise<void>;
}

/** The detail pane's (wide layout) / sheet's (narrow layout) shared content — one selected Task,
 *  a loading skeleton (`selectedId` set but not yet found — a deep link, or a push still in
 *  flight), or (nothing selected) the "pick one" empty state. The last of those is only reachable
 *  in the wide layout — the narrow layout's `Sheet` only opens once `selectedId` is set. */
function TaskDetailContent({
  t,
  selectedId,
  selected,
  definitionName,
  http,
  pushes,
  principalNames,
  onOpenApproval,
  onCancel,
}: TaskDetailContentProps) {
  if (selected) {
    return (
      <TaskDetail
        key={selected.id}
        task={selected}
        definitionName={definitionName}
        http={http}
        pushes={pushes}
        principalNames={principalNames}
        onOpenApproval={onOpenApproval}
        onCancel={onCancel}
      />
    );
  }
  if (selectedId !== undefined) {
    return <SkeletonRows count={3} label="Loading task" />;
  }
  return (
    <EmptyState
      title={t('还没有选择任务', 'No task selected yet')}
      body={t(
        '选择左侧一个任务，查看运行、结果与关联审批。',
        'Pick a task on the left to see its runs, results and linked approvals.',
      )}
      testId="task-drawer-empty"
    />
  );
}

interface TasksListProps {
  readonly t: Translate;
  readonly tasks: Resource<readonly TaskSummary[]>;
  readonly rows: readonly TaskSummary[];
  readonly allRows: readonly TaskSummary[];
  readonly definitionRows: readonly WorkerDefinitionSummary[] | undefined;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly selectedId: string | undefined;
  readonly onSelect: (taskId: string | null) => void;
}

function TasksList({
  t,
  tasks,
  rows,
  allRows,
  definitionRows,
  principalNames,
  selectedId,
  onSelect,
}: TasksListProps) {
  if (tasks.state.status === 'loading') {
    return <SkeletonRows count={4} label="Loading tasks" testId="tasks-loading" />;
  }
  if (tasks.state.status === 'error') {
    return (
      <ErrorBanner
        error={tasks.state.error}
        title={t('无法加载任务', 'Could not load tasks')}
        onRetry={() => void tasks.reload()}
        testId="tasks-error"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={
          allRows.length === 0
            ? t('还没有任务', 'No tasks yet')
            : t('没有符合筛选的任务', 'No tasks match this filter')
        }
        body={t(
          '入口智能体把工作委派给 Worker（invoke_worker）时会创建任务；它的运行、结果契约与审批都在这里。',
          'A Task is created when the entry agent delegates work to a Worker (invoke_worker). Its runs, result contract and approvals show up here.',
        )}
        testId="tasks-empty"
      />
    );
  }
  return (
    <div className="stack-s">
      {tasks.state.refreshError ? (
        <ErrorBanner error={tasks.state.refreshError} onRetry={() => void tasks.reload()} />
      ) : null}
      <List ariaLabel="Tasks" testId="tasks-list">
        {rows.map((task) => {
          const finished = taskFinishedAt(task);
          const name = definitionName(
            definitionRows,
            task.workerDefinitionId,
            task.workerDefinitionVersion,
          );
          const need = taskNeed(task.input) ?? excerpt(task.input, 100);
          const principalName = nameOfPrincipal(principalNames, task.onBehalfOf);
          return (
            <ListRow
              key={task.id}
              testId="task-row"
              selected={task.id === selectedId}
              onSelect={() => onSelect(task.id)}
            >
              <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <StatusChip machine="task" status={task.status} size="s" />
                <time className="text-3" title={formatDateTime(task.createdAt)}>
                  {formatRelative(task.createdAt)}
                </time>
              </span>
              <span className="truncate">
                {need ? excerpt(need, 90) : t('（无目标描述）', '(no objective given)')}
              </span>
              <span className="row-wrap text-3">
                <span className="truncate">{name ?? shortId(task.workerDefinitionId)}</span>
                <span className="text-3 text-small">v{task.workerDefinitionVersion}</span>
                <span className="meta-sep" />
                <span>{t('代表', 'on behalf of')}</span>
                <span className="truncate">{principalName}</span>
                <span className="meta-sep" />
                <span className="tabular">
                  {finished
                    ? `${t('用时', 'took')} `
                    : task.status === 'running'
                      ? `${t('运行中', 'running')} `
                      : `${t('等待中', 'waiting')} `}
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
              </span>
            </ListRow>
          );
        })}
      </List>
    </div>
  );
}

/** Plain text, never a `RefChip` — a `kit/list-row` is itself a `<button>`, and `RefChip`'s own
 *  copy control is a second, nested interactive element (invalid HTML, the exact bug part A found
 *  and fixed for the approvals row) — the full chip belongs in the detail, this is the row. */
function nameOfPrincipal(names: ReadonlyMap<string, string>, principalId: string): string {
  return names.get(principalId) ?? shortId(principalId);
}
