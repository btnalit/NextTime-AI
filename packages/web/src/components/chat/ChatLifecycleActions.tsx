import { useCallback, useState } from 'react';
import {
  type ChatSummary,
  chatTitle,
  isArchived,
  unarchiveChat,
} from '../../lib/chat-lifecycle.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../ui/Button.js';
import { useToast } from '../ui/Toast.js';

export interface ChatLifecycleActionsProps {
  readonly chat: ChatSummary;
  /** Starts a rename (the caller swaps in `ChatRenameForm`). Omit to hide the button — e.g. a
   *  workspace owner looking at someone else's chat, which the kernel would 403 on rename. */
  readonly onRename?: () => void;
  /** Asks the page to open its `ChatArchiveConfirm` for this chat. */
  readonly onArchive: () => void;
  /** `useRestoreChat().restore` — restore is the undo of archive and needs no ceremony. */
  readonly onRestore: () => void;
  readonly restoring?: boolean;
  readonly testIdPrefix?: string;
}

/**
 * components/chat/ChatLifecycleActions (S6-A W1, console-completion-plan §5.1 "归档与改名"): the
 * 改名 / 归档 / 恢复 buttons a chat list row and the open chat's header share. Presentation only:
 * archive goes through the page-level `ChatArchiveConfirm` (tier `low` + undo), because the
 * archive splice removes this very row from the active list — a confirm owned here would be
 * unmounted before it could toast. Restore is `useRestoreChat` below.
 */
export function ChatLifecycleActions({
  chat,
  onRename,
  onArchive,
  onRestore,
  restoring = false,
  testIdPrefix = 'chat',
}: ChatLifecycleActionsProps) {
  const t = useT();
  const archived = isArchived(chat);
  return (
    <div className="row" data-testid={`${testIdPrefix}-actions`}>
      {onRename !== undefined && !archived ? (
        <Button
          variant="ghost"
          size="s"
          onClick={onRename}
          data-testid={`${testIdPrefix}-rename`}
          title={t('改名', 'Rename this chat')}
        >
          {t('改名', 'Rename')}
        </Button>
      ) : null}
      {archived ? (
        <Button
          variant="ghost"
          size="s"
          onClick={onRestore}
          loading={restoring}
          data-testid={`${testIdPrefix}-restore`}
          title={t('恢复到活跃列表', 'Restore to the active list')}
        >
          {t('恢复', 'Restore')}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="s"
          onClick={onArchive}
          data-testid={`${testIdPrefix}-archive`}
          title={t(
            '归档（可撤销）Archive —',
            'hidden from the list, provenance kept; undo from the toast',
          )}
        >
          {t('归档', 'Archive')}
        </Button>
      )}
    </div>
  );
}

/**
 * `unarchive_chat` with a toast, shared by the list (恢复 on the 已归档 tab) and the header of an
 * archived chat. The toast is pushed *before* `onChanged` so it is on screen even when the splice
 * unmounts the button that started it. Returns the kernel's row through `onChanged`.
 */
export function useRestoreChat(
  client: CapabilityCaller,
  onChanged: (chat: ChatSummary) => void,
): { readonly restore: (chat: ChatSummary) => Promise<void>; readonly restoringId: string | null } {
  const t = useT();
  const toast = useToast();
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const restore = useCallback(
    async (chat: ChatSummary): Promise<void> => {
      setRestoringId(chat.id);
      try {
        const restored = await unarchiveChat(client, chat.id);
        toast.push({
          tone: 'ok',
          title: `${t('已恢复', 'Restored')} · ${chatTitle(restored, t)}`,
          key: `chat-restore:${chat.id}`,
        });
        onChanged(restored);
      } catch (err) {
        toast.push({
          tone: 'danger',
          title: t('恢复失败', 'Could not restore the chat'),
          description: describeError(err).message,
          key: `chat-restore:${chat.id}`,
        });
      } finally {
        setRestoringId((current) => (current === chat.id ? null : current));
      }
    },
    [client, onChanged, toast, t],
  );
  return { restore, restoringId };
}
