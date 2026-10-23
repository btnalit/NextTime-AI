import { SECRET_FIELD_MASK } from '@nexttime/shared';
import { useT } from '../../lib/i18n.js';

/** Whether `value` — a string, or any JSON value walked into — shows the kernel's `[redacted]`
 *  somewhere. */
export function showsRedaction(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(SECRET_FIELD_MASK);
  if (value === null || typeof value !== 'object') return false;
  return (Array.isArray(value) ? value : Object.values(value)).some(showsRedaction);
}

export interface RedactedNoteProps {
  /** The text (or JSON value) shown above; the note renders only when it carries `[redacted]`. */
  readonly value: unknown;
  readonly testId?: string;
}

/**
 * components/kit/redacted-note (legacy 420): the line under text a person or an agent wrote that
 * the kernel reads out masked — a reject reason, a Decision's rationale, a Fact's invalidation
 * reason, a human attestation, an Operation's description, an audit payload. Each value that
 * looked like a credential reads as `[redacted]` on every surface, the console's and every
 * agent's alike, so the note says what the word stands for instead of leaving it unexplained.
 * Renders nothing when nothing was masked.
 */
export function RedactedNote({ value, testId }: RedactedNoteProps) {
  const t = useT();
  if (!showsRedaction(value)) return null;
  return (
    <span className="text-3 text-small" data-testid={testId}>
      {t(
        '[redacted] 处的内容看起来像密码、令牌或密钥，控制台和 agent 读到的都是遮住后的样子。',
        'Each [redacted] stands for something that looked like a password, token or key; the console and agents only ever read it hidden.',
      )}
    </span>
  );
}
