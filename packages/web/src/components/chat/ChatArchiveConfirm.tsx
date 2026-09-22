import { useRef } from 'react';
import {
  type ChatSummary,
  archiveChat,
  chatTitle,
  unarchiveChat,
} from '../../lib/chat-lifecycle.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { ConfirmTier } from '../ui/ConfirmTier.js';
import { useToast } from '../ui/Toast.js';

export interface ChatArchiveConfirmProps {
  /** The WS client — `archive_chat` / `unarchive_chat` are `chat`-group capabilities. */
  readonly client: CapabilityCaller;
  /** The chat to archive; `null` = closed. The owner sets it from a row's / the header's 归档. */
  readonly chat: ChatSummary | null;
  /** The kernel's updated row after the archive and after an undo — the owner splices it. */
  readonly onChanged: (chat: ChatSummary) => void;
  readonly onClose: () => void;
}

/**
 * components/chat/ChatArchiveConfirm (S6-A W1; console-completion-plan §5.9 principle 4 "低 ·
 * 可逆 → 直接执行 + Toast 撤销"): archive as `ConfirmTier` tier `low` — it runs the moment `chat`
 * is set and the toast offers 撤销 Undo, which is `unarchive_chat` (the exact inverse; both
 * idempotent). Rendered once by the page / header that owns the list cache, never inside a row:
 * the archive splice removes the row, and a confirm mounted there would be torn down before the
 * toast is pushed (`ConfirmTier`'s low tier drops everything after an unmount).
 */
export function ChatArchiveConfirm({ client, chat, onChanged, onClose }: ChatArchiveConfirmProps) {
  const toast = useToast();
  // `ConfirmTier` low keys its effect on `open` alone and reads the callbacks through a ref; the
  // undo closure it captures must reach the *current* chat and `onChanged` the same way.
  const latest = useRef({ chat, onChanged });
  latest.current = { chat, onChanged };
  return (
    <ConfirmTier
      tier="low"
      open={chat !== null}
      title={`已归档 Archived · ${chatTitle(chat)}`}
      onConfirm={async () => {
        const target = latest.current.chat;
        if (!target) return;
        latest.current.onChanged(await archiveChat(client, target.id));
      }}
      onClose={onClose}
      undo={{
        onUndo: async () => {
          const target = chat;
          if (!target) return;
          try {
            latest.current.onChanged(await unarchiveChat(client, target.id));
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
