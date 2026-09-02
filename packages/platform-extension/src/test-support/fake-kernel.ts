import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

/**
 * In-process fake kernel (S1.6 test support): a real `node:http` server implementing the HTTP
 * capability-route convention (`packages/shared/src/http.ts`) just enough to drive
 * `KernelClient` and the `entry` mode extension in tests, without a real kernel.
 */

export interface FakeKernelRequest {
  capability: string;
  params: unknown;
  authorization: string | undefined;
}

export type FakeKernelOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }
  /** Raw-response escape hatch, for malformed-response/non-2xx test cases. */
  | { raw: true; status: number; body?: unknown };

export type FakeKernelHandler = (
  request: FakeKernelRequest,
) => FakeKernelOutcome | Promise<FakeKernelOutcome>;

export interface FakeKernel {
  url: string;
  requests: FakeKernelRequest[];
  /** Registers (or replaces) the handler for one capability name. */
  setHandler(capability: string, handler: FakeKernelHandler): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

export async function startFakeKernel(): Promise<FakeKernel> {
  const handlers = new Map<string, FakeKernelHandler>();
  const requests: FakeKernelRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const rawBody = await readBody(req);
      let params: unknown = {};
      try {
        params = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        // Leave params as {} — a malformed request body is a caller bug, not something the fake
        // kernel needs to model precisely.
      }

      const capability = (req.url ?? '').replace(/^\/api\/cap\//, '');
      const record: FakeKernelRequest = {
        capability,
        params,
        authorization: req.headers.authorization,
      };
      requests.push(record);

      const handler = handlers.get(capability);
      if (!handler) {
        sendJson(res, 404, {
          ok: false,
          error: { code: 'not_found', message: `no fake handler for "${capability}"` },
        });
        return;
      }

      const outcome = await handler(record);
      if ('raw' in outcome) {
        sendJson(res, outcome.status, outcome.body);
        return;
      }
      sendJson(res, 200, outcome);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake kernel: failed to bind a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setHandler(capability, handler) {
      handlers.set(capability, handler);
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
