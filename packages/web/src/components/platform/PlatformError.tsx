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
 *
 * C10 (console-completion-plan §2b): a mapped code also keeps the kernel's own `message` as a
 * secondary line (`data-testid="<testId>-detail"`), because one wire code can cover more than one
 * kernel condition — `last_admin` was reused for "you cannot disable yourself" until the kernel
 * split it into `self_disable` — and the fixed copy alone hid which one it was. Dropped when the
 * kernel text is empty or merely repeats the mapped copy.
 */
export function PlatformError({ error, title, testId }: PlatformErrorProps) {
  if (error === null || error === undefined) return null;
  const mapped = platformErrorMessage(error);
  if (mapped === null) return <ErrorBanner error={error} title={title} testId={testId} />;
  const described = describeError(error);
  const detail =
    described.message.trim().length > 0 && described.message !== mapped ? described.message : null;
  return (
    <div className="field-error" role="alert" data-testid={testId} data-error-code={described.code}>
      <p>{mapped}</p>
      {detail ? (
        <p className="text-3" data-testid={testId ? `${testId}-detail` : undefined}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}
