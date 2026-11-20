// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { type ComponentType, lazy } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteBoundary } from './RouteBoundary.js';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

/** A lazy component whose dynamic import resolves — like a real `import('./components/XPage.js')`
 *  once the chunk has fetched, but deterministic and independent of the actual page files. */
function lazyOk(Rendered: ComponentType) {
  return lazy(() => Promise.resolve({ default: Rendered }));
}

/** A lazy component whose dynamic import rejects — the shape a real chunk-load failure takes
 *  (e.g. a deploy replaced the hashed file this tab's `index.html` still references). */
function lazyFail(message: string) {
  return lazy<ComponentType>(() => Promise.reject(new Error(message)));
}

function Page() {
  return <div data-testid="page-content">page loaded</div>;
}

describe('RouteBoundary', () => {
  it('renders the lazy page once its import resolves', async () => {
    const Lazy = lazyOk(Page);
    render(
      <RouteBoundary>
        <Lazy />
      </RouteBoundary>,
    );
    // Nothing else to assert about the fallback instant — it is `null` (RouteBoundary's own doc
    // comment: the shell chrome around it, not this component, stays rendered).
    await waitFor(() => expect(screen.getByTestId('page-content')).toBeTruthy());
  });

  it('shows the reload action when the chunk import rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Lazy = lazyFail('network error loading chunk');
    render(
      <RouteBoundary>
        <Lazy />
      </RouteBoundary>,
    );
    await waitFor(() => expect(screen.getByTestId('route-load-error')).toBeTruthy());
    const reload = screen.getByRole('button', { name: /刷新/ });
    expect(reload).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('reload button calls window.location.reload', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // jsdom's `window.location.reload` throws "Not implemented" — replace the whole object so the
    // click handler's `window.location.reload()` call is observable instead of failing the test.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });

    const Lazy = lazyFail('network error loading chunk');
    render(
      <RouteBoundary>
        <Lazy />
      </RouteBoundary>,
    );
    await waitFor(() => expect(screen.getByTestId('route-load-error')).toBeTruthy());
    screen.getByRole('button', { name: /刷新/ }).click();
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    errorSpy.mockRestore();
  });

  describe('a chunk that failed to load (legacy 880)', () => {
    const CHUNK_ERROR =
      'Failed to fetch dynamically imported module: https://x/assets/ChatPage-a.js';

    function withReloadSpy(): { reload: ReturnType<typeof vi.fn>; restore: () => void } {
      const reload = vi.fn();
      const originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, pathname: '/', reload },
      });
      return {
        reload,
        restore: () =>
          Object.defineProperty(window, 'location', {
            configurable: true,
            value: originalLocation,
          }),
      };
    }

    it('reloads the page by itself once the server answers, saying so meanwhile', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchSpy = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));
      vi.stubGlobal('fetch', fetchSpy);
      const { reload, restore } = withReloadSpy();
      try {
        const Lazy = lazyFail(CHUNK_ERROR);
        render(
          <RouteBoundary>
            <Lazy />
          </RouteBoundary>,
        );
        await waitFor(() =>
          expect(screen.getByTestId('route-load-error').getAttribute('data-state')).toBe(
            'reloading',
          ),
        );
        expect(screen.getByRole('status').textContent).toContain('正在重新加载页面');
        await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        restore();
        errorSpy.mockRestore();
      }
    });

    it('shows the reload action instead when it already reloaded for this a moment ago', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response('', { status: 200 }))),
      );
      sessionStorage.setItem('nexttime.chunkReloadAt', String(Date.now()));
      const { reload, restore } = withReloadSpy();
      try {
        const Lazy = lazyFail(CHUNK_ERROR);
        render(
          <RouteBoundary>
            <Lazy />
          </RouteBoundary>,
        );
        await waitFor(() =>
          expect(screen.getByTestId('route-load-error').getAttribute('data-state')).toBe('error'),
        );
        expect(screen.getByText(/网络刚切换过/)).toBeTruthy();
        expect(reload).not.toHaveBeenCalled();
      } finally {
        restore();
        errorSpy.mockRestore();
      }
    });

    it('does not reload by itself while text typed elsewhere on the page is unsent', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchSpy = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));
      vi.stubGlobal('fetch', fetchSpy);
      const { reload, restore } = withReloadSpy();
      try {
        const Lazy = lazyFail(CHUNK_ERROR);
        render(
          <div>
            <textarea aria-label="draft" defaultValue="half a sentence" />
            <RouteBoundary>
              <Lazy />
            </RouteBoundary>
          </div>,
        );
        await waitFor(() =>
          expect(screen.getByTestId('route-load-error').getAttribute('data-state')).toBe('error'),
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe(
          'half a sentence',
        );
      } finally {
        restore();
        errorSpy.mockRestore();
      }
    });

    it('shows the reload action instead when the server does not answer', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response('', { status: 502 }))),
      );
      const { reload, restore } = withReloadSpy();
      try {
        const Lazy = lazyFail(CHUNK_ERROR);
        render(
          <RouteBoundary>
            <Lazy />
          </RouteBoundary>,
        );
        await waitFor(() =>
          expect(screen.getByTestId('route-load-error').getAttribute('data-state')).toBe('error'),
        );
        expect(reload).not.toHaveBeenCalled();
      } finally {
        restore();
        errorSpy.mockRestore();
      }
    });

    it('never reloads by itself for a page that throws while rendering', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const { reload, restore } = withReloadSpy();
      try {
        const Lazy = lazyFail('Cannot read properties of undefined');
        render(
          <RouteBoundary>
            <Lazy />
          </RouteBoundary>,
        );
        await waitFor(() =>
          expect(screen.getByTestId('route-load-error').getAttribute('data-state')).toBe('error'),
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
      } finally {
        restore();
        errorSpy.mockRestore();
      }
    });
  });
});
