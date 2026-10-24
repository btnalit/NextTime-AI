import { failureReading } from '../lib/action-outcome.js';
import { goalMilestoneText } from '../lib/goals.js';
import { useT } from '../lib/i18n.js';
import { taskFailureReasonText } from '../lib/labels.js';
import type { SystemStatusLineData } from '../lib/system-status.js';
import { Icon } from './ui/Icon.js';
import { StatusChip } from './ui/StatusChip.js';

export interface SystemStatusLineViewProps {
  readonly line: SystemStatusLineData;
  /** When given, the line is a button that opens the referenced approval/task/goal detail. */
  readonly onOpen?: () => void;
  /** S11 GO5e-2 (#737 UX P2-2): for a goal's milestone or a goal step's Task, which goal it is —
   *  its statement on one line, or that it cannot be read (`chatGoalLabel`); `null` while read. */
  readonly goalLabel?: string | null;
}

const OPEN_TITLE = {
  action_update: ['打开审批', 'Open approval'],
  task_update: ['打开任务', 'Open task'],
  goal_update: ['打开目标', 'Open goal'],
} as const;

/** components/SystemStatusLineView: the compact inline notice for `system.action_update`/
 *  `system.task_update` (S2.10 deliverable 2 — never a card, see `lib/system-status.ts`) and, S11
 *  GO5e-2, a goal's milestone (`system.goal_update`) — worded from its fields in the reader's
 *  language (`goalMilestoneText`) and, unlike the kernel's one-line tail, never cut: it wraps on a
 *  narrow screen (pages.css). A Task run for a goal's step shows a tag naming the step in place of
 *  the kernel's line. */
export function SystemStatusLineView({ line, onOpen, goalLabel }: SystemStatusLineViewProps) {
  const t = useT();
  const failure = line.variant === 'action_update' ? failureReading(line, t) : null;
  const chip =
    line.variant === 'action_update' ? (
      <StatusChip machine="actionRequest" status={line.status} size="s" />
    ) : line.variant === 'goal_update' ? (
      <>
        <StatusChip machine="goalRun" status={line.status} size="s" />
        {/* How it ended, beside 「已结束」 (#737 UX P2-1) — as the goal's page shows it. */}
        {line.outcome ? (
          <StatusChip
            machine="objectiveOutcome"
            status={line.outcome}
            size="s"
            testId="system-status-goal-outcome"
          />
        ) : null}
      </>
    ) : (
      <StatusChip machine="task" status={line.status} size="s" />
    );
  // A goal step's Task: the chip and the step tag say it all — the kernel's line (English, the
  // Task's id) adds nothing a reader of the goal needs; its page is one click away.
  const text =
    line.variant === 'goal_update'
      ? goalMilestoneText(line, t)
      : line.variant === 'task_update' && line.goalStep
        ? null
        : line.text;
  // S11 GO5e-2 (#737 UX P2-3): a goal's milestone or a goal step's Task says which goal on a row of
  // its own under what happened, with the whole width to itself before it is cut — never squeezed
  // into a column beside the sentence on a narrow screen.
  const goalLine =
    line.variant === 'goal_update' ||
    (line.variant === 'task_update' && line.goalStep !== undefined);
  const step =
    line.variant === 'task_update' && line.goalStep ? (
      <span
        className="system-status-step text-3"
        data-testid="system-status-goal-step"
        title={t('这个任务是目标的一步', 'This Task is a step of a goal')}
      >
        {t(`目标步骤 ${line.goalStep.stepKey}`, `Goal step ${line.goalStep.stepKey}`)}
      </span>
    ) : null;
  const textSpan = text !== null ? <span className="system-status-text">{text}</span> : null;
  const failureReason =
    line.variant === 'task_update' && line.failureReason ? (
      <span
        className="system-status-reason text-3"
        title={taskFailureReasonText(line.failureReason, t).detail}
      >
        ({taskFailureReasonText(line.failureReason, t).short})
      </span>
    ) : null;
  const chevron = onOpen ? <Icon name="chevron-right" size="s" className="text-3" /> : null;
  const body = goalLine ? (
    <>
      {chip}
      <span className="system-status-main">
        <span className="system-status-head">
          {step}
          {textSpan}
          {failureReason}
        </span>{' '}
        {goalLabel ? (
          <span
            className="system-status-goal text-3"
            data-testid="system-status-goal"
            title={goalLabel}
          >
            {goalLabel}
          </span>
        ) : null}
      </span>
      {chevron}
    </>
  ) : (
    // S11 GO1: the failure kind right after the chip, never cut — the kernel's line after it may be.
    <>
      {chip}
      {failure ? (
        <span
          className={`system-status-failure ${failure.tone === 'danger' ? 'text-danger' : 'text-3'}`}
          data-testid="system-status-failure"
          data-failure-kind={failure.kind}
          title={failure.message}
        >
          {failure.short}
        </span>
      ) : null}
      {textSpan}
      {failureReason}
      {chevron}
    </>
  );

  if (onOpen) {
    return (
      <button
        type="button"
        className="system-status-line system-status-line-button"
        onClick={onOpen}
        data-testid="system-status-line"
        data-variant={line.variant}
        data-goal={goalLine || undefined}
        title={t(OPEN_TITLE[line.variant][0], OPEN_TITLE[line.variant][1])}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      className="system-status-line"
      data-testid="system-status-line"
      data-variant={line.variant}
      data-goal={goalLine || undefined}
    >
      {body}
    </div>
  );
}
