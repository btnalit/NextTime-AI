import type { CapabilityCaller } from '../lib/clients.js';
import { useT } from '../lib/i18n.js';
import { ChatListPane } from './chat/ChatListPane.js';
import { EmptyState } from './kit/empty-state.js';
import { ExecutionReadinessCard } from './readiness/ExecutionReadinessCard.js';

export type { ChatSummary } from '../lib/chat-lifecycle.js';

export interface ChatListPageProps {
  /** The WS client — `list_chats` / `new_chat` / `archive_chat` / `unarchive_chat` /
   *  `rename_chat` are `chat`-group capabilities (WS-eligible). */
  readonly client: CapabilityCaller;
  /** S8 W2 U3a (ui-audit-2026-09-23 J1): `execution_readiness` is `group:'governance'`, not
   *  `chat` — the `ws` client above only carries `chat`-group capabilities
   *  (`lib/clients.ts`'s own doc comment) — so `ExecutionReadinessCard` needs the workspace `http`
   *  caller separately. See that component's own doc comment for why this page, rather than
   *  `PlatformOverviewPage`, is where J1's "执行就绪" check lives. */
  readonly http: CapabilityCaller;
  readonly onSelectChat: (chatId: string) => void;
}

/**
 * components/ChatListPage (console redesign P3-2, V3 "对话"): the chat-list route. The three-pane
 * layout (`Chat.dc.html`) is shared with `ChatPage` through `chat/ChatListPane` — this page renders
 * that pane plus a conversation area that has nothing open yet, instead of the pre-redesign
 * standalone list page (breadcrumb/page-header + a full-width row list, S6-A). `ExecutionReadinessCard`
 * stays exactly where it rendered before (`ChatListPane`'s own doc comment does not own it — a
 * parallel slice, P3-3, redesigns it): a slim strip above the two-pane row, only on this route (an
 * open chat, `ChatPage`, never showed it either).
 */
export function ChatListPage({ client, http, onSelectChat }: ChatListPageProps) {
  const t = useT();
  return (
    <div className="chat-page" data-testid="chats-page">
      <div className="chat-workspace-banner">
        <ExecutionReadinessCard http={http} />
      </div>
      <div className="chat-workspace" data-active-pane="list">
        <ChatListPane client={client} onSelectChat={onSelectChat} />
        <div className="chat-conversation-pane chat-conversation-pane-empty">
          <EmptyState
            title={t('选一个对话，或开始新对话', 'Pick a chat, or start a new one')}
            body={t(
              '入口 agent 可以观察系统、提出动作并代表你派发 Worker。',
              'The entry agent can observe systems, propose actions and spawn Workers on your behalf.',
            )}
            testId="chat-conversation-empty"
          />
        </div>
      </div>
    </div>
  );
}
