// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPLORER_PATH,
  EXPLORER_PLACEHOLDER_MARKER,
  probeExplorerAvailable,
  resetExplorerProbeCache,
  useExplorerAvailable,
} from './explorer-probe.js';

/**
 * explorer-probe.test.tsx: `probeExplorerAvailable` / `useExplorerAvailable` (lib/explorer-probe.ts)
 * against a stubbed `fetch` — the placeholder body, a real bundle body, and the fail-open cases.
 * The placeholder body below is the marker as `deploy/caddy/explorer-placeholder/index.html`
 * carries it in its `<title>` and `<h1>`.
 */

function htmlResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

const PLACEHOLDER = `<!doctype html><html><head><title>${EXPLORER_PLACEHOLDER_MARKER}</title></head><body><main><h1>${EXPLORER_PLACEHOLDER_MARKER}</h1></main></body></html>`;
const BUNDLE =
  '<!doctype html><html><head><title>Semantica Explorer</title><script type="module" src="/explorer/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>';

beforeEach(resetExplorerProbeCache);
afterEach(cleanup);

describe('probeExplorerAvailable', () => {
  it('GETs /explorer/ same-origin and reports false on the placeholder page', async () => {
    const fetchStub = vi.fn(async () => htmlResponse(200, PLACEHOLDER));
    expect(await probeExplorerAvailable(fetchStub as unknown as typeof fetch)).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(EXPLORER_PATH);
    expect(init.credentials).toBe('same-origin');
    expect(init.method).toBe('GET');
  });

  it('reports true on a real bundle body', async () => {
    const fetchStub = vi.fn(async () => htmlResponse(200, BUNDLE));
    expect(await probeExplorerAvailable(fetchStub as unknown as typeof fetch)).toBe(true);
  });

  it('fails open: a non-2xx or a thrown fetch both resolve true', async () => {
    const notFound = vi.fn(async () => htmlResponse(404, 'nope'));
    expect(await probeExplorerAvailable(notFound as unknown as typeof fetch)).toBe(true);
    const thrown = vi.fn(async () => {
      throw new TypeError('network down');
    });
    expect(await probeExplorerAvailable(thrown as unknown as typeof fetch)).toBe(true);
  });
});

function Probe({ fetchImpl }: { readonly fetchImpl: typeof fetch }) {
  const available = useExplorerAvailable(fetchImpl);
  return <span data-testid="probe">{available === null ? 'pending' : String(available)}</span>;
}

describe('useExplorerAvailable', () => {
  it('is null while in flight, then the probe result; a second mount reuses the cached probe', async () => {
    const fetchStub = vi.fn(async () => htmlResponse(200, PLACEHOLDER));
    const fetchImpl = fetchStub as unknown as typeof fetch;
    const first = render(<Probe fetchImpl={fetchImpl} />);
    expect(screen.getByTestId('probe').textContent).toBe('pending');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('false'));
    first.unmount();

    render(<Probe fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('false'));
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
