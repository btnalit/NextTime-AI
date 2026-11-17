import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ErrorToastDetails } from '../../lib/errors.js';
import { ErrorDetails } from '../kit/error-details.js';
import { Button } from './Button.js';
import { Icon, type IconName } from './Icon.js';

export type ToastTone = 'info' | 'ok' | 'warn' | 'danger';

export interface ToastInput {
  readonly tone?: ToastTone;
  readonly title: string;
  readonly description?: string;
  /** Legacy 212: a failure's 「技术细节」 (`lib/errors.ts` `errorToast`), folded under the
   *  description. Opening it keeps the toast until it is dismissed. */
  readonly details?: ErrorToastDetails;
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

interface Countdown {
  /** Unset while paused. */
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  readonly startedAt: number;
  readonly remaining: number;
}

/** A toast resumed with only a moment left still stays long enough to be seen leaving. */
const MIN_RESUMED_MS = 1500;

const TONE_ICON: Readonly<Record<ToastTone, IconName>> = {
  info: 'info',
  ok: 'check',
  warn: 'alert',
  danger: 'alert',
};

/** components/ui/Toast: transient notices (WS pushes, action results). 5s, stacked bottom-right;
 *  the countdown pauses while the toast is pointed at or focused. The region stays clickable over
 *  a modal drawer or dialog (`styles/ui.css` `.toast-region`, `kit/discard-guard`). */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  const nextId = useRef(1);
  // A toast's dismiss countdown: the timer while it runs, what is left of it while paused.
  const timers = useRef(new Map<number, Countdown>());

  // A toast's dismiss timer must not outlive the provider: firing after unmount sets state on a
  // gone tree (and, in tests, after the DOM environment is torn down).
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const countdown of pending.values()) clearTimeout(countdown.timer);
      pending.clear();
    };
  }, []);

  // Legacy 212: the reader opened the 「技术细节」 — the toast stays until they dismiss it.
  const hold = useCallback((id: number) => {
    clearTimeout(timers.current.get(id)?.timer);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      hold(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    },
    [hold],
  );

  const start = useCallback(
    (id: number, remaining: number) => {
      timers.current.set(id, {
        timer: setTimeout(() => dismiss(id), remaining),
        startedAt: Date.now(),
        remaining,
      });
    },
    [dismiss],
  );

  // #1398 UX P3: pointed at or focused, a toast does not leave while it is being read; the rest
  // of its time runs again once the pointer and the focus have both left it.
  const pause = useCallback((id: number) => {
    const countdown = timers.current.get(id);
    if (!countdown || countdown.timer === undefined) return;
    clearTimeout(countdown.timer);
    timers.current.set(id, {
      timer: undefined,
      startedAt: countdown.startedAt,
      remaining: Math.max(0, countdown.remaining - (Date.now() - countdown.startedAt)),
    });
  }, []);

  const resume = useCallback(
    (id: number, element: HTMLElement) => {
      const countdown = timers.current.get(id);
      if (!countdown || countdown.timer !== undefined) return;
      if (element.matches(':hover') || element.contains(document.activeElement)) return;
      start(id, Math.max(countdown.remaining, MIN_RESUMED_MS));
    },
    [start],
  );

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((prev) => {
        const kept = toast.key ? prev.filter((existing) => existing.key !== toast.key) : prev;
        for (const replaced of prev) {
          if (toast.key && replaced.key === toast.key) hold(replaced.id);
        }
        return [...kept, { ...toast, id }].slice(-5);
      });
      const duration = toast.durationMs ?? 5000;
      if (duration > 0) start(id, duration);
      return id;
    },
    [hold, start],
  );

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className="toast-region" aria-label="Notifications">
        {toasts.map((toast) => {
          const tone = toast.tone ?? 'info';
          return (
            <output
              className={`toast toast-${tone}`}
              key={toast.id}
              data-testid="toast"
              onPointerEnter={() => pause(toast.id)}
              onPointerLeave={(event) => resume(toast.id, event.currentTarget)}
              onFocus={() => pause(toast.id)}
              onBlur={(event) => {
                const element = event.currentTarget;
                // Focus moving to another control of the same toast keeps it paused.
                if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget))
                  return;
                // `activeElement` still names the control losing focus during `blur`.
                queueMicrotask(() => resume(toast.id, element));
              }}
            >
              <Icon name={TONE_ICON[tone]} />
              <div className="toast-body">
                <p className="toast-title">{toast.title}</p>
                {toast.description ? (
                  <p className="toast-description">{toast.description}</p>
                ) : null}
                {toast.details ? (
                  <ErrorDetails
                    code={toast.details.code}
                    raw={toast.details.raw}
                    testId="toast"
                    onOpen={() => hold(toast.id)}
                  />
                ) : null}
                {toast.action ? (
                  <div className="toast-actions">
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
                icon="close"
                iconOnly
                aria-label="Dismiss"
                onClick={() => dismiss(toast.id)}
              />
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
