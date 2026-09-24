import { useRef } from 'react';
import { useNotifyChatChanged } from '../../hooks/useChatUpdates.js';
import {
  type ChatSummary,
  archiveChat,
  chatTitle,
  unarchiveChat,
} from '../../lib/chat-lifecycle.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { Confirm } from '../kit/confirm.js';
import { useToast } from '../ui/Toast.js';

export interface ChatArchiveConfirmProps {
  /** The WS client — `archive_chat` / `unarchive_chat` are `chat`-group capabilities. */
  readonly client: CapabilityCaller;
  /** The chat to archive; `null` = closed. The owner sets it from a row's / the header's 归档. */
  readonly chat: ChatSummary | null;
  /** The kernel's updated row after the archive and after an undo — the owner splices it. Also
   *  broadcast via `hooks/useChatUpdates.tsx` for whichever page is mounted when the undo fires
   *  (遗留 57) — this callback still runs first, when the owner is still around to receive it. */
  readonly onChanged: (chat: ChatSummary) => void;
  readonly onClose: () => void;
}

/**
 * components/chat/ChatArchiveConfirm (S6-A W1, S8 W1-A7; console-completion-plan §5.9 principle 4
 * "低 · 可逆 → 直接执行 + Toast 撤销"): archive as `kit/confirm` tier `low` — it runs the moment
 * `chat` is set and the toast offers 撤销 Undo, which is `unarchive_chat` (the exact inverse; both
 * idempotent). Rendered once by the page / header that owns the list cache, never inside a row:
 * the archive splice removes the row, and a confirm mounted there would be torn down before the
 * toast is pushed (`Confirm`'s low tier drops everything after an unmount). `kit/confirm` carries
 * no toast system of its own (S8 risk ① — a new `components/kit/*` file may not import
 * `components/ui/*`), so this caller wires its own `useToast().push` through as `notify`.
 */
export function ChatArchiveConfirm({ client, chat, onChanged, onClose }: ChatArchiveConfirmProps) {
  const toast = useToast();
  // 遗留 57: the confirm toast (and its 撤销 Undo action) is pushed through the app-root
  // `ToastProvider` and can outlive this component — the owning page may have been navigated away
  // from by the time either fires. `onChanged` still updates *this* page's own state when it is
  // still around to receive it; `notifyChatChanged` additionally reaches whichever page (this one,
  // a different one, or none) is mounted at that moment (`hooks/useChatUpdates.tsx`).
  const notifyChatChanged = useNotifyChatChanged();
  // `Confirm`'s low tier keys its effect on `open` alone and reads the callbacks through a ref;
  // the undo closure it captures must reach the *current* chat and `onChanged` the same way.
  const latest = useRef({ chat, onChanged, notifyChatChanged });
  latest.current = { chat, onChanged, notifyChatChanged };
  return (
    <Confirm
      tier="low"
      open={chat !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`已归档 Archived · ${chatTitle(chat)}`}
      onConfirm={async () => {
        const target = latest.current.chat;
        if (!target) return;
        const updated = await archiveChat(client, target.id);
        latest.current.onChanged(updated);
        latest.current.notifyChatChanged(updated);
      }}
      notify={toast.push}
      undo={{
        onUndo: async () => {
          const target = chat;
          if (!target) return;
          try {
            const updated = await unarchiveChat(client, target.id);
            latest.current.onChanged(updated);
            latest.current.notifyChatChanged(updated);
          } catch (err) {
            toast.push({
              tone: 'danger',
              title: '撤销失败 Could not undo the archive',
              description: describeError(err).message,
            });
          }
        },
      }}
    />
  );
}
