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
  const chip =
    line.variant === 'action_update' ? (
      <StatusChip machine="actionRequest" status={line.status} size="s" />
    ) : (
      <StatusChip machine="task" status={line.status} size="s" />
    );
  const body = (
    <>
      {chip}
      <span className="system-status-text">{line.text}</span>
      {line.variant === 'task_update' && line.failureReason ? (
        <span className="text-3">({line.failureReason})</span>
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
        title={line.variant === 'action_update' ? 'Open approval' : 'Open task'}
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
