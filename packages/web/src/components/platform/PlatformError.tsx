import { describeError } from '../../lib/errors.js';
import { platformErrorMessage } from '../../lib/platform-errors.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';

export interface PlatformErrorProps {
  readonly error: unknown;
  /** Lead-in for the `ErrorBanner` fallback ("Could not create this user"). */
  readonly title: string;
  readonly testId?: string;
}

/**
 * components/platform/PlatformError: one platform-capability failure, rendered the way
 * `BindApiKeyForm` already renders its own — a mapped wire code (`lib/platform-errors.ts`) as a
 * bilingual inline `field-error`, anything else as the full `ErrorBanner` with the kernel's
 * message and raw code. `data-error-code` is on both branches so a test (and a screenshot) can
 * name the exact kernel state either way.
 */
export function PlatformError({ error, title, testId }: PlatformErrorProps) {
  if (error === null || error === undefined) return null;
  const mapped = platformErrorMessage(error);
  if (mapped === null) return <ErrorBanner error={error} title={title} testId={testId} />;
  return (
    <p
      className="field-error"
      role="alert"
      data-testid={testId}
      data-error-code={describeError(error).code}
    >
      {mapped}
    </p>
  );
}
