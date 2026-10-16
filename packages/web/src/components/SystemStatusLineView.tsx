import { failureReading } from '../lib/action-outcome.js';
import { useT } from '../lib/i18n.js';
import { taskFailureReasonText } from '../lib/labels.js';
import type { SystemStatusLineData } from '../lib/system-status.js';
import { Icon } from './ui/Icon.js';
import { StatusChip } from './ui/StatusChip.js';

export interface SystemStatusLineViewProps {
  readonly line: SystemStatusLineData;
  /** When given, the line is a button that opens the referenced approval/task detail. */
  readonly onOpen?: () => void;
}

/** components/SystemStatusLineView: the compact inline notice for `system.action_update`/
 *  `system.task_update` (S2.10 deliverable 2 — never a card, see `lib/system-status.ts`). */
export function SystemStatusLineView({ line, onOpen }: SystemStatusLineViewProps) {
  const t = useT();
  const failure = line.variant === 'action_update' ? failureReading(line, t) : null;
  const chip =
    line.variant === 'action_update' ? (
      <StatusChip machine="actionRequest" status={line.status} size="s" />
    ) : (
      <StatusChip machine="task" status={line.status} size="s" />
    );
  // S11 GO1: the failure kind right after the chip, never cut — the kernel's line after it may be.
  const body = (
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
      <span className="system-status-text">{line.text}</span>
      {line.variant === 'task_update' && line.failureReason ? (
        <span className="text-3" title={taskFailureReasonText(line.failureReason, t).detail}>
          ({taskFailureReasonText(line.failureReason, t).short})
        </span>
      ) : null}
      {onOpen ? <Icon name="chevron-right" size="s" className="text-3" /> : null}
    </>
  );

  if (onOpen) {
    return (
      <button
        type="button"
        className="system-status-line system-status-line-button"
        onClick={onOpen}
        data-testid="system-status-line"
        title={
          line.variant === 'action_update'
            ? t('打开审批', 'Open approval')
            : t('打开任务', 'Open task')
        }
      >
        {body}
      </button>
    );
  }
  return (
    <div className="system-status-line" data-testid="system-status-line">
      {body}
    </div>
  );
}
