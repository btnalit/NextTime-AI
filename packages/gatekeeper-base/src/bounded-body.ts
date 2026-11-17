/**
 * gatekeeper-base/bounded-body (legacy 797): reads a `fetch` response body up to a byte limit.
 * `response.json()` / `.text()` buffer whatever the other side sends until the timeout, so an
 * owner-supplied URL answering with a document of a few hundred MB could fill the process's
 * memory before anything parses it. A declared `content-length` over the limit is refused before
 * reading; otherwise the stream is cancelled as soon as the running total passes the limit. The
 * same shape as the kernel's `readBodyBounded` (gatekeeper client, R-49) and llm-proxy's
 * `readUpstreamJson` (STATUS leftover 138).
 */

const MIB = 1024 * 1024;

/** `maxBytes` as the refusal says it — whole MiB when it is one, else bytes. */
function shownLimit(maxBytes: number): string {
  return maxBytes % MIB === 0 ? `${maxBytes / MIB} MiB` : `${maxBytes} bytes`;
}

export class ResponseBodyTooLargeError extends Error {
  readonly maxBytes: number;

  /** `what`: the body as the message names it ("the OpenAPI document"); `fix`: what to do. */
  constructor(what: string, maxBytes: number, fix?: string) {
    super(`${what} is larger than ${shownLimit(maxBytes)}${fix === undefined ? '' : `: ${fix}`}`);
    this.name = 'ResponseBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/** `response`'s body as UTF-8 text, at most `maxBytes` of it — `ResponseBodyTooLargeError`
 *  (naming the body `what`, with `options.fix`) past that, with the body cancelled. No body reads
 *  as `''`. */
export async function readBodyWithin(
  response: Response,
  maxBytes: number,
  what: string,
  options: { readonly fix?: string } = {},
): Promise<string> {
  const tooLarge = (): ResponseBodyTooLargeError =>
    new ResponseBodyTooLargeError(what, maxBytes, options.fix);
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks).toString('utf8');
}
