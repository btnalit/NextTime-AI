import type { GoalDetailWire, GoalRunStatus } from '@nexttime/shared';
import { useCallback } from 'react';
import { useResource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { excerpt, formatTime } from '../../lib/format.js';
import { goalBudgetRows, goalMilestoneText } from '../../lib/goals.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { InlineError } from '../kit/inline-error.js';
import { RedactedNote } from '../kit/redacted-note.js';
import { Skeleton } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';

export interface GoalProposalCardProps {
  readonly http: CapabilityCaller;
  readonly goalRunId: string;
  /** The goal's status as the latest of its milestones in this chat says (`latestGoalStatuses`). */
  readonly latestStatus: GoalRunStatus | undefined;
  /** The reader's own principal, when known: only the requester confirms. */
  readonly viewerId: string | null;
  readonly createdAt: string;
  readonly onOpenGoal: (goalRunId: string) => void;
}

/**
 * components/chat/GoalProposalCard (S11 GO5e-2; plan §4.14 "对话：发起目标的对话里，里程碑以系统消息
 * 出现", §5.5 "请求者在控制台（或对话卡片）确认"): a goal proposed from this chat, as a card — what the
 * goal is (its statement as `get_goal` reads it, masked like every read), how many steps and
 * checks it has, its budget, and its status now. Confirming stays on the goal's page, where the
 * confirmation card shows the plan, each check as a sentence and every hint (GO6): the button
 * here goes there — 「查看并确认」 while the reader is the requester and the goal waits for them,
 * 「查看目标」 otherwise. The goal's later milestones are status lines below it in the same chat.
 *
 * Unreadable (`get_goal` refused or the goal gone): the card still says a goal was proposed and
 * still opens its page, which explains the refusal.
 */
export function GoalProposalCard({
  http,
  goalRunId,
  latestStatus,
  viewerId,
  createdAt,
  onOpenGoal,
}: GoalProposalCardProps) {
  const t = useT();
  const load = useCallback(
    () => http.call<GoalDetailWire>('get_goal', { goalRunId }),
    [http, goalRunId],
  );
  const detail = useResource(load);
  const goal = detail.state.status === 'ready' ? detail.state.data : null;
  // A later milestone in this chat is newer than the read made when the card mounted.
  const status: GoalRunStatus =
    latestStatus !== undefined && latestStatus !== 'proposed'
      ? latestStatus
      : (goal?.status ?? latestStatus ?? 'proposed');
  const awaitsViewer =
    status === 'proposed' && goal !== null && viewerId !== null && goal.onBehalfOf === viewerId;

  return (
    <section
      className="action-card goal-proposal-card"
      data-testid="goal-proposal-card"
      data-goal-run-id={goalRunId}
      data-status={status}
      aria-label={t('目标提议', 'Goal proposal')}
    >
      <header className="action-detail-header">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-3 text-small">
            {t('目标', 'Goal')} · <time>{formatTime(createdAt)}</time>
          </span>
          <span className="action-detail-title" data-testid="goal-proposal-statement">
            {goal
              ? (excerpt(goal.statement, 200) ?? t('（没有目标陈述）', '(no statement)'))
              : goalMilestoneText(
                  {
                    change: 'propose',
                    status: 'proposed',
                    pauseReason: null,
                    heldByOwner: false,
                    outcome: null,
                    outcomeBasis: null,
                    cleanupPending: false,
                    revision: null,
                  },
                  t,
                )}
          </span>
          {goal ? <RedactedNote value={goal.statement} testId="goal-proposal-redacted" /> : null}
        </div>
        <StatusChip machine="goalRun" status={status} size="s" />
      </header>

      {detail.state.status === 'loading' ? <Skeleton width="60%" /> : null}
      {goal ? <GoalProposalSummary goal={goal} /> : null}
      {detail.state.status === 'error' ? (
        <InlineError error={detail.state.error} testId="goal-proposal-error" />
      ) : null}
      {awaitsViewer ? (
        <p className="text-3 text-small" data-testid="goal-proposal-awaits">
          {t(
            '还没有开始。确认之前，请在目标页看一遍计划、验收检查和预算。',
            'Nothing has run yet. Before confirming, look over its plan, checks and budget on its page.',
          )}
        </p>
      ) : null}

      <div className="action-detail-actions">
        <Button
          variant={awaitsViewer ? 'primary' : 'secondary'}
          size="s"
          onClick={() => onOpenGoal(goalRunId)}
          data-testid="goal-proposal-open"
        >
          {awaitsViewer ? t('查看并确认', 'Review and confirm') : t('查看目标', 'Open goal')}
        </Button>
      </div>
    </section>
  );
}

function GoalProposalSummary({ goal }: { readonly goal: GoalDetailWire }) {
  const t = useT();
  const steps = goal.planRevision.plan.steps.length;
  const checks = goal.planRevision.plan.acceptance?.length ?? 0;
  const limits = goalBudgetRows(goal, t)
    .map((row) => `${row.label} ≤ ${row.maxText}`)
    .join(t('，', ', '));
  return (
    <p className="text-2 text-small" data-testid="goal-proposal-summary">
      {t(`${steps} 个步骤`, steps === 1 ? '1 step' : `${steps} steps`)}
      {' · '}
      {checks === 0
        ? t('没有验收检查', 'no acceptance check')
        : t(`${checks} 条验收检查`, checks === 1 ? '1 check' : `${checks} checks`)}
      {' · '}
      {t(`预算：${limits}`, `Budget: ${limits}`)}
    </p>
  );
}
