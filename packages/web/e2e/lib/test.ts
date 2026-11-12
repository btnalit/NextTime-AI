import { appendFileSync, mkdirSync } from 'node:fs';
import {
  type BrowserContext,
  type Page,
  type Request,
  type Response,
  test as base,
} from '@playwright/test';

/**
 * e2e/lib/test.ts — the `test` every spec imports (docs/test-coverage-gaps-2026-11-06.md §5.3,
 * gap G5, batch B2). It is Playwright's own `test` plus one automatic fixture: every capability
 * call the browser makes during a test — `POST /api/cap/<name>` and the chat socket's JSON-RPC
 * requests — is appended to that test's `cap-calls.jsonl` in its output directory
 * (`test-results/<test>/`), one `{"name", "via", "ok", "status"}` line per call.
 *
 * A call counts only when the real kernel answered it. An answer a test made up — `route.fulfill`
 * (it has no server address), or any frame on a socket opened after `routeWebSocket` (the test
 * stands between page and kernel; even a passed-through answer is not told apart) — is recorded
 * with `via: 'stub'`, and the matrix guard does not count it.
 *
 * `scripts/guards/capability-matrix.mjs --e2e-observed packages/web/test-results` (the end of the
 * `web-e2e` job) reads every such file and holds `docs/contracts/capability-matrix.yaml`'s `e2e:`
 * column to it (rule M4): a write capability marked `e2e: observed` must have been called, and
 * answered ok, by a page in this run. Only what a page sends counts — a helper that calls the API
 * from Node (`request`, `fetch`) is not a person using the console, which is the point.
 *
 * `scripts/guards/e2e-fixture.mjs` (rule E1) keeps every spec on this `test`: importing Playwright's
 * `test` directly anywhere else under `e2e/` would silently drop that spec's calls.
 */

// Everything else (`expect`, the types) is Playwright's own; `test` below shadows its `test`.
export * from '@playwright/test';

/** One line of `cap-calls.jsonl`. `via` says which transport carried it. */
export interface CapCall {
  readonly name: string;
  readonly via: 'http' | 'ws' | 'stub';
  readonly ok: boolean;
  readonly status: number | null;
}

const HTTP_PATH = /^\/api\/cap\/([a-z0-9_]+)$/;

/** The JSON-RPC frame a socket sent or received, or null for anything else (pings, binary). */
function rpcFrame(payload: string | Buffer): Record<string, unknown> | null {
  if (typeof payload !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `routeWebSocket` on `target`, wrapped so that `onRoute()` runs first. */
function watchSocketRoutes(target: BrowserContext | Page, onRoute: () => void): void {
  const original = target.routeWebSocket.bind(target) as (...args: unknown[]) => Promise<void>;
  (target as { routeWebSocket: unknown }).routeWebSocket = (...args: unknown[]) => {
    onRoute();
    return original(...args);
  };
}

/** The capability a request calls (`POST /api/cap/<name>`), or undefined for any other request. */
function capName(request: Request): string | undefined {
  if (request.method() !== 'POST') return undefined;
  return HTTP_PATH.exec(new URL(request.url()).pathname)?.[1];
}

/**
 * How long `stop` waits for the answers to capability requests the page has sent (legacy 692). The
 * page can act on an answer — the test sees the DOM change and ends — before Playwright reports
 * that answer's `response` event; stopping at once would drop the call, often a test's last write.
 */
const IN_FLIGHT_GRACE_MS = 5_000;

/**
 * Starts recording `context`'s capability calls into `calls`; the returned function stops it and
 * resolves once every capability request sent so far has been answered (or failed, or the grace
 * period ran out) and every answer classified.
 */
export function recordCapCalls(context: BrowserContext, calls: CapCall[]): () => Promise<void> {
  const settling: Promise<void>[] = [];
  let contextRoutesSockets = false;
  const pagesRoutingSockets = new WeakSet<Page>();
  // Capability requests sent and not yet answered or failed; `stop` waits for this to empty.
  const inFlight = new Set<Request>();
  let drained: (() => void) | undefined;
  const settle = (request: Request) => {
    if (inFlight.delete(request) && inFlight.size === 0) drained?.();
  };
  const onRequest = (request: Request) => {
    if (capName(request) !== undefined) inFlight.add(request);
  };
  const onRequestFailed = (request: Request) => settle(request);
  const onResponse = (response: Response) => {
    const request = response.request();
    settle(request);
    const name = capName(request);
    if (name === undefined) return;
    settling.push(
      response
        .serverAddr()
        .catch(() => null)
        .then((address) => {
          // `route.fulfill` (and `route.fetch` + `fulfill`) answers have no server address.
          const via = address === null ? 'stub' : 'http';
          calls.push({ name, via, ok: response.ok(), status: response.status() });
        }),
    );
  };
  const onPage = (page: Page) => {
    watchSocketRoutes(page, () => pagesRoutingSockets.add(page));
    page.on('websocket', (socket) => {
      const via = contextRoutesSockets || pagesRoutingSockets.has(page) ? 'stub' : 'ws';
      // JSON-RPC ids are per socket: what each request asked for, until its answer comes back.
      const pending = new Map<unknown, string>();
      socket.on('framesent', ({ payload }) => {
        const frame = rpcFrame(payload);
        if (frame && 'id' in frame && typeof frame.method === 'string') {
          pending.set(frame.id, frame.method);
        }
      });
      socket.on('framereceived', ({ payload }) => {
        const frame = rpcFrame(payload);
        if (!frame || !('id' in frame) || !pending.has(frame.id)) return;
        const name = pending.get(frame.id) as string;
        pending.delete(frame.id);
        // `authenticate` opens the socket; it is not a capability.
        if (name === 'authenticate') return;
        calls.push({ name, via, ok: !('error' in frame), status: null });
      });
    });
  };
  watchSocketRoutes(context, () => {
    contextRoutesSockets = true;
  });
  context.on('request', onRequest);
  context.on('requestfailed', onRequestFailed);
  context.on('response', onResponse);
  context.on('page', onPage);
  for (const page of context.pages()) onPage(page);
  return async () => {
    if (inFlight.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => {
          drained = resolve;
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, IN_FLIGHT_GRACE_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    context.off('request', onRequest);
    context.off('requestfailed', onRequestFailed);
    context.off('response', onResponse);
    context.off('page', onPage);
    await Promise.all(settling);
  };
}

export const test = base.extend<{ capCalls: undefined }>({
  capCalls: [
    async ({ context }, use, testInfo) => {
      const calls: CapCall[] = [];
      const stop = recordCapCalls(context, calls);
      await use(undefined);
      await stop();
      if (calls.length > 0) {
        mkdirSync(testInfo.outputDir, { recursive: true });
        appendFileSync(
          testInfo.outputPath('cap-calls.jsonl'),
          calls
            .map((call) => JSON.stringify(call))
            .join('\n')
            .concat('\n'),
        );
      }
    },
    { auto: true },
  ],
});
