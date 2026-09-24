// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { type ComponentType, lazy } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteBoundary } from './RouteBoundary.js';

afterEach(cleanup);

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
});
