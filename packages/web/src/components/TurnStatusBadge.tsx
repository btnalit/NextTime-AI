import type { TurnStatus } from '../lib/streaming-reducer.js';

const LABELS: Record<TurnStatus, string> = {
  idle: '',
  running: 'Agent is responding…',
  completed: 'Turn completed',
  interrupted: 'Turn interrupted',
  failed: 'Turn failed',
};

/** components/TurnStatusBadge: renders `TurnState.status` (lib/streaming-reducer.ts), fed by
 *  `send_chat_message`'s result and `chat.metadata` pushes (docs/development-tasks.md S1.8
 *  deliverable 1: "Turn status badge from chat.metadata/send result"). */
export function TurnStatusBadge({ status }: { readonly status: TurnStatus }) {
  if (status === 'idle') return null;
  return <span className={`turn-badge turn-badge-${status}`}>{LABELS[status]}</span>;
}
