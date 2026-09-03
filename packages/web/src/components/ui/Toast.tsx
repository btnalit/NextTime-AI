import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from './Button.js';
import { Icon, type IconName } from './Icon.js';

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

const TONE_ICON: Readonly<Record<ToastTone, IconName>> = {
  info: 'info',
  ok: 'check',
  warn: 'alert',
  danger: 'alert',
};

/** components/ui/Toast: transient notices (WS pushes, action results). 5s, stacked bottom-right. */
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
      <section className="toast-region" aria-label="Notifications">
        {toasts.map((toast) => {
          const tone = toast.tone ?? 'info';
          return (
            <output className={`toast toast-${tone}`} key={toast.id} data-testid="toast">
              <Icon name={TONE_ICON[tone]} />
              <div className="toast-body">
                <p className="toast-title">{toast.title}</p>
                {toast.description ? (
                  <p className="toast-description">{toast.description}</p>
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
