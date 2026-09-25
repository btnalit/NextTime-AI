import { describeError } from '../../lib/errors.js';
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
          <Button variant="secondary" size="s" onClick={onRetry} disabled={retrying}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
