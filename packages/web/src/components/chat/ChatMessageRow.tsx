import { useEffect, useState } from 'react';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import {
  type ActionRequestRowLike,
  actionCardFromPendingContent,
  isDecidable,
  isPendingCardMessage,
} from '../../lib/action-card.js';
import { messageRoleLabel } from '../../lib/chat-messages.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatTime } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { type LatestGoalStatus, systemStatusLineFromMessage } from '../../lib/system-status.js';
import type { ChatMessage } from '../../lib/ws-client.js';
import { ActionRequestCard, type ActionRequestCardProps } from '../ActionRequestCard.js';
import { SystemStatusLineView } from '../SystemStatusLineView.js';
import { GoalProposalCard } from './GoalProposalCard.js';
import { MessageBody } from './MessageBody.js';
import { MessageReferences } from './MessageReferences.js';
import { type ChatGoalRead, chatGoalLabel } from './useChatGoals.js';

export interface ChatMessageRowProps {
  readonly message: ChatMessage;
  readonly http: CapabilityCaller;
  readonly actionStatusOverrides: Readonly<Record<string, string>>;
  readonly latestActionStatus: ReadonlyMap<string, string>;
  readonly cardErrors: Readonly<Record<string, unknown>>;
  readonly canAlwaysAllow: boolean;
  readonly canDecide: boolean;
  /** The reader's own principal (`hooks/useWorkspaceIdentity`), when known. */
  readonly viewerId?: string | null;
  readonly onApprove: (
    id: string,
    options: { readonly reason: string | undefined; readonly alwaysAllow: boolean },
  ) => Promise<void>;
  readonly onReject: (id: string, reason: string | undefined) => Promise<void>;
  /** Absent when the reader cannot open an approval (`hooks/useCanOpen`): no entry leads there. */
  readonly onOpenApproval?: (actionRequestId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  /** S11 GO5e-2: each goal's latest status in this chat (`latestGoalStatuses`), for a proposal
   *  card once its goal has moved on. */
  readonly latestGoalStatus: ReadonlyMap<string, LatestGoalStatus>;
  /** The goals this chat names, each read once (`useChatGoals`). */
  readonly goals: ReadonlyMap<string, ChatGoalRead>;
  readonly onOpenGoal: (goalRunId: string) => void;
}

/**
 * components/chat/ChatMessageRow: one row of `ChatPage`'s thread — an inline approval card
 * (`system.action_pending`, on the shared `ui/ApprovalCard` via `ActionRequestCard`), a compact
 * system notice (`system.action_update` / `system.task_update`, `SystemStatusLineView`) that opens
 * the matching Approvals/Tasks drawer, a goal's proposal (`GoalProposalCard`) or one of its later
 * milestones (a status line opening the goal's page; S11 GO5e-2), or an ordinary message body. Split out of `ChatPage` itself
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
  canDecide,
  viewerId,
  onApprove,
  onReject,
  onOpenApproval,
  onOpenTask,
  latestGoalStatus,
  goals,
  onOpenGoal,
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
        <ChatActionCard
          key={message.sequence}
          http={http}
          card={{ ...card, status: effectiveStatus }}
          error={cardErrors[card.actionRequestId] ?? null}
          onApprove={onApprove}
          onReject={onReject}
          canAlwaysAllow={canAlwaysAllow}
          canDecide={canDecide}
          callerPrincipalId={viewerId ?? null}
        />
      );
    }
  }
  const statusLine = systemStatusLineFromMessage(message);
  if (statusLine?.variant === 'goal_update' && statusLine.change === 'propose') {
    return (
      <GoalProposalCard
        key={message.sequence}
        goalRunId={statusLine.goalRunId}
        read={goals.get(statusLine.goalRunId)}
        latestStatus={latestGoalStatus.get(statusLine.goalRunId)}
        viewerId={viewerId ?? null}
        createdAt={message.createdAt}
        onOpenGoal={onOpenGoal}
      />
    );
  }
  if (statusLine) {
    const goalRunId =
      statusLine.variant === 'goal_update'
        ? statusLine.goalRunId
        : statusLine.variant === 'task_update'
          ? statusLine.goalStep?.goalRunId
          : undefined;
    return (
      <SystemStatusLineView
        goalLabel={goalRunId ? chatGoalLabel(goals.get(goalRunId), t) : undefined}
        key={message.sequence}
        line={statusLine}
        onOpen={
          statusLine.variant === 'action_update'
            ? onOpenApproval
              ? () => onOpenApproval(statusLine.actionRequestId)
              : undefined
            : statusLine.variant === 'goal_update'
              ? () => onOpenGoal(statusLine.goalRunId)
              : () => onOpenTask(statusLine.taskId)
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
      {message.role === 'assistant' ? (
        // Console redesign P3-2 (V3): the assistant's own avatar + "入口 agent · time" row leads
        // the body (the artboard's `Chat.dc.html`), instead of trailing it — every other role
        // keeps the trailing meta line below.
        <div className="message-meta message-meta-lead">
          <span className="message-avatar" aria-hidden="true">
            A
          </span>
          <span>{messageRoleLabel(message.role, t)}</span>
          <time title={formatDateTime(message.createdAt)}>{formatTime(message.createdAt)}</time>
        </div>
      ) : null}
      <MessageBody messageRole={message.role} text={message.text} />
      {message.role === 'assistant' ? <MessageReferences http={http} text={message.text} /> : null}
      {message.role !== 'assistant' ? (
        <div className="message-meta">
          <span>{messageRoleLabel(message.role, t)}</span>
          <time title={formatDateTime(message.createdAt)}>{formatTime(message.createdAt)}</time>
        </div>
      ) : null}
    </div>
  );
}

/** The governance fields a chat message's card lacks (`lib/action-card`): whether it may be
 *  self-decided, which definition it was made under, and (legacy 245 d) the policy that sent it
 *  to approval — `system.action_pending` carries none of them. */
type CardGovernance = Pick<
  ActionRequestRowLike,
  'onBehalfOf' | 'requesterCanApprove' | 'publishedDefinition' | 'policyDecision'
>;

/**
 * A chat card the reader may decide, completed from its `get_action` row (dead-end sweep of
 * #592): a persisted `system.action_pending` message carries neither the self-approval rule nor
 * the published definition, so without the row the card would offer decisions or "总是允许" the
 * kernel must refuse. One read per decidable card; until it lands "总是允许" is simply not offered.
 */
function ChatActionCard({
  http,
  card,
  ...rest
}: ActionRequestCardProps & { readonly http: CapabilityCaller }) {
  const canGetAction = useRoleCan(http)('get_action') === true;
  const decidable = card.isHolder && rest.canDecide && canGetAction && isDecidable(card.status);
  const [governance, setGovernance] = useState<CardGovernance | null>(null);
  const id = card.actionRequestId;
  useEffect(() => {
    if (!decidable) return;
    let live = true;
    http
      .call<ActionRequestRowLike>('get_action', { actionRequestId: id })
      .then((row) => {
        if (!live) return;
        setGovernance({
          ...(row.onBehalfOf !== undefined ? { onBehalfOf: row.onBehalfOf } : {}),
          ...(row.requesterCanApprove !== undefined
            ? { requesterCanApprove: row.requesterCanApprove }
            : {}),
          ...(row.publishedDefinition !== undefined
            ? { publishedDefinition: row.publishedDefinition }
            : {}),
          ...(row.policyDecision ? { policyDecision: row.policyDecision } : {}),
        });
      })
      // Unreadable: the card keeps its decisions, offers no "总是允许", and links to the page.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [http, id, decidable]);
  return (
    <ActionRequestCard
      {...rest}
      card={
        governance
          ? {
              ...card,
              onBehalfOf: governance.onBehalfOf ?? card.onBehalfOf,
              ...(governance.requesterCanApprove !== undefined
                ? { requesterCanApprove: governance.requesterCanApprove }
                : {}),
              ...(governance.publishedDefinition !== undefined
                ? { publishedDefinition: governance.publishedDefinition }
                : {}),
              policyDecision: card.policyDecision ?? governance.policyDecision,
            }
          : card
      }
    />
  );
}
