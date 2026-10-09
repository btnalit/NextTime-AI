import { describeError, localizedErrorTitle, transportErrorMessage } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { platformErrorMessage } from '../../lib/platform-errors.js';
import { Button } from './button.js';

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
 * components/kit/error-banner (S8 W3 F1, docs/development-tasks.md §5e F3 / S8 risk ①): the kit
 * replacement for `components/ui/ErrorBanner` — always shows the kernel's stable code
 * (`lib/errors.ts` `describeError`) next to the message so a screenshot is diagnosable, and a
 * `kit/button` Retry when the caller can re-run the load. Over the same `error-banner` /
 * `error-banner-body` / `error-banner-title` / `error-banner-code` / `error-banner-message` /
 * `error-banner-actions` CSS classes so a page swapping from the legacy component or a local
 * replica renders pixel-identical. No icon here — `kit/*` does not import `components/ui/Icon`
 * (S8 risk ①); the local replicas this lane replaces (`GrantGateForm`, `ExecutionReadinessCard`)
 * never rendered one either.
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
  // A transport failure ("Failed to fetch", a proxy's HTML error page) gets the same treatment.
  const mapped = platformErrorMessage(error, t) ?? transportErrorMessage(error, t);
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
          <Button variant="secondary" size="s" onClick={onRetry} disabled={retrying}>
            {retryLabel ?? t('重试', 'Retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
