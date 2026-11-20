import { HANDLE_NOTE_MAX_LENGTH } from '@nexttime/shared';
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
  return (
    <Field
      id={id}
      label={t('备注（可选）', 'Note (optional)')}
      hint={t(
        '写这个凭证给谁用、做什么，比如「笔记本上的 Claude Code」「备份采集器」。会显示在「会话凭证」列表里，工作区所有者都能看到，凭证结束后也会保留；不要写凭证本身。',
        'Who uses this Handle and for what, such as "Claude Code on my laptop" or "backup collector". It is shown in the Handles list, every workspace owner can see it, and it is kept after the Handle ends; never put the credential itself here.',
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
