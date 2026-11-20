import { MAX_WORKER_RUN_TOOL_CALL_RECORDS, type WorkerToolCallWire } from '@nexttime/shared';
import { useMemo } from 'react';
import { useCapabilityList } from '../hooks/useCapability.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { describeError, isForbiddenError } from '../lib/errors.js';
import { shortId } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import type { WorkerRunSummary } from '../lib/tasks.js';
import { type ToolCallRecord, toolCallRecordFromContent } from '../lib/tool-call-record.js';
import { PersistedToolCallRowView } from './ToolCallRowView.js';
import { Button } from './kit/button.js';
import { ErrorBanner } from './kit/error-banner.js';
import { Notice } from './kit/notice.js';
import { SkeletonRows } from './kit/skeleton.js';

/** One run's records as listed: the run (from the Task's own `workerRuns`, when it is there), how
 *  many of its rows the kernel listed, and the ones this console could read. */
interface RunGroup {
  readonly workerRunId: string;
  readonly run: WorkerRunSummary | undefined;
  readonly listed: number;
  readonly records: readonly ToolCallRecord[];
}

/** The listed rows grouped by run, in the kernel's order (runs in the order they started, each
 *  run's calls in the order reported) — a run's rows are contiguous, also across pages. */
function groupByRun(
  items: readonly WorkerToolCallWire[],
  runs: readonly WorkerRunSummary[],
): readonly RunGroup[] {
  const groups: { workerRunId: string; listed: number; records: ToolCallRecord[] }[] = [];
  for (const item of items) {
    let group = groups[groups.length - 1];
    if (group === undefined || group.workerRunId !== item.workerRunId) {
      group = { workerRunId: item.workerRunId, listed: 0, records: [] };
      groups.push(group);
    }
    group.listed += 1;
    const record = toolCallRecordFromContent(item.content);
    if (record !== null) group.records.push(record);
  }
  return groups.map((group) => ({
    ...group,
    run: runs.find((run) => run.id === group.workerRunId),
  }));
}

/**
 * components/TaskToolCalls (legacy 155, console half): under 「Worker 运行」 of a Task, the tool
 * calls its Worker reported for its runs — read with `get_task_tool_calls{taskId}` (visible as
 * `get_task` is; stored redacted and cut to a preview when the kernel received them). Each call is
 * the chat's own persisted row (`PersistedToolCallRowView`, as the audit page's
 * `audit/TurnToolCalls` shows a Turn's), grouped under its run when the Task has more than one.
 * Paged by the kernel (100 a page, 「加载更多」 for the rest). While the Task runs the Worker keeps
 * reporting, so 「刷新」 reads the latest (a Task push reloads too). A run that holds the kernel's
 * cap says later calls were not kept; a call this console cannot read (a kernel newer than it) is
 * counted, never shown as "no calls". What the Worker reported, not what the gates did: it says
 * where those are (Linked approvals for writes, the audit trail under the gate for reads). The
 * list is a disclosure, open, so a long one can be folded away from Linked approvals below.
 */
export function TaskToolCalls({
  http,
  pushes,
  taskId,
  runs,
  running,
}: {
  readonly http: CapabilityCaller;
  readonly pushes?: PushSource;
  readonly taskId: string;
  readonly runs: readonly WorkerRunSummary[];
  /** The Task has not finished: its Worker may still report calls. */
  readonly running: boolean;
}) {
  const t = useT();
  const params = useMemo(() => ({ taskId }), [taskId]);
  const calls = useCapabilityList<WorkerToolCallWire>(http, 'get_task_tool_calls', params, {
    ...(pushes ? { pushes, reloadOn: ['taskUpdated'] as const } : {}),
  });
  const state = calls.state;
  const data = state.status === 'ready' ? state.data : null;
  const groups = useMemo(() => (data === null ? [] : groupByRun(data.items, runs)), [data, runs]);
  // A role that may not call it has nothing to show here; the runs above still stand.
  if (state.status === 'error' && isForbiddenError(state.error)) return null;
  // The kernel answers a Task the reader may not read (or one gone) with the same 404 every time.
  const retryable = state.status !== 'error' || describeError(state.error).code !== 'not_found';
  const listed = data === null ? 0 : data.items.length;
  const readable = groups.reduce((sum, group) => sum + group.records.length, 0);
  const unreadable = listed - readable;
  const more = data?.nextCursor !== undefined;
  const grouped = groups.length > 1 || runs.length > 1;
  const refresh = running ? (
    <Button
      variant="secondary"
      size="s"
      aria-busy={(state.status === 'ready' && state.refreshing) || undefined}
      onClick={() => void calls.reload()}
      data-testid="task-tool-calls-refresh"
    >
      {t('刷新', 'Refresh')}
    </Button>
  ) : null;

  return (
    <div className="stack-s" data-testid="task-tool-calls">
      <span className="section-title">
        {t('Worker 报告的工具调用', 'Tool calls the Worker reported')}
      </span>
      {state.status === 'loading' ? (
        <SkeletonRows
          count={2}
          label={t('正在读取工具调用', 'Loading tool calls')}
          testId="task-tool-calls-loading"
        />
      ) : state.status === 'error' ? (
        <ErrorBanner
          error={state.error}
          title={t('无法读取这个任务的工具调用', "Could not read this task's tool calls")}
          overrides={{
            not_found: t(
              '读不到这个任务：它可能已被删除，或你没有权限读它。',
              'This task cannot be read: it may have been deleted, or you may not have access to it.',
            ),
          }}
          onRetry={retryable ? () => void calls.reload() : undefined}
          testId="task-tool-calls-error"
        />
      ) : data === null ? null : listed === 0 ? (
        <div className="row-wrap" data-testid="task-tool-calls-empty">
          <span className="text-3 text-small">
            {running
              ? t(
                  'Worker 还没有报告工具调用。任务运行中，Worker 每结束一次调用就报告一次。',
                  'The Worker has not reported any tool calls yet. While the task runs, the Worker reports each call when it ends.',
                )
              : t(
                  'Worker 没有报告工具调用：它没有调用工具，或者这次运行不报告（平台升级前开始的运行、评测运行）。',
                  'The Worker reported no tool calls: it called none, or its run does not report them (runs started before the platform was upgraded, evaluation runs).',
                )}
          </span>
          {refresh}
        </div>
      ) : (
        <>
          <div className="row-wrap">
            <span className="text-3 text-small" data-testid="task-tool-calls-count">
              {[
                more
                  ? t(
                      `已显示 ${readable} 个，还有更多；按运行先后、运行内按报告先后排列。`,
                      `Showing ${readable} call(s); there are more. Runs in the order they started, each run's calls in the order reported.`,
                    )
                  : t(
                      `共 ${readable} 个，按运行先后、运行内按报告先后排列。`,
                      `${readable} call(s). Runs in the order they started, each run's calls in the order reported.`,
                    ),
                running
                  ? t(
                      '任务还在运行，Worker 每结束一次调用就报告一次。',
                      'The task is still running; the Worker reports each call when it ends.',
                    )
                  : null,
                // UX review on #1537: the task's own audit filter holds none of the Worker's gate
                // calls (they are audited under the gate or the request, by the Worker's account),
                // so this says where to look instead of linking there.
                t(
                  '这是 Worker 自己报告的调用，不是门的执行记录：存下时遮蔽了疑似凭据，超长的参数和结果已截断。Worker 发起的写操作见下面的「关联审批」；读操作在审计页里记在对应的门下。',
                  "Reported by the Worker, not a record of what the gates did: credential-like values were hidden when stored, and long arguments and results were shortened. The Worker's write actions are under Linked approvals below; its reads are in the audit trail, under the gate they read.",
                ),
              ]
                .filter((part) => part !== null)
                // Chinese sentences run on without a space; English ones take one.
                .join(t('', ' '))}
            </span>
            {refresh}
          </div>
          {unreadable > 0 ? (
            <span className="text-3 text-small" data-testid="task-tool-calls-unreadable">
              {t(
                `另有 ${unreadable} 个这个控制台读不了（平台比控制台新）。`,
                `${unreadable} more this console cannot read (the platform is newer than the console).`,
              )}
            </span>
          ) : null}
          <details className="disclosure" open data-testid="task-tool-calls-disclosure">
            <summary>{t(`调用列表（${readable} 个）`, `Calls (${readable})`)}</summary>
            <div className="disclosure-body stack-s">
              {groups.map((group) => (
                <div
                  key={group.workerRunId}
                  className="stack-s"
                  data-testid="task-tool-calls-run"
                  data-worker-run-id={group.workerRunId}
                >
                  {grouped ? (
                    <span className="text-small" data-testid="task-tool-calls-run-title">
                      <span className="mono" title={group.workerRunId}>
                        {t('运行', 'Run')} {shortId(group.workerRunId)}
                      </span>
                      {group.run !== undefined
                        ? t(`（第 ${group.run.attempt} 次尝试）`, ` (attempt ${group.run.attempt})`)
                        : null}
                      {t(` · ${group.records.length} 个`, ` · ${group.records.length} call(s)`)}
                    </span>
                  ) : null}
                  <div className="tool-calls" data-testid="task-tool-calls-list">
                    {group.records.map((record) => (
                      <PersistedToolCallRowView
                        key={record.toolCallId}
                        record={record}
                        http={http}
                        dated
                      />
                    ))}
                  </div>
                  {group.listed >= MAX_WORKER_RUN_TOOL_CALL_RECORDS ? (
                    <Notice tone="warn" testId="task-tool-calls-run-full">
                      {t(
                        `这个运行记到了 ${MAX_WORKER_RUN_TOOL_CALL_RECORDS} 个的上限；之后如果还有调用，平台没有记下。`,
                        `This run reached the limit of ${MAX_WORKER_RUN_TOOL_CALL_RECORDS} recorded calls; any later calls were not kept.`,
                      )}
                    </Notice>
                  ) : null}
                </div>
              ))}
              {more ? (
                <div className="row" style={{ justifyContent: 'center' }}>
                  <Button
                    variant="secondary"
                    aria-busy={calls.loadingMore || undefined}
                    disabled={calls.loadingMore}
                    onClick={() => void calls.loadMore()}
                    data-testid="task-tool-calls-load-more"
                  >
                    {t('加载更多', 'Load more')}
                  </Button>
                </div>
              ) : null}
              {calls.loadMoreError !== null ? (
                <ErrorBanner
                  error={calls.loadMoreError}
                  title={t('无法加载更多工具调用', 'Could not load more tool calls')}
                  testId="task-tool-calls-load-more-error"
                />
              ) : null}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
