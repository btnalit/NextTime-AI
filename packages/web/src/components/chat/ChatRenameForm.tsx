import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import {
  CHAT_TITLE_MAX_CHARS,
  type ChatSummary,
  chatTitle,
  normalizeChatTitle,
  renameChat,
} from '../../lib/chat-lifecycle.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../ui/Button.js';
import { Input } from '../ui/Field.js';

export interface ChatRenameFormProps {
  /** The WS client — `rename_chat` is a `chat`-group capability. */
  readonly client: CapabilityCaller;
  readonly chat: ChatSummary;
  /** The kernel's updated row — the caller splices it into its cache. */
  readonly onSaved: (chat: ChatSummary) => void;
  readonly onCancel: () => void;
}

/**
 * components/chat/ChatRenameForm (S6-A W1, console-completion-plan §5.1 "归档与改名"): the inline
 * title editor a list row or the chat header swaps in for "改名 Rename". Enter saves, Escape
 * cancels; the title is normalized the way the kernel will (`normalizeChatTitle`) and a blank
 * result is refused here rather than sent to a 400. Key events stop at the input so the row
 * (`DataRow`'s Enter/Space activation) never opens the chat mid-edit.
 */
export function ChatRenameForm({ client, chat, onSaved, onCancel }: ChatRenameFormProps) {
  const t = useT();
  const [value, setValue] = useState(chat.title ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function save(): Promise<void> {
    const title = normalizeChatTitle(value);
    if (title === null) {
      setError(t('标题不能为空', 'Title cannot be blank'));
      inputRef.current?.focus();
      return;
    }
    if (title === chat.title) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await renameChat(client, chat.id, title));
    } catch (err) {
      setError(describeError(err).message);
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="stack-s grow" data-testid="chat-rename-form">
      <div className="row">
        <Input
          ref={inputRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          maxLength={CHAT_TITLE_MAX_CHARS * 2}
          placeholder={chatTitle(chat, t)}
          aria-label={t('对话标题', 'Chat title')}
          aria-invalid={error !== null || undefined}
          disabled={busy}
          data-testid="chat-rename-input"
        />
        <Button
          variant="primary"
          size="s"
          loading={busy}
          onClick={() => void save()}
          data-testid="chat-rename-save"
        >
          {t('保存', 'Save')}
        </Button>
        <Button variant="ghost" size="s" onClick={onCancel} disabled={busy}>
          {t('取消', 'Cancel')}
        </Button>
      </div>
      {error !== null ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
