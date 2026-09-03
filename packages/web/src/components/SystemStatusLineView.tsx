import type { SystemStatusLineData } from '../lib/system-status.js';

/** components/SystemStatusLineView: the compact status line for `system.action_update`/
 *  `system.task_update` (docs/development-tasks.md S2.10 deliverable 2 — never a card, see
 *  `lib/system-status.ts`'s own module doc comment). */
export function SystemStatusLineView({ line }: { readonly line: SystemStatusLineData }) {
  return (
    <div className="system-status-line">
      <span className={`system-status-badge system-status-badge-${line.status}`}>
        {line.status}
      </span>
      <span>{line.text}</span>
      {line.variant === 'task_update' && line.failureReason && (
        <span className="hint">({line.failureReason})</span>
      )}
    </div>
  );
}
