import { useEffect, useMemo, useState } from 'react';
import type { Permissions } from '../../hooks/usePermissions.js';
import { actionCardFromPendingContent } from '../../lib/action-card.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { humanizeKind } from '../../lib/format.js';
import type { Translate } from '../../lib/i18n.js';
import { systemStatusLineFromMessage } from '../../lib/system-status.js';
import type { ChatMessage, WsClient } from '../../lib/ws-client.js';

/** The minimum shape `useActionCards` needs from `useToast()` — kept local (not `ToastApi` from
 *  `components/ui/Toast`) so this file imports nothing from `components/ui/*`
 *  (S8 §5e risk ①, `scripts/guards/css-tokens.mjs`). Structurally compatible with the real
 *  `ToastApi`, so passing it straight through from `ChatPage` needs no adapter. */
export interface ToastPusher {
  readonly push: (input: {
    readonly tone?: 'info' | 'ok' | 'warn' | 'danger';
    readonly title: string;
    readonly description?: string;
  }) => number;
}

export interface ActionCardsState {
  readonly actionStatusOverrides: Readonly<Record<string, string>>;
  readonly latestActionStatus: ReadonlyMap<string, string>;
  readonly cardErrors: Readonly<Record<string, unknown>>;
  readonly handleApprove: (
    id: string,
    options: { readonly reason: string | undefined; readonly alwaysAllow: boolean },
  ) => Promise<void>;
  readonly handleReject: (id: string, reason: string | undefined) => Promise<void>;
}

/**
 * components/chat/useActionCards: inline approval cards (`system.action_pending`) on `ChatPage`
 * (S6-A). Their status is kept current by two converging signals — a live `action.updated` push
 * (`actionStatusOverrides`) and any later `system.action_update` message already in this chat
 * (`latestActionStatus`, scanned out of `messages`).
 */
export function useActionCards(
  client: WsClient,
  http: CapabilityCaller,
  messages: readonly ChatMessage[],
  toast: ToastPusher,
  t: Translate,
  permissions: Permissions,
): ActionCardsState {
  const [actionStatusOverrides, setActionStatusOverrides] = useState<
    Readonly<Record<string, string>>
  >({});
  /** The last failed decision call per ActionRequest — `ActionRequestCard` renders it; the card
   *  owns its own busy state (S6-A `ui/ApprovalCard`), so the handlers below only need to settle. */
  const [cardErrors, setCardErrors] = useState<Readonly<Record<string, unknown>>>({});

  useEffect(
    () =>
      client.onActionUpdated((event) => {
        setActionStatusOverrides((prev) => ({ ...prev, [event.id]: event.status }));
      }),
    [client],
  );

  const latestActionStatus = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of messages) {
      const line = systemStatusLineFromMessage(message);
      if (line?.variant === 'action_update') map.set(line.actionRequestId, line.status);
    }
    return map;
  }, [messages]);

  function setCardError(id: string, error: unknown): void {
    setCardErrors((prev) => {
      if (error === null) {
        if (!(id in prev)) return prev;
        const { [id]: _dropped, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: error };
    });
  }

  async function handleApprove(
    id: string,
    options: { readonly reason: string | undefined; readonly alwaysAllow: boolean },
  ): Promise<void> {
    setCardError(id, null);
    try {
      // C25: `reason` travels with approve (required by the kernel for a high blast radius —
      // `ui/ApprovalCard` validates that in front of the call; a kernel 400 still lands below).
      const result = await http.call<{ status: string }>('approve', {
        actionRequestId: id,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      });
      setActionStatusOverrides((prev) => ({ ...prev, [id]: result.status }));
    } catch (err) {
      setCardError(id, err);
      return;
    }
    if (!options.alwaysAllow) return;
    const card = messages
      .map((m) => (m.content ? actionCardFromPendingContent(m.content) : undefined))
      .find((c) => c?.actionRequestId === id);
    // C8 (console-completion-plan §2b): the persisted `system.action_pending` message is the
    // only source of the kind tag here. Without it — a push that outran persistence, a card
    // this closure no longer sees — there is nothing to write a rule for; say so instead of
    // calling `set_auto_approved_action_kind` with `actionKindTag: undefined`.
    if (!card) {
      toast.push({
        tone: 'warn',
        title: t(
          '已批准，但未写入自动批准规则',
          'Approved, but the auto-approval rule was not written',
        ),
        description: t(
          '这个请求的动作种类尚未到达此对话。',
          'The action kind of this request is not known to this chat yet.',
        ),
      });
      return;
    }
    try {
      await http.call('set_auto_approved_action_kind', { actionKindTag: card.actionKindTag });
      // S8 W4 i18n baseline: was a raw un-t()'d template literal splicing the enum value
      // (`actionKindTag`) straight into glued zh/en text — `humanizeKind` (same helper
      // `ApprovalQueuePage`'s own toast already uses for this) instead of the raw tag.
      toast.push({
        tone: 'info',
        title: t(
          `今后将自动批准 ${humanizeKind(card.actionKindTag)}`,
          `Will be auto-approved from now on: ${humanizeKind(card.actionKindTag)}`,
        ),
      });
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('set_auto_approved_action_kind');
      toast.push({
        tone: 'warn',
        title: t(
          '已批准，但未写入自动批准规则',
          'Approved, but the auto-approval rule was not written',
        ),
      });
    }
  }

  async function handleReject(id: string, reason: string | undefined): Promise<void> {
    setCardError(id, null);
    try {
      const result = await http.call<{ status: string }>('reject', {
        actionRequestId: id,
        ...(reason !== undefined ? { reason } : {}),
      });
      setActionStatusOverrides((prev) => ({ ...prev, [id]: result.status }));
    } catch (err) {
      setCardError(id, err);
    }
  }

  return { actionStatusOverrides, latestActionStatus, cardErrors, handleApprove, handleReject };
}
