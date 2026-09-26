import { actionCardFromPendingContent, isPendingCardMessage } from '../../lib/action-card.js';
import { messageRoleLabel } from '../../lib/chat-messages.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatTime } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { systemStatusLineFromMessage } from '../../lib/system-status.js';
import type { ChatMessage } from '../../lib/ws-client.js';
import { ActionRequestCard } from '../ActionRequestCard.js';
import { SystemStatusLineView } from '../SystemStatusLineView.js';
import { MessageBody } from './MessageBody.js';
import { MessageReferences } from './MessageReferences.js';

export interface ChatMessageRowProps {
  readonly message: ChatMessage;
  readonly http: CapabilityCaller;
  readonly actionStatusOverrides: Readonly<Record<string, string>>;
  readonly latestActionStatus: ReadonlyMap<string, string>;
  readonly cardErrors: Readonly<Record<string, unknown>>;
  readonly canAlwaysAllow: boolean;
  readonly onApprove: (
    id: string,
    options: { readonly reason: string | undefined; readonly alwaysAllow: boolean },
  ) => Promise<void>;
  readonly onReject: (id: string, reason: string | undefined) => Promise<void>;
  readonly onOpenApproval: (actionRequestId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}

/**
 * components/chat/ChatMessageRow: one row of `ChatPage`'s thread — an inline approval card
 * (`system.action_pending`, on the shared `ui/ApprovalCard` via `ActionRequestCard`), a compact
 * system notice (`system.action_update` / `system.task_update`, `SystemStatusLineView`) that opens
 * the matching Approvals/Tasks drawer, or an ordinary message body. Split out of `ChatPage` itself
 * (console redesign P1) because, unlike the rest of that page's JSX, it imports nothing from
 * `components/ui/*` and can live in its own file under the guard `scripts/guards/
 * legacy-ui-importers.json` sets for new files.
 */
export function ChatMessageRow({
  message,
  http,
  actionStatusOverrides,
  latestActionStatus,
  cardErrors,
  canAlwaysAllow,
  onApprove,
  onReject,
  onOpenApproval,
  onOpenTask,
}: ChatMessageRowProps) {
  const t = useT();
  if (isPendingCardMessage(message) && message.content) {
    const card = actionCardFromPendingContent(message.content);
    if (card) {
      const effectiveStatus =
        actionStatusOverrides[card.actionRequestId] ??
        latestActionStatus.get(card.actionRequestId) ??
        card.status;
      return (
        <ActionRequestCard
          key={message.sequence}
          card={{ ...card, status: effectiveStatus }}
          error={cardErrors[card.actionRequestId] ?? null}
          onApprove={onApprove}
          onReject={onReject}
          canAlwaysAllow={canAlwaysAllow}
        />
      );
    }
  }
  const statusLine = systemStatusLineFromMessage(message);
  if (statusLine) {
    return (
      <SystemStatusLineView
        key={message.sequence}
        line={statusLine}
        onOpen={() =>
          statusLine.variant === 'action_update'
            ? onOpenApproval(statusLine.actionRequestId)
            : onOpenTask(statusLine.taskId)
        }
      />
    );
  }
  return (
    <div
      key={message.sequence}
      className={`message message-${message.role}`}
      data-role={message.role}
    >
      <MessageBody messageRole={message.role} text={message.text} />
      {message.role === 'assistant' ? <MessageReferences http={http} text={message.text} /> : null}
      <div className="message-meta">
        <span>{messageRoleLabel(message.role, t)}</span>
        <time title={formatDateTime(message.createdAt)}>{formatTime(message.createdAt)}</time>
      </div>
    </div>
  );
}
