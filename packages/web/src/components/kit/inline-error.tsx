import { type ErrorOverrides, presentError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { ErrorDetails } from './error-details.js';

export interface InlineErrorProps {
  readonly error: unknown;
  readonly testId?: string;
  /** This place's own copy for particular codes; wins over the shared copy (P1-1). */
  readonly overrides?: ErrorOverrides;
  /** Defaults to the `field-error` look; a confirm dialog passes its own box classes. */
  readonly className?: string;
}

/**
 * components/kit/inline-error (console audit P1-1): an error next to the control or inside the
 * dialog that caused it — the same readable body as `ErrorBanner` (`lib/errors.ts`
 * `presentError`) with the kernel's text and code folded into 「技术细节」, without the banner's
 * frame. `data-error-code` names the exact kernel state for tests and screenshots.
 */
export function InlineError({ error, testId, overrides, className }: InlineErrorProps) {
  const t = useT();
  if (error === null || error === undefined) return null;
  const shown = presentError(error, t, overrides);
  return (
    <div
      role="alert"
      className={className ?? 'field-error'}
      data-testid={testId}
      data-error-code={shown.code}
    >
      <p>{shown.message}</p>
      <ErrorDetails code={shown.code} raw={shown.raw} testId={testId} />
    </div>
  );
}

/** The body of an error inside a `Notice` that already has its own lead-in ("读不到启用预览："):
 *  the readable message and the 「技术细节」 disclosure, no frame of its own. */
export function NoticeErrorBody({ error }: { readonly error: unknown }) {
  const t = useT();
  const shown = presentError(error, t);
  return (
    <>
      {shown.message}
      <ErrorDetails code={shown.code} raw={shown.raw} />
    </>
  );
}
