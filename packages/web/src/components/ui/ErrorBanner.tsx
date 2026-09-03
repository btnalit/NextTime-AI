import { describeError } from '../../lib/errors.js';
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
  readonly testId?: string;
}

/**
 * components/ui/ErrorBanner: the `error` state. Always shows the kernel's stable code
 * (`lib/errors.ts` `describeError`) next to the message so a screenshot is diagnosable, and a
 * Retry button when the caller can re-run the load.
 */
export function ErrorBanner({
  error,
  onRetry,
  retryLabel = 'Retry',
  retrying = false,
  title,
  testId,
}: ErrorBannerProps) {
  const described = describeError(error);
  return (
    <div
      className="error-banner"
      role="alert"
      data-testid={testId}
      data-error-code={described.code}
    >
      <Icon name="alert" />
      <div className="error-banner-body">
        <div className="error-banner-title">
          <span>{title ?? described.title}</span>
          <code className="error-banner-code">{described.code}</code>
        </div>
        {described.message && described.message !== described.title ? (
          <p className="error-banner-message">{described.message}</p>
        ) : null}
      </div>
      {onRetry ? (
        <div className="error-banner-actions">
          <Button variant="secondary" size="s" icon="refresh" onClick={onRetry} loading={retrying}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
