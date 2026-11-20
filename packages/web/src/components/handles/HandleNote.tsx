import { HANDLE_NOTE_MAX_LENGTH } from '@nexttime/shared';
import { useEffect, useRef } from 'react';
import { describeError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { Field, describedBy } from '../kit/field.js';

/**
 * Whether issuing a Handle was refused for its note: the kernel refuses a note that looks like a
 * credential before anything is written (`issue_handle` / `issue_service_handle`, legacy 168) —
 * `credentials_in_text`, as other notes are, or `invalid_params` naming the note.
 */
export function isNoteRefused(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const { code, message } = describeError(err);
  if (code === 'credentials_in_text') return true;
  return code === 'invalid_params' && /\bnote looks like a credential\b/.test(message);
}

/**
 * components/handles/HandleNote (legacy 168, 902): the optional note a person gives a Handle's
 * session when issuing it — what the client is for — shown beside the session in 「会话凭证」 so
 * two sessions of one kind (two Claude Code clients, two collectors of one service account) can be
 * told apart. A refusal for a credential-looking note is said on this field.
 */
export function HandleNoteField({
  id,
  value,
  onChange,
  disabled,
  error,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  /** The last issuing error; said here when it was the note's. */
  readonly error: unknown;
}) {
  const t = useT();
  const refused = isNoteRefused(error);
  // The refusal is said on this field, so the reader lands here to change it.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isNoteRefused(error)) inputRef.current?.focus();
  }, [error]);
  return (
    <Field
      id={id}
      label={t('备注（可选）', 'Note (optional)')}
      hint={t(
        '写这个凭证给谁用、做什么，比如「笔记本上的 Claude Code」「备份采集器」。会显示在「会话凭证」列表里，也会写进审计记录：能看本工作区审计的人（所有者、审计员）和平台管理员都看得到，凭证结束后也不会删除。不要写凭证，也不要写不想让他们看到的内容。',
        'Who uses this Handle and for what, such as "Claude Code on my laptop" or "backup collector". It is shown in the Handles list and written to the audit log: whoever can read this workspace’s audit (owners, auditors) and platform administrators can see it, and it is not deleted when the Handle ends. Never put a credential here, or anything you would not want them to read.',
      )}
      error={
        refused
          ? t(
              '备注看起来带了凭证（token、key 或密码的值），没有签发。改成写它的用途。',
              'The note looks like it carries a credential (a token, key or password value), so nothing was issued. Say what it is for instead.',
            )
          : null
      }
    >
      <input
        ref={inputRef}
        id={id}
        className="input"
        value={value}
        maxLength={HANDLE_NOTE_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={refused || undefined}
        aria-describedby={describedBy(id, true, refused)}
        autoComplete="off"
      />
    </Field>
  );
}

/** The issued session as 「会话凭证」 will name it: its short id and the note given it. */
export function IssuedSession({
  shortId,
  note,
  testId,
}: {
  readonly shortId: string;
  readonly note: string | null;
  readonly testId: string;
}) {
  const t = useT();
  return (
    <p className="text-3 text-small" style={{ margin: 0 }} data-testid={testId}>
      {t('会话 ', 'Session ')}
      <span className="mono" data-volatile="" data-testid={`${testId}-short`}>
        {shortId}
      </span>
      {note !== null ? (
        <>
          {t('，备注：', '; note: ')}
          <span data-testid={`${testId}-note`}>{note}</span>
        </>
      ) : null}
      {t('。在「会话凭证」列表里按这个编号找到它。', '. Find it by this id in the Handles list.')}
    </p>
  );
}
