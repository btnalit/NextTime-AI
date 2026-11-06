import { appendFileSync, mkdirSync } from 'node:fs';
import { type BrowserContext, type Page, type Response, test as base } from '@playwright/test';

/**
 * e2e/lib/test.ts — the `test` every spec imports (docs/test-coverage-gaps-2026-11-06.md §5.3,
 * gap G5, batch B2). It is Playwright's own `test` plus one automatic fixture: every capability
 * call the browser makes during a test — `POST /api/cap/<name>` and the chat socket's JSON-RPC
 * requests — is appended to that test's `cap-calls.jsonl` in its output directory
 * (`test-results/<test>/`), one `{"name", "via", "ok", "status"}` line per call.
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
  readonly via: 'http' | 'ws';
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

/** Starts recording `context`'s capability calls into `calls`; returns how to stop. */
export function recordCapCalls(context: BrowserContext, calls: CapCall[]): () => void {
  const onResponse = (response: Response) => {
    const request = response.request();
    if (request.method() !== 'POST') return;
    const match = HTTP_PATH.exec(new URL(response.url()).pathname);
    if (match?.[1] === undefined) return;
    calls.push({ name: match[1], via: 'http', ok: response.ok(), status: response.status() });
  };
  const onPage = (page: Page) => {
    page.on('websocket', (socket) => {
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
        calls.push({ name, via: 'ws', ok: !('error' in frame), status: null });
      });
    });
  };
  context.on('response', onResponse);
  context.on('page', onPage);
  for (const page of context.pages()) onPage(page);
  return () => {
    context.off('response', onResponse);
    context.off('page', onPage);
  };
}

export const test = base.extend<{ capCalls: undefined }>({
  capCalls: [
    async ({ context }, use, testInfo) => {
      const calls: CapCall[] = [];
      const stop = recordCapCalls(context, calls);
      await use(undefined);
      stop();
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
