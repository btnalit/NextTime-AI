import type { ReactNode } from 'react';
import { namedReviewPath } from '../../lib/credential-review.js';
import { useT } from '../../lib/i18n.js';

/** The kernel's own cap on `suspectedSecretPaths` (governance/redaction/credential-review.ts). */
const MAX_LISTED_PATHS = 20;

export interface CredentialReviewProps {
  /** The kernel's count (> 0) — the component renders nothing for 0. */
  readonly count: number;
  /** Where the kernel found them: field paths (`headers.Authorization`, `steps[1].run`), never a
   *  value. Empty when the kernel did not say. */
  readonly paths?: readonly string[];
  /** The console's names for the content's top-level fields (`lib/credential-review.ts`
   *  `reviewFieldNames`), so a path reads as the editor's own label. */
  readonly fieldNames?: Readonly<Record<string, string>>;
  /** What takes effect: the copy differs for an approval (params run as they are) and a publish
   *  (the content goes live for every agent that uses it). */
  readonly subject: 'approve' | 'publish';
  /** Where the person checks the content, when it is not on this screen (e.g. a link to the
   *  draft's detail). */
  readonly where?: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

/**
 * components/kit/credential-review (decision 2026-10-09 "二次确认"): the warning and the explicit
 * confirmation a person gives before content carrying suspected credentials takes effect. It names
 * the fields the kernel flagged, so the question is "should these fields carry a credential?" —
 * answerable even where the console hides a value by its field name. The caller keeps Approve /
 * Publish disabled until `checked` and sends `credentialsReviewed: true` with the call
 * (lib/credential-review.ts). The kernel enforces the same rule; this is the question in front of
 * its 400, not the gate.
 */
export function CredentialReview({
  count,
  paths = [],
  fieldNames,
  subject,
  where,
  checked,
  onChange,
  disabled = false,
}: CredentialReviewProps) {
  const t = useT();
  if (count <= 0) return null;
  // One field can hold several values, so a count above the paths is normal; only a full list (the
  // kernel names at most 20) may be leaving fields out.
  const more = paths.length >= MAX_LISTED_PATHS && count > paths.length;
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
              '下列参数字段的值看起来像密钥、令牌或密码，批准后会原样用于执行。按字段名识别的值在参数里显示为 [redacted]，不显示原文。',
              'These parameter fields hold values that look like a key, token or password; approving runs them as they are. Values recognised by their field name show as [redacted] in the parameters, never in full.',
            )
          : t(
              '内容中下列位置的值看起来像密钥、令牌或密码，发布后会原样提供给使用它的 agent。',
              'These places in the content hold values that look like a key, token or password; publishing gives them as they are to every agent that uses it.',
            )}
      </p>
      {paths.length > 0 ? (
        <ul
          className="m-0 flex flex-wrap gap-1 list-none p-0"
          data-testid="credential-review-paths"
        >
          {paths.map((path) => (
            <li key={path}>
              <code className="mono">{namedReviewPath(path, fieldNames)}</code>
            </li>
          ))}
          {more ? <li className="text-3">{t('等', 'and more')}</li> : null}
        </ul>
      ) : null}
      {where !== undefined ? (
        <p className="m-0" data-testid="credential-review-where">
          {where}
        </p>
      ) : null}
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
            '已核对凭据：这些字段本来就应该带凭据，确认按原样使用（记入审计）。',
            'Credentials reviewed: these fields are meant to carry a credential; use them as they are (recorded in the audit log).',
          )}
        </span>
      </label>
    </fieldset>
  );
}
