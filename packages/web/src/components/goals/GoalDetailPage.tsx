import {
  type GoalDetailWire,
  type GoalLeftoversWire,
  type UnresolvedGoalActionWire,
  visibleLines,
} from '@nexttime/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCanOpen } from '../../hooks/useCanOpen.js';
import { useResource } from '../../hooks/useResource.js';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import { auditHref } from '../../lib/audit.js';
import type { CapabilityCaller, PushSource } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { actionKindTagText, excerpt, formatDateTime, formatRelative } from '../../lib/format.js';
import {
  goalBudgetRows,
  goalPauseReasonLabel,
  goalStateNote,
  outcomeBasisLabel,
} from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { hrefs } from '../../lib/router.js';
import { labelText, statusChipStyle } from '../../lib/status-tone.js';
import { useGatekeeperNames } from '../approvals/useDirectoryNames.js';
import { Button } from '../kit/button.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue, type KeyValueItem } from '../kit/key-value.js';
import { Notice } from '../kit/notice.js';
import { PageHeader } from '../kit/page-header.js';
import { RefChip } from '../kit/ref-chip.js';
import { DashboardCard } from '../kit/section.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { ActionChip } from './ActionChip.js';
import { GoalAcceptanceSection } from './GoalAcceptanceSection.js';
import {
  type GoalMark,
  type GoalOperationOutcome,
  GoalOperationsBar,
} from './GoalOperationsBar.js';
import { GoalPlanEditor } from './GoalPlanEditor.js';
import { GoalReconcileControls } from './GoalReconcileControls.js';
import { GoalRevisionsSection } from './GoalRevisionsSection.js';
import { GoalStepsSection } from './GoalStepsSection.js';
import { GoalUnresolvedSection } from './GoalUnresolvedSection.js';

export interface GoalDetailPageProps {
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly goalRunId: string;
}

/**
 * components/goals/GoalDetailPage (S11 GO6, read-only part): one goal (`get_goal`) on its own page
 * — what it is doing or waiting on, who asked for it, what it spent of its budget, its steps,
 * its acceptance, the actions still waiting for a person (`list_goal_unresolved_actions`), what a
 * cancel left behind, and its plan revisions — and what the reader may do to it now
 * (`GoalOperationsBar`, GO5b; for a proposal, the confirm card: the plan, checks and budget below
 * with 确认并开始 / 驳回) and about each action to check (`GoalReconcileControls`). Revising the
 * plan (修订计划…) swaps the page's sections for the plan editor (`GoalPlanEditor`).
 *
 * A goal the reader may not see reads exactly like one that does not exist (the kernel's 404 for
 * both); the page says so without guessing which. No goal pushes exist yet: an update of one of
 * its Tasks or actions, or a reconnect, re-reads it.
 */
export function GoalDetailPage({ http, pushes, goalRunId }: GoalDetailPageProps) {
  const t = useT();
  const loadDetail = useCallback(
    () => http.call<GoalDetailWire>('get_goal', { goalRunId }),
    [http, goalRunId],
  );
  const loadUnresolved = useCallback(async () => {
    const page = await http.call<{ items: readonly UnresolvedGoalActionWire[] }>(
      'list_goal_unresolved_actions',
      { goalRunId },
    );
    return page.items;
  }, [http, goalRunId]);
  const detail = useResource(loadDetail);
  const unresolved = useResource(loadUnresolved);
  const gateNames = useGatekeeperNames(http);
  const identity = useWorkspaceIdentity(http);
  const viewer = {
    principalId: identity.principalId,
    isOwner: identity.role.kind === 'known' && identity.role.role === 'owner',
  };

  const reloadAll = useCallback(() => {
    void detail.reload();
    void unresolved.reload();
  }, [detail.reload, unresolved.reload]);
  // What the reader's last operation did, said on the page (the operation re-reads the goal).
  const [done, setDone] = useState<GoalOperationOutcome | null>(null);
  // The plan editor (`revise_goal`) in place of the page's sections, until it is sent or left.
  const [revising, setRevising] = useState(false);
  const onDone = useCallback(
    (outcome: GoalOperationOutcome) => {
      setDone(outcome);
      setRevising(false);
      reloadAll();
    },
    [reloadAll],
  );
  // Leaving the editor replaces the page under the reader's focus: it moves to what the page says
  // about the revision, so a keyboard or screen reader user hears the page changed.
  const doneRef = useRef<HTMLOutputElement>(null);
  const [focusDone, setFocusDone] = useState(false);
  const onRevised = useCallback(
    (outcome: GoalOperationOutcome) => {
      onDone(outcome);
      setFocusDone(true);
    },
    [onDone],
  );
  useEffect(() => {
    if (!focusDone || revising || doneRef.current === null) return;
    doneRef.current.focus();
    setFocusDone(false);
  });

  const data = detail.state.status === 'ready' ? detail.state.data : undefined;
  // The Tasks and actions this goal ran, read when a push arrives rather than captured by the
  // subscription: subscribed once, a push landing between a read and the next subscription is
  // still matched against the goal as last read.
  const owned = useRef<{ tasks: ReadonlySet<string>; actions: ReadonlySet<string> }>({
    tasks: new Set(),
    actions: new Set(),
  });
  owned.current = useMemo(
    () => ({
      tasks: new Set(data?.steps.flatMap((step) => step.attempts.map((a) => a.taskId)) ?? []),
      actions: new Set(
        data?.steps.flatMap((step) => step.actions.map((a) => a.actionRequestId)) ?? [],
      ),
    }),
    [data],
  );
  useEffect(
    () =>
      pushes.onTaskUpdated((event) => {
        if (owned.current.tasks.has(event.id)) reloadAll();
      }),
    [pushes, reloadAll],
  );
  useEffect(
    () =>
      pushes.onActionUpdated((event) => {
        if (owned.current.actions.has(event.id)) reloadAll();
      }),
    [pushes, reloadAll],
  );
  useEffect(() => pushes.onResynced(reloadAll), [pushes, reloadAll]);

  const breadcrumb = breadcrumbFor('goals').map((crumb, index, all) =>
    index === all.length - 1 ? { ...crumb, href: hrefs.goals() } : crumb,
  );
  const refreshing = detail.state.status === 'ready' && detail.state.refreshing;
  const header = (title: string) => (
    <PageHeader
      breadcrumb={breadcrumb}
      title={title}
      actions={
        <Button variant="ghost" aria-busy={refreshing} disabled={refreshing} onClick={reloadAll}>
          {t('刷新', 'Refresh')}
        </Button>
      }
    />
  );

  if (detail.state.status === 'loading') {
    return (
      <div className="page goal-page">
        {header(t('目标', 'Goal'))}
        <SkeletonRows count={6} label="Loading goal" testId="goal-loading" />
      </div>
    );
  }
  if (detail.state.status === 'error') {
    const notFound = describeError(detail.state.error).code === 'not_found';
    return (
      <div className="page goal-page">
        {header(t('目标', 'Goal'))}
        {notFound ? (
          <EmptyState
            title={t('找不到这个目标', 'Goal not found')}
            body={t(
              '它不存在，或者你看不到它：除了工作区所有者，每个人只能看到自己发起的目标。',
              'It does not exist, or you may not see it: apart from the workspace owner, everyone sees only the goals they asked for.',
            )}
            action={
              <Button variant="secondary" asChild>
                <a href={hrefs.goals()}>{t('回到目标列表', 'Back to goals')}</a>
              </Button>
            }
            testId="goal-not-found"
          />
        ) : (
          <ErrorBanner
            error={detail.state.error}
            title={t('无法加载目标', 'Could not load the goal')}
            onRetry={reloadAll}
            testId="goal-error"
          />
        )}
      </div>
    );
  }

  const goal = detail.state.data;
  const unresolvedItems = unresolved.state.status === 'ready' ? unresolved.state.data : undefined;
  const budget = goalBudgetRows(goal, t);
  const note = goalStateNote(goal, unresolvedItems, budget, t);
  if (revising) {
    return (
      <div className="page goal-page stack" data-testid="goal-detail" data-goal-id={goal.id}>
        {header(excerpt(goal.statement, 80) ?? t('目标', 'Goal'))}
        {detail.state.refreshError ? (
          <ErrorBanner error={detail.state.refreshError} onRetry={reloadAll} />
        ) : null}
        <GoalPlanEditor
          goal={goal}
          http={http}
          gateNames={gateNames}
          onCancel={() => setRevising(false)}
          onDone={onRevised}
        />
      </div>
    );
  }
  return (
    <div className="page goal-page stack" data-testid="goal-detail" data-goal-id={goal.id}>
      {header(excerpt(goal.statement, 80) ?? t('目标', 'Goal'))}
      {detail.state.refreshError ? (
        <ErrorBanner error={detail.state.refreshError} onRetry={reloadAll} />
      ) : null}

      <div className="row-wrap" data-testid="goal-status">
        <StatusChip machine="goalRun" status={goal.status} />
        {goal.pauseReason ? (
          <span className="text-warn">
            {goalPauseReasonLabel(goal.pauseReason, t)}
            {goal.pausedByAuthority === 'owner' ? t('（所有者锁定）', ' (owner hold)') : ''}
          </span>
        ) : null}
        {goal.outcome ? <StatusChip machine="objectiveOutcome" status={goal.outcome} /> : null}
        {goal.outcome && goal.outcomeBasis ? (
          <span className="text-3">{outcomeBasisLabel(goal.outcomeBasis, t)}</span>
        ) : null}
      </div>
      {note ? (
        <Notice tone={note.tone} testId="goal-state-note">
          {note.text}
        </Notice>
      ) : null}
      <GoalOperationsBar
        goal={goal}
        viewer={viewer}
        http={http}
        gateNames={gateNames}
        onRevise={() => {
          setDone(null);
          setRevising(true);
        }}
        onDone={onDone}
      />
      <output aria-live="polite" ref={doneRef} tabIndex={-1}>
        {/* After a 409, only once the goal is read again: a failed re-read keeps the old goal
            (its error banner above), from which nothing can be said about where it stands. */}
        {done && !(done.kind === 'stale' && (refreshing || detail.state.refreshError)) ? (
          <Notice tone={done.kind === 'stale' ? 'warn' : 'info'} testId="goal-op-done">
            {done.kind === 'done' ? done.message : staleText(done.before, goal, t)}
          </Notice>
        ) : null}
        {done?.kind === 'done'
          ? done.notes?.map((note) => (
              <Notice key={note} tone="warn" testId="goal-op-note">
                {note}
              </Notice>
            ))
          : null}
      </output>

      <DashboardCard title={t('概览', 'Overview')} data-testid="goal-overview">
        <KeyValue items={overviewItems(goal, http, t)} />
      </DashboardCard>

      <DashboardCard title={t('预算', 'Budget')} data-testid="goal-budget">
        <KeyValue
          items={budget.map((row) => {
            const pct = row.max > 0 ? Math.min(100, Math.round((row.used / row.max) * 100)) : 0;
            return {
              key: row.key,
              label: row.label,
              value: (
                <div className="stack-s" data-testid={`goal-budget-${row.key}`}>
                  <span className="tabular">
                    {row.usedText} / {row.maxText}
                  </span>
                  {row.max > 0 ? (
                    <span className={`quota-bar${pct >= 80 ? ' quota-bar-warn' : ''}`}>
                      <span style={{ width: `${pct}%` }} />
                    </span>
                  ) : null}
                </div>
              ),
            };
          })}
        />
      </DashboardCard>

      <GoalUnresolvedSection
        state={
          unresolved.state.status === 'ready'
            ? { status: 'ready', items: unresolved.state.data }
            : unresolved.state.status === 'error'
              ? { status: 'error', error: unresolved.state.error }
              : { status: 'loading' }
        }
        paused={goal.status === 'paused'}
        controls={(action) => (
          <GoalReconcileControls
            goal={goal}
            action={action}
            viewer={viewer}
            http={http}
            onDone={onDone}
          />
        )}
        http={http}
        onRetry={() => void unresolved.reload()}
      />

      {goal.leftovers ? <Leftovers leftovers={goal.leftovers} http={http} t={t} /> : null}

      <GoalStepsSection detail={goal} http={http} gateNames={gateNames} />
      <GoalAcceptanceSection detail={goal} gateNames={gateNames} />
      <GoalRevisionsSection detail={goal} http={http} />
    </div>
  );
}

function overviewItems(goal: GoalDetailWire, http: CapabilityCaller, t: Translate): KeyValueItem[] {
  const items: KeyValueItem[] = [
    {
      key: 'statement',
      label: t('目标', 'Goal'),
      value: <p className="pre-wrap">{visibleLines(goal.statement)}</p>,
    },
    {
      key: 'requester',
      label: t('请求人', 'Requester'),
      value: (
        <RefChip
          kind="principal"
          id={goal.onBehalfOf}
          http={http}
          size="s"
          testId="goal-requester"
        />
      ),
    },
  ];
  if (goal.pausedBy) {
    items.push({
      key: 'pausedBy',
      label: t('暂停人', 'Paused by'),
      value: (
        <span className="row-wrap">
          <RefChip
            kind="principal"
            id={goal.pausedBy}
            http={http}
            size="s"
            testId="goal-paused-by"
          />
          {goal.pausedByAuthority === 'owner' ? (
            <span className="text-3 text-small">
              {t('以工作区所有者身份锁定', 'A hold, as workspace owner')}
            </span>
          ) : null}
        </span>
      ),
    });
  }
  items.push(
    { key: 'createdAt', label: t('提出', 'Proposed'), value: <When iso={goal.createdAt} /> },
    {
      key: 'confirmedAt',
      label: t('确认', 'Confirmed'),
      value: goal.confirmedAt ? (
        <When iso={goal.confirmedAt} />
      ) : (
        <span className="text-3">{t('还没确认', 'Not yet')}</span>
      ),
    },
  );
  if (goal.endedAt)
    items.push({ key: 'endedAt', label: t('结束', 'Ended'), value: <When iso={goal.endedAt} /> });
  items.push({
    key: 'revision',
    label: t('计划', 'Plan'),
    value:
      goal.currentRevision !== null
        ? t(`第 ${goal.currentRevision} 版生效中`, `v${goal.currentRevision} in force`)
        : t('第 1 版，等确认', 'v1, awaiting confirmation'),
  });
  items.push({
    key: 'provenance',
    label: t('溯源', 'Provenance'),
    value: <ProvenanceLink goalRunId={goal.id} t={t} />,
  });
  return items;
}

function When({ iso }: { readonly iso: string }) {
  return (
    <>
      <time title={formatDateTime(iso)}>{formatRelative(iso)}</time>
      <span className="text-3"> · {formatDateTime(iso)}</span>
    </>
  );
}

function ProvenanceLink({ goalRunId, t }: { readonly goalRunId: string; readonly t: Translate }) {
  const canOpen = useCanOpen();
  const href = auditHref({ resourceType: 'goal_run', resourceId: goalRunId });
  if (canOpen(href) === false) {
    return (
      <span className="text-3">
        {t('你的角色看不到审计记录。', 'Your role does not see the audit log.')}
      </span>
    );
  }
  return (
    <a href={href} data-testid="goal-provenance-link">
      {t(
        '在审计里查看这个目标本身的状态变化',
        'See the changes of this goal’s own state in the audit log',
      )}
    </a>
  );
}

function Leftovers({
  leftovers,
  http,
  t,
}: {
  readonly leftovers: GoalLeftoversWire;
  readonly http: CapabilityCaller;
  readonly t: Translate;
}) {
  return (
    <DashboardCard
      title={t('取消后还在运行的', 'Still running after the cancel')}
      data-testid="goal-leftovers"
    >
      <div className="stack-s">
        <span className="text-small text-3">
          {t(
            '这些任务和动作在取消时还在运行。执行中的动作撤不回，会按原来的方式结束，结果照常进审计。',
            'These tasks and actions were still running at the cancel. An executing action cannot be taken back; it ends as it would have, and its outcome is audited as usual.',
          )}
        </span>
        {leftovers.liveTaskIds.length === 0 && leftovers.executingActions.length === 0 ? (
          <span className="text-small">{t('现在没有了。', 'None left now.')}</span>
        ) : null}
        {leftovers.liveTaskIds.map((taskId) => (
          <span key={taskId} className="row-wrap" data-testid="goal-leftover-task">
            <RefChip kind="task" id={taskId} http={http} href={hrefs.task(taskId)} size="s" />
          </span>
        ))}
        {leftovers.executingActions.map((action) => (
          <span
            key={action.actionRequestId}
            className="row-wrap"
            data-testid="goal-leftover-action"
          >
            <ActionChip
              actionRequestId={action.actionRequestId}
              name={actionKindTagText(action.actionKindTag)}
              http={http}
            />
            <RefChip kind="gatekeeper" id={action.gatekeeperId} http={http} size="s" />
          </span>
        ))}
      </div>
    </DashboardCard>
  );
}

/** After a 409: whether the goal itself had moved on (read again, its status or version differs
 *  from what the operation found), or the refusal was about something of it — a step still
 *  running or waiting, a Task still live, an action in flight or of unknown outcome (review #501
 *  on #697). */
function staleText(before: GoalMark, goal: GoalDetailWire, t: Translate): string {
  const now = labelText(statusChipStyle('goalRun', goal.status), t);
  if (before.status !== goal.status || before.updatedAt !== goal.updatedAt) {
    return t(
      `目标的状态刚变了，刚才的操作没有执行。页面已经刷新：它现在是「${now}」。`,
      `The goal had just moved on, so that was not done. The page has been refreshed: it is now ${now}.`,
    );
  }
  return t(
    `刚才的操作此刻不能执行，什么也没改；目标仍是「${now}」。通常是还有步骤在运行或等待、任务还没结束，或者有动作在进行或结果不明：先看下面的「步骤」和「待核对的动作」。`,
    `That cannot be done right now, and nothing changed; the goal is still ${now}. Usually a step still runs or waits, a Task is still live, or an action is in flight or of unknown outcome: see Steps and Actions to check below.`,
  );
}
