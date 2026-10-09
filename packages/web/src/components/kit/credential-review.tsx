import { useT } from '../../lib/i18n.js';

export interface CredentialReviewProps {
  /** The kernel's count (> 0) — the component renders nothing for 0. */
  readonly count: number;
  /** What takes effect: the copy differs for an approval (params run as they are) and a publish
   *  (the content goes live for every agent that uses it). */
  readonly subject: 'approve' | 'publish';
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

/**
 * components/kit/credential-review (decision 2026-10-09 "二次确认"): the warning and the explicit
 * confirmation a person gives before content carrying suspected credentials takes effect. The
 * caller keeps Approve / Publish disabled until `checked` and sends `credentialsReviewed: true`
 * with the call (lib/credential-review.ts). The kernel enforces the same rule; this is the
 * question in front of its 400, not the gate.
 */
export function CredentialReview({
  count,
  subject,
  checked,
  onChange,
  disabled = false,
}: CredentialReviewProps) {
  const t = useT();
  if (count <= 0) return null;
  return (
    <fieldset
      className="notice notice-warn m-0 min-w-0 flex-col items-stretch"
      aria-label={t('核对疑似凭据', 'Review suspected credentials')}
      data-testid="credential-review"
      data-count={count}
    >
      <p className="m-0" data-testid="credential-review-warning">
        <strong>{t(`含 ${count} 处疑似凭据。`, `${count} suspected credential value(s).`)}</strong>{' '}
        {subject === 'approve'
          ? t(
              '参数里有看起来像密钥、令牌或密码的值，批准后会原样用于执行。请先在上方参数中核对。',
              'The parameters hold values that look like a key, token or password; approving runs them as they are. Check them in the parameters above first.',
            )
          : t(
              '内容里有看起来像密钥、令牌或密码的值，发布后会原样提供给使用它的 agent。请先核对内容。',
              'The content holds values that look like a key, token or password; publishing gives them as they are to every agent that uses it. Check the content first.',
            )}
      </p>
      <label className="flex items-start gap-2 text-13 text-text">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5"
          data-testid="credential-review-confirm"
        />
        <span>
          {t(
            '已核对凭据：这些值是有意放在这里的，确认按原样使用（记入审计）。',
            'Credentials reviewed: these values are here on purpose; use them as they are (recorded in the audit log).',
          )}
        </span>
      </label>
    </fieldset>
  );
}
