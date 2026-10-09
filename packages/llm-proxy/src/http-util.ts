import type http from 'node:http';

/**
 * http-util: the two request/response primitives proxy.ts and admin-api.ts share — a capped,
 * buffered body read and a JSON responder. Split out of proxy.ts (S6-B) so the admin routes do
 * not import the provider-forwarding module (and vice versa) just for these.
 */

export class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

export function readBufferedBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** The outcome of {@link readUpstreamJson}: the parsed body (`undefined` when it is empty, not
 *  JSON, or over the cap) and whether the cap cut it off. */
export interface UpstreamJsonBody {
  readonly body: unknown;
  readonly tooLarge: boolean;
}

/**
 * Reads an upstream `fetch` response body as JSON, at most `maxBytes` of it (STATUS leftover 138).
 * The provider test, the model probe and the model listing call an administrator-chosen upstream;
 * `res.json()` would buffer whatever that upstream sends, so one answer of a few hundred MB (or an
 * endless stream until the timeout) could exhaust this process — and `/model-probe` makes up to
 * eighteen such calls per request. A declared `content-length` over the cap is refused before
 * reading; otherwise the stream is cancelled as soon as the running total passes the cap.
 */
export async function readUpstreamJson(res: Response, maxBytes: number): Promise<UpstreamJsonBody> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { body: undefined, tooLarge: true };
  }
  if (!res.body) return { body: undefined, tooLarge: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { body: undefined, tooLarge: true };
    }
    chunks.push(value);
  }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), tooLarge: false };
  } catch {
    return { body: undefined, tooLarge: false };
  }
}
