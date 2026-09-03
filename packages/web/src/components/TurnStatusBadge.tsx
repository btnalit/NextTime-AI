import type { TurnStatus } from '../lib/streaming-reducer.js';

const LABELS: Record<TurnStatus, string> = {
  idle: '',
  running: 'Agent is responding',
  completed: 'Turn completed',
  interrupted: 'Turn interrupted',
  failed: 'Turn failed',
};

/** components/TurnStatusBadge: renders `TurnState.status` (lib/streaming-reducer.ts), fed by
 *  `send_chat_message`'s result and `chat.metadata` pushes (S1.8 deliverable 1). `TurnStatus` is
 *  the chat page's own ephemeral state, not a `@nexttime/shared` enum — hence its own labels. */
export function TurnStatusBadge({ status }: { readonly status: TurnStatus }) {
  if (status === 'idle') return null;
  return (
    <span className={`turn-badge turn-badge-${status}`} data-status={status}>
      <span className={`conn-dot conn-dot-${status === 'running' ? 'connecting' : 'connected'}`} aria-hidden />
      {LABELS[status]}
    </span>
  );
}
