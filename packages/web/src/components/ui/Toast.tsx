import { FocusScope } from '@radix-ui/react-focus-scope';
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
import { useT } from '../../lib/i18n.js';
import { TOAST_REGION_CLASS, markToastPointerDown } from '../../lib/toast-region.js';
import { ErrorDetails } from '../kit/error-details.js';
import { Button } from './Button.js';
import { Icon, type IconName } from './Icon.js';
import { Kbd } from './Kbd.js';

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

/** Legacy 820: the key that takes the keyboard to the toasts from anywhere, a modal drawer or
 *  dialog included; pressed again, or Escape, it goes back to where it was. */
export const TOAST_HOTKEY = 'F8';

/** components/ui/Toast: transient notices (WS pushes, action results). 5s, stacked bottom-right;
 *  the countdown pauses while the toast is pointed at or focused. The region stays clickable over
 *  a modal drawer or dialog (`styles/ui.css` `.toast-region`, `lib/toast-region`) and reachable
 *  from the keyboard with `TOAST_HOTKEY`. */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const t = useT();
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

  // Legacy 820: a modal drawer or dialog keeps the focus inside it (Radix's focus scope), so the
  // keyboard reaches the toasts only by `TOAST_HOTKEY`. While there, the region is a focus scope
  // of its own: the newest scope pauses the modal's, and leaving gives the focus back to where it
  // was — unless the reader moved it on themselves.
  const region = useRef<HTMLElement | null>(null);
  const [entered, setEntered] = useState(false);
  const restoreOnLeave = useRef(true);
  const toastCount = useRef(0);
  toastCount.current = toasts.length;

  const leave = useCallback((restore: boolean) => {
    restoreOnLeave.current = restore;
    // The region is rebuilt without the scope; blurred first, the focused toast resumes its
    // countdown (`onBlur` below) rather than stay paused on a control that is gone.
    const active = document.activeElement;
    if (restore && active instanceof HTMLElement && region.current?.contains(active)) active.blur();
    setEntered(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (event.key === TOAST_HOTKEY && plain) {
        if (!entered && toastCount.current === 0) return;
        event.preventDefault();
        if (entered) leave(true);
        else {
          restoreOnLeave.current = true;
          setEntered(true);
        }
        return;
      }
      const target = event.target;
      if (
        event.key === 'Escape' &&
        entered &&
        target instanceof Node &&
        region.current?.contains(target)
      ) {
        // Ahead of Radix's own Escape (a capture listener on the document), which would close the
        // drawer or dialog under the toasts.
        event.preventDefault();
        event.stopPropagation();
        leave(true);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [entered, leave]);

  // #1407 UX P3: while the keyboard is in the toasts, none of them leaves on its own; on the way
  // out each one's time runs again, unless it is still pointed at or was held for its details.
  useEffect(() => {
    if (entered) for (const toast of toasts) pause(toast.id);
  }, [entered, toasts, pause]);
  const wasEntered = useRef(false);
  useEffect(() => {
    const left = wasEntered.current && !entered;
    wasEntered.current = entered;
    if (!left) return;
    for (const toast of toasts) {
      const element = region.current?.querySelector<HTMLElement>(`[data-toast-id="${toast.id}"]`);
      if (element) resume(toast.id, element);
    }
  }, [entered, toasts, resume]);

  // A dismissed toast takes the focus with it: the next one gets it, or, the last one gone, the
  // focus goes back to where it was.
  useEffect(() => {
    if (!entered) return;
    if (toasts.length === 0) {
      leave(true);
      return;
    }
    // Only a focus that fell to the page: on the way in, the focus scope moves it once it is
    // the newest scope; moved before that, the modal's own scope would take it back.
    const active = document.activeElement;
    if (active === null || active === document.body) {
      region.current?.querySelector<HTMLElement>('summary, button')?.focus();
    }
  }, [entered, toasts, leave]);

  const stack = (
    <section
      ref={region}
      className={TOAST_REGION_CLASS}
      aria-label="Notifications"
      aria-keyshortcuts={TOAST_HOTKEY}
      // Legacy 820: a modal hides everything outside it from assistive tech but `[aria-live]`
      // (Radix via `aria-hidden`); `off` is the default, so nothing more is announced.
      aria-live="off"
      // #1398 UX P2: known as inside the toasts even after a close removed its target.
      onPointerDownCapture={(event) => markToastPointerDown(event.nativeEvent)}
      onBlur={(event) => {
        if (!entered) return;
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        // The reader moved on (a click on a field): the focus stays where they put it.
        if (next !== null) {
          leave(false);
          return;
        }
        // Nowhere: a click on nothing focusable goes back to where it was; a dismissed toast's
        // control is gone instead, and the effect above moves to the next toast.
        const left = event.target;
        queueMicrotask(() => {
          if (left.isConnected) leave(true);
        });
      }}
    >
      {toasts.map((toast) => {
        const tone = toast.tone ?? 'info';
        return (
          <output
            className={`toast toast-${tone}`}
            key={toast.id}
            data-testid="toast"
            data-toast-id={toast.id}
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
              {toast.description ? <p className="toast-description">{toast.description}</p> : null}
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
              {toast.details || toast.action ? (
                // #1407 UX P3: the hotkey, seen — a keyboard-only reader has no other way to learn
                // it (assistive tech reads `aria-keyshortcuts` on the region instead).
                <p className="toast-hint" aria-hidden="true" data-testid="toast-hint">
                  {entered ? (
                    <>
                      <Kbd>Esc</Kbd> {t('返回', 'Back')}
                    </>
                  ) : (
                    <>
                      <Kbd>{TOAST_HOTKEY}</Kbd> {t('聚焦到提示', 'Focus notifications')}
                    </>
                  )}
                </p>
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
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {entered ? (
        <FocusScope
          asChild
          loop
          onUnmountAutoFocus={(event) => {
            if (!restoreOnLeave.current) event.preventDefault();
          }}
        >
          {stack}
        </FocusScope>
      ) : (
        stack
      )}
    </ToastContext.Provider>
  );
}

/** Returns the toast API; a no-op API outside a provider (tests rendering a page alone). */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  return api ?? NOOP_TOASTS;
}

const NOOP_TOASTS: ToastApi = { push: () => 0, dismiss: () => undefined };
