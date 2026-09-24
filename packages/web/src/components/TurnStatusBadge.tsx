import { useT } from '../lib/i18n.js';
import type { TurnStatus } from '../lib/streaming-reducer.js';

/** S8 W1-A10 (i18n remainder): bilingual, picked by `t()` — was a combined "中文 English" literal
 *  that ignored the language switch entirely (the one badge in the app that did, B4 pre-dates the
 *  S8 redesign); `data-status` on the badge itself is the language-independent hook for
 *  tests/e2e, not the visible text. */
const LABELS: Readonly<Record<TurnStatus, { readonly zh: string; readonly en: string } | null>> = {
  idle: null,
  running: { zh: '回复中', en: 'Agent is responding' },
  completed: { zh: '本轮完成', en: 'Turn completed' },
  interrupted: { zh: '本轮中断', en: 'Turn interrupted' },
  failed: { zh: '本轮失败', en: 'Turn failed' },
};

/** components/TurnStatusBadge: renders `TurnState.status` (lib/streaming-reducer.ts), fed by
 *  `send_chat_message`'s result and `chat.metadata` pushes (S1.8 deliverable 1). `TurnStatus` is
 *  the chat page's own ephemeral state, not a `@nexttime/shared` enum — hence its own labels. */
export function TurnStatusBadge({ status }: { readonly status: TurnStatus }) {
  const t = useT();
  if (status === 'idle') return null;
  const entry = LABELS[status];
  return (
    <span className={`turn-badge turn-badge-${status}`} data-status={status}>
      <span
        className={`conn-dot conn-dot-${status === 'running' ? 'connecting' : 'connected'}`}
        aria-hidden
      />
      {entry ? t(entry.zh, entry.en) : null}
    </span>
  );
}
