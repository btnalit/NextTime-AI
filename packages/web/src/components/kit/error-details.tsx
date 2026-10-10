import { useT } from '../../lib/i18n.js';

export interface ErrorDetailsProps {
  /** The stable wire code (`lib/errors.ts` `describeError`). */
  readonly code: string;
  /** The kernel's (or browser's) own text; omitted when it adds nothing. */
  readonly raw: string | null;
  /** Put on the raw line as `<testId>-detail`. */
  readonly testId?: string;
}

/**
 * components/kit/error-details (console audit P1-1): the 「技术细节」 disclosure under an error —
 * the raw code in the summary (so a screenshot still names the exact kernel state) and the
 * kernel's own text inside. Collapsed: the body above it already says what happened and what to
 * do next, in the viewer's language; this is for the report to a platform administrator.
 */
export function ErrorDetails({ code, raw, testId }: ErrorDetailsProps) {
  const t = useT();
  return (
    <details className="error-details">
      <summary>
        {t('技术细节', 'Technical details')}
        <code className="error-banner-code">{code}</code>
      </summary>
      {raw ? (
        <p className="error-details-raw" data-testid={testId ? `${testId}-detail` : undefined}>
          {raw}
        </p>
      ) : null}
    </details>
  );
}
