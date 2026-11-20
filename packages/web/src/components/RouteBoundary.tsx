import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { isChunkLoadError, reloadForChunkError } from '../lib/chunk-reload.js';
import { useT } from '../lib/i18n.js';

export interface RouteBoundaryProps {
  readonly children: ReactNode;
}

interface RouteErrorFallbackProps {
  readonly onReload: () => void;
}

/** The `error` state for a failed route chunk — same `.empty-state`/`.btn` classes `ui/EmptyState`
 *  and `ui/Button` render (styles/ui.css), but written directly against those classes rather than
 *  importing the components: `scripts/guards/css-tokens.mjs`'s legacy-`components/ui/*`-importers
 *  allowlist only shrinks, never grows (docs/development-tasks.md §5e, W1-A0 row) — new code is
 *  meant to reach for `components/kit/*` instead, and `kit/button` has no consumers yet by design
 *  (its own doc comment — a later, dedicated migration lane wires it in, not this one). This stays
 *  a plain two-element fallback rather than the first premature `kit/button` call. */
function RouteErrorFallback({ onReload }: RouteErrorFallbackProps) {
  const t = useT();
  return (
    <div className="page">
      <div className="empty-state" data-testid="route-load-error" data-state="error">
        <svg
          className="icon icon-l"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M12 3 2.5 20h19L12 3zm0 6v5m0 3v.5" />
        </svg>
        <p className="empty-state-title">{t('页面加载失败', 'Page failed to load')}</p>
        <p className="empty-state-body">
          {t(
            '本页的脚本没有取到，可能是网络刚切换过，或者新版本替换了资源文件。刷新页面即可恢复。',
            'This page’s script did not load — the network may have just changed, or a new release replaced the files. Reloading the page fixes it.',
          )}
        </p>
        <div className="empty-state-action">
          <button type="button" className="btn btn-primary" onClick={onReload}>
            {t('刷新页面', 'Reload')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Legacy 880: the page's chunk failed to load and the boundary is reloading the page by itself
 *  (`lib/chunk-reload`) — a quiet line in the page area while the server is checked. */
function RouteReloading() {
  const t = useT();
  return (
    <div className="page">
      <div className="empty-state" data-testid="route-load-error" data-state="reloading">
        <output className="empty-state-body block">
          {t(
            '本页的脚本没有取到，正在重新加载页面…',
            'This page’s script did not load. Reloading the page…',
          )}
        </output>
      </div>
    </div>
  );
}

interface RouteErrorBoundaryState {
  readonly error: Error | null;
  /** `reloading` while a failed chunk's automatic reload is being tried (legacy 880); `failed`
   *  for any other render error, and once that reload is not tried. */
  readonly phase: 'reloading' | 'failed';
}

/** Catches a failed `React.lazy` dynamic import (e.g. a deploy replaced the hashed chunk file
 *  this tab's `index.html` still references, or the network changed mid-fetch — the browser's
 *  `import()` then rejects, and React re-throws that rejection into render, past `Suspense`, to
 *  the nearest error boundary). The browser keeps that failure for the page's lifetime, so for a
 *  chunk-load error it reloads the page once by itself (`lib/chunk-reload`, legacy 880) and falls
 *  back to the 「刷新页面」 screen only when that is not safe to try. A hook cannot catch a render
 *  error, so this stays a class component (the one place in this package that needs to be). */
class RouteErrorBoundary extends Component<RouteBoundaryProps, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState = { error: null, phase: 'failed' };
  private unmounted = false;

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      phase: isChunkLoadError(error) ? 'reloading' : 'failed',
    };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The one diagnostic trail a chunk-load failure leaves — no error-reporting sink wired yet.
    console.error('[RouteBoundary] route chunk failed to load', error, info.componentStack);
    if (!isChunkLoadError(error)) return;
    void reloadForChunkError().then((reloading) => {
      if (!reloading && !this.unmounted) this.setState({ phase: 'failed' });
    });
  }

  override componentWillUnmount(): void {
    this.unmounted = true;
  }

  private readonly reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.error) {
      return this.state.phase === 'reloading' ? (
        <RouteReloading />
      ) : (
        <RouteErrorFallback onReload={this.reload} />
      );
    }
    return this.props.children;
  }
}

/**
 * components/RouteBoundary (S8 W1-A5, leftover 49): wraps one routed page — a `React.lazy`
 * component — in `Suspense` (for the chunk still loading) and an error boundary (for a chunk
 * that failed to load). `Suspense`'s fallback is `null`, not a skeleton: `AppShell` renders the
 * sidebar/top bar around `{page}` unconditionally (`AppShell.tsx`'s own doc comment — "Pages
 * render inside `main` and own their `.page`"), so the shell chrome never moves; the only visible
 * effect of the fallback is the page's own content area staying blank for the one chunk fetch,
 * which is quieter than a skeleton that would itself flash and be replaced a moment later.
 *
 * `routes.tsx`'s `Routed` renders this once, keyed by `route.kind` (`<RouteBoundary
 * key={route.kind}>`), around the page the route switch picked — not once per page component.
 * The `key` matters: an error boundary's caught-error state is ordinary component state, so
 * without a `key` change it would keep showing the reload screen after the reader navigates to a
 * *different*, perfectly-loadable route. Keying by `route.kind` remounts the boundary (clearing
 * the error) exactly when the page actually changes, while leaving a same-kind navigation (e.g. a
 * different `chatId`) alone — `ChatPage` already keys itself on `chatId` for its own reasons.
 */
export function RouteBoundary({ children }: RouteBoundaryProps) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={null}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}
