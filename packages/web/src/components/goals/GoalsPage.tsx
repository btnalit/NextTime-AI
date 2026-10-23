import type { GoalRunWire } from '@nexttime/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useResource } from '../../hooks/useResource.js';
import type { CapabilityCaller, PushSource } from '../../lib/clients.js';
import { excerpt, formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import {
  type GoalFilter,
  goalMatchesFilter,
  goalPauseReasonLabel,
  goalStepProgress,
  isTerminalGoalStatus,
} from '../../lib/goals.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { sameNameIds, withSameNameId } from '../../lib/same-name.js';
import { usePrincipalNames } from '../approvals/useDirectoryNames.js';
import { Button } from '../kit/button.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { List, ListRow } from '../kit/list-row.js';
import { PageHeader } from '../kit/page-header.js';
import { Select } from '../kit/select.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { Tabs } from '../kit/tabs.js';

export interface GoalsPageProps {
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly onOpen: (goalRunId: string) => void;
}

/** The requester filter's "everyone" value — not a principal id. */
const ANY_REQUESTER = '';

/**
 * components/goals/GoalsPage (S11 GO6, read-only part): 目标 — the GoalRuns the reader may see
 * (`list_goals`): a member their own, a workspace owner every goal in the workspace. Each row says
 * how far the goal ran, why it is paused, whether it was achieved, its steps and what it spent;
 * opening one goes to its own page (`GoalDetailPage`). Like `TasksPage`, it walks every page of
 * the list (the tabs promise the whole history) and filters on the client.
 *
 * The requester filter is offered only when the loaded goals have more than one requester — an
 * owner looking across the workspace; a member sees only their own, so there is nothing to pick.
 * Its options are those requesters, never a typed id. No goal pushes exist yet: while a goal is open
 * a Task update re-reads the list, a reconnect always does, and 刷新 does on demand.
 */
export function GoalsPage({ http, pushes, onOpen }: GoalsPageProps) {
  const t = useT();
  const load = useCallback(async () => {
    let items: readonly GoalRunWire[] = [];
    let cursor: string | undefined;
    do {
      const page = await http.call<{ items: readonly GoalRunWire[]; nextCursor?: string }>(
        'list_goals',
        cursor ? { cursor } : {},
      );
      items = [...items, ...page.items];
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }, [http]);
  const goals = useResource(load);
  const principalNames = usePrincipalNames(http);
  const [filter, setFilter] = useState<GoalFilter>('all');
  const [requester, setRequester] = useState<string>(ANY_REQUESTER);

  const allRows = goals.state.status === 'ready' ? goals.state.data : [];
  // A Task update can move an open goal on; once every goal has ended there is nothing to re-read.
  const anyOpen = allRows.some((goal) => !isTerminalGoalStatus(goal.status));
  useEffect(
    () => (anyOpen ? pushes.onTaskUpdated(() => void goals.reload()) : undefined),
    [pushes, goals.reload, anyOpen],
  );
  useEffect(() => pushes.onResynced(() => void goals.reload()), [pushes, goals.reload]);

  const requesters = useMemo(() => [...new Set(allRows.map((goal) => goal.onBehalfOf))], [allRows]);
  const byRequester =
    requester === ANY_REQUESTER ? allRows : allRows.filter((goal) => goal.onBehalfOf === requester);
  const rows = byRequester.filter((goal) => goalMatchesFilter(goal, filter));
  const activeCount = byRequester.filter((goal) => !isTerminalGoalStatus(goal.status)).length;
  const requesterSame = sameNameIds(
    requesters,
    (id) => id,
    (id) => principalNames.get(id) ?? shortId(id),
  );

  return (
    <div className="page goals-page">
      <PageHeader
        breadcrumb={breadcrumbFor('goals')}
        title={t('目标', 'Goals')}
        description={t(
          '多步的工作：计划、每一步的进展、验收和花费。目标由入口智能体提出，请求人确认后才开始。',
          'Multi-step work: its plan, how each step is going, its checks and what it spent. The entry agent proposes a goal; it starts once the requester confirms it.',
        )}
        actions={
          <Button
            variant="ghost"
            aria-busy={goals.state.status === 'ready' && goals.state.refreshing}
            disabled={goals.state.status === 'ready' && goals.state.refreshing}
            onClick={() => void goals.reload()}
          >
            {t('刷新', 'Refresh')}
          </Button>
        }
      />

      <div className="page-toolbar row-wrap">
        <Tabs<GoalFilter>
          ariaLabel="Filter goals"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('全部', 'All'), count: byRequester.length },
            { value: 'active', label: t('未结束', 'Open'), count: activeCount },
            {
              value: 'done',
              label: t('已结束', 'Finished'),
              count: byRequester.length - activeCount,
            },
          ]}
        />
        {requesters.length > 1 ? (
          <Select
            className="select-fit"
            aria-label={t('按请求人筛选', 'Filter by requester')}
            value={requester}
            onChange={(event) => setRequester(event.target.value)}
            data-testid="goals-requester-filter"
          >
            <option value={ANY_REQUESTER}>{t('所有请求人', 'Every requester')}</option>
            {requesters.map((id) => (
              <option key={id} value={id}>
                {withSameNameId(principalNames.get(id) ?? shortId(id), id, requesterSame)}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      <GoalsList
        state={goals.state}
        rows={rows}
        total={allRows.length}
        principalNames={principalNames}
        onRetry={() => void goals.reload()}
        onOpen={onOpen}
      />
    </div>
  );
}

interface GoalsListProps {
  readonly state: ReturnType<typeof useResource<readonly GoalRunWire[]>>['state'];
  readonly rows: readonly GoalRunWire[];
  readonly total: number;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly onRetry: () => void;
  readonly onOpen: (goalRunId: string) => void;
}

function GoalsList({ state, rows, total, principalNames, onRetry, onOpen }: GoalsListProps) {
  const t = useT();
  if (state.status === 'loading') {
    return <SkeletonRows count={4} label="Loading goals" testId="goals-loading" />;
  }
  if (state.status === 'error') {
    return (
      <ErrorBanner
        error={state.error}
        title={t('无法加载目标', 'Could not load goals')}
        onRetry={onRetry}
        testId="goals-error"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={
          total === 0
            ? t('还没有目标', 'No goals yet')
            : t('没有符合筛选的目标', 'No goals match this filter')
        }
        body={t(
          '在对话里把一件多步、跨系统或要等待的事交给入口智能体，它会提出一个目标；你确认计划后，目标就会出现在这里。',
          'Hand the entry agent something multi-step, cross-system or long-waiting in a chat and it proposes a goal; once you confirm the plan, it shows up here.',
        )}
        testId="goals-empty"
      />
    );
  }
  return (
    <div className="stack-s">
      {state.refreshError ? <ErrorBanner error={state.refreshError} onRetry={onRetry} /> : null}
      <List ariaLabel="Goals" testId="goals-list">
        {rows.map((goal) => {
          const progress = goalStepProgress(goal);
          return (
            <ListRow
              key={goal.id}
              testId="goal-row"
              accent={
                goal.status === 'paused' || goal.cleanupPending
                  ? 'warn'
                  : goal.status === 'failed'
                    ? 'danger'
                    : undefined
              }
              onSelect={() => onOpen(goal.id)}
            >
              <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="row-wrap">
                  <StatusChip machine="goalRun" status={goal.status} size="s" />
                  {goal.pauseReason ? (
                    <span className="text-small text-warn" data-testid="goal-row-pause-reason">
                      {goalPauseReasonLabel(goal.pauseReason, t)}
                      {goal.pausedByAuthority === 'owner'
                        ? t('（所有者锁定）', ' (owner hold)')
                        : ''}
                    </span>
                  ) : null}
                  {goal.outcome ? (
                    <StatusChip machine="objectiveOutcome" status={goal.outcome} size="s" />
                  ) : null}
                  {goal.cleanupPending ? (
                    <span className="text-small text-warn">{t('有残留', 'Leftovers')}</span>
                  ) : null}
                </span>
                <time className="text-3" title={formatDateTime(goal.createdAt)}>
                  {formatRelative(goal.createdAt)}
                </time>
              </span>
              <span className="truncate">{excerpt(goal.statement, 120)}</span>
              <span className="row-wrap text-3">
                <span>{t('请求人', 'Requester')}</span>
                <span className="truncate">
                  {principalNames.get(goal.onBehalfOf) ?? shortId(goal.onBehalfOf)}
                </span>
                <span className="meta-sep" />
                <span className="tabular">
                  {t(
                    `步骤 ${progress.done}/${progress.total}`,
                    `Steps ${progress.done}/${progress.total}`,
                  )}
                </span>
                {goal.currentRevision !== null ? (
                  <>
                    <span className="meta-sep" />
                    <span className="tabular">
                      {t(`计划第 ${goal.currentRevision} 版`, `Plan v${goal.currentRevision}`)}
                    </span>
                  </>
                ) : null}
                <span className="meta-sep" />
                <span className="tabular">
                  {goal.usage.tokens.toLocaleString()} / {goal.budget.maxTokens.toLocaleString()}{' '}
                  tokens
                </span>
              </span>
            </ListRow>
          );
        })}
      </List>
    </div>
  );
}
