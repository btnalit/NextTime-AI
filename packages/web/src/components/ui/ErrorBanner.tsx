import { describeError, localizedErrorTitle } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { platformErrorMessage } from '../../lib/platform-errors.js';
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
  retryLabel,
  retrying = false,
  title,
  testId,
}: ErrorBannerProps) {
  const t = useT();
  const described = describeError(error);
  // A kernel capability code `lib/platform-errors.ts` knows reads as its friendly sentence first;
  // the kernel's own (English) text stays as a muted second line and the raw code stays in the title row.
  const mapped = platformErrorMessage(error, t);
  const raw = described.message.trim();
  const primary = mapped ?? (raw.length > 0 && raw !== described.title ? described.message : null);
  const secondary = mapped !== null && raw.length > 0 && raw !== mapped ? described.message : null;
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
          <span>{title ?? localizedErrorTitle(described, t)}</span>
          <code className="error-banner-code">{described.code}</code>
        </div>
        {primary ? <p className="error-banner-message">{primary}</p> : null}
        {secondary ? (
          <p
            className="error-banner-message text-3"
            data-testid={testId ? `${testId}-detail` : undefined}
          >
            {secondary}
          </p>
        ) : null}
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
