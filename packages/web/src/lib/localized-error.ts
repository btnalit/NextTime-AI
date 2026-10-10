/**
 * lib/localized-error (console audit P1-1): an error whose message the console itself wrote for
 * the person reading it — a validation hint ("请填写理由。"), a refusal from the gate host already
 * phrased in the viewer's language. `lib/errors.ts` `presentError` shows that message as the
 * body, never folded into 「技术细节」; `detail` (e.g. the browser's own `fetch` failure text) is
 * what goes there instead. Errors from the kernel or the model proxy keep their own classes
 * (`HttpError`, `LlmAdminError`): their text is the server's, so it belongs in the fold.
 */
export class LocalizedError extends Error {
  /** A stable name for 「技术细节」 and tests; not a kernel code. */
  readonly code: string;
  readonly detail: string | null;

  constructor(message: string, options: { readonly code?: string; readonly detail?: string } = {}) {
    super(message);
    this.name = 'LocalizedError';
    this.code = options.code ?? 'invalid_input';
    this.detail = options.detail ?? null;
  }
}
