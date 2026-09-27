import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn.js';
import { Button } from './button.js';

export type ToastTone = 'info' | 'ok' | 'warn' | 'danger';

export interface ToastInput {
  readonly tone?: ToastTone;
  readonly title: string;
  readonly description?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** Default 5000ms. `0` keeps it until dismissed. */
  readonly durationMs?: number;
  /** Replaces an existing toast with the same key instead of stacking a duplicate. */
  readonly key?: string;
}

interface ToastRecord extends ToastInput {
  readonly id: number;
}

export interface ToastApi {
  readonly push: (toast: ToastInput) => number;
  readonly dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Only the icon is tinted by tone (matches `components/ui/Toast`'s own `.toast-<tone> .icon`
 *  rule) — title stays `text`, description stays `text-3`; the tone is not shouted across the
 *  whole card. */
const TONE_ICON_CLASS: Readonly<Record<ToastTone, string>> = {
  info: 'text-info',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
};

/** The same three path shapes `components/ui/Icon` draws for `info`/`check`/`alert` — duplicated
 *  here (not imported) because a `components/kit/*` file may not import the legacy icon set
 *  (`scripts/guards/legacy-ui-importers.json` only shrinks). `ok` reuses the `check` glyph, `danger`
 *  reuses `alert`, same mapping `components/ui/Toast`'s own `TONE_ICON` table uses. */
const TONE_PATH: Readonly<Record<ToastTone, string>> = {
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 8v5m0-8.5v.5',
  ok: 'M5 12.5 9.5 17 19 7.5',
  warn: 'M12 3 2.5 20h19L12 3zm0 6v5m0 3v.5',
  danger: 'M12 3 2.5 20h19L12 3zm0 6v5m0 3v.5',
};

function ToneIcon({ tone }: { readonly tone: ToastTone }) {
  return (
    <svg
      className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_ICON_CLASS[tone])}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={TONE_PATH[tone]} />
    </svg>
  );
}

/**
 * components/kit/toast (console redesign P3-1): the kit replacement for `components/ui/Toast` —
 * same public API (`ToastProvider`, `useToast`, `ToastApi`, `ToastInput`, `ToastTone`) so a page can
 * switch its import later without touching call sites, Tailwind-styled instead of the legacy
 * `.toast`/`.toast-*` CSS. Hand-rolled, no Radix primitive backing it — `components/ui/Toast` makes
 * the same choice, and this project's Radix dependency set has no toast/live-region primitive.
 */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((prev) => {
        const kept = toast.key ? prev.filter((existing) => existing.key !== toast.key) : prev;
        for (const replaced of prev) {
          if (toast.key && replaced.key === toast.key) {
            const timer = timers.current.get(replaced.id);
            if (timer) clearTimeout(timer);
            timers.current.delete(replaced.id);
          }
        }
        return [...kept, { ...toast, id }].slice(-5);
      });
      const duration = toast.durationMs ?? 5000;
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-90 max-w-full flex-col gap-2"
        aria-label="Notifications"
      >
        {toasts.map((toast) => {
          const tone = toast.tone ?? 'info';
          return (
            <output
              key={toast.id}
              data-testid="toast"
              className="pointer-events-auto flex items-start gap-3 rounded-m border border-border-strong bg-surface-1 p-3 shadow-1"
            >
              <ToneIcon tone={tone} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="m-0 text-13 font-semibold text-text">{toast.title}</p>
                {toast.description ? (
                  <p className="m-0 text-13 text-text-3">{toast.description}</p>
                ) : null}
                {toast.action ? (
                  <div className="mt-1">
                    <Button
                      variant="ghost"
                      size="s"
                      onClick={() => {
                        toast.action?.onClick();
                        dismiss(toast.id);
                      }}
                    >
                      {toast.action.label}
                    </Button>
                  </div>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="s"
                aria-label="Dismiss"
                onClick={() => dismiss(toast.id)}
                className="shrink-0 px-1.5"
              >
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </Button>
            </output>
          );
        })}
      </section>
    </ToastContext.Provider>
  );
}

/** Returns the toast API; a no-op API outside a provider (tests rendering a page alone). */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  return api ?? NOOP_TOASTS;
}

const NOOP_TOASTS: ToastApi = { push: () => 0, dismiss: () => undefined };
