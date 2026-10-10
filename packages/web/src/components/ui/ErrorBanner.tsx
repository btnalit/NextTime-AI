import { type ErrorOverrides, presentError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { ErrorDetails } from '../kit/error-details.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

export interface ErrorBannerProps {
  readonly error: unknown;
  /** Shown as a Retry button when given — the `error` state is never a dead end. */
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly retrying?: boolean;
  /** Optional lead-in replacing the code-derived title ("Could not load approvals"). */
  readonly title?: string;
  /** This page's own body copy for particular codes (P1-1), e.g. `{ forbidden: '只有所有者能…' }`;
   *  it wins over the shared copy for that code. */
  readonly overrides?: ErrorOverrides;
  readonly testId?: string;
}

/**
 * components/ui/ErrorBanner: the `error` state. A readable title and body with the next step
 * (`lib/errors.ts` `presentError`); the kernel's stable code and own text in the 「技术细节」
 * disclosure so a screenshot is still diagnosable; a Retry button when the caller can re-run
 * the load.
 */
export function ErrorBanner({
  error,
  onRetry,
  retryLabel,
  retrying = false,
  title,
  overrides,
  testId,
}: ErrorBannerProps) {
  const t = useT();
  const shown = presentError(error, t, overrides);
  return (
    <div className="error-banner" role="alert" data-testid={testId} data-error-code={shown.code}>
      <Icon name="alert" />
      <div className="error-banner-body">
        <div className="error-banner-title">
          <span>{title ?? shown.title}</span>
        </div>
        <p className="error-banner-message">{shown.message}</p>
        <ErrorDetails code={shown.code} raw={shown.raw} testId={testId} />
      </div>
      {onRetry ? (
        <div className="error-banner-actions">
          <Button variant="secondary" size="s" icon="refresh" onClick={onRetry} loading={retrying}>
            {retryLabel ?? t('重试', 'Retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
