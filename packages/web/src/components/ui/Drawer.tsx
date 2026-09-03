import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from './Button.js';

export interface DrawerProps {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly wide?: boolean;
  readonly children: ReactNode;
  readonly testId?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * components/ui/Drawer: right-side detail panel. `role="dialog"` + `aria-modal`, Esc closes,
 * Tab is trapped inside, focus moves in on open and back to the opener on close, body scroll is
 * locked while open. Rendered inline (no portal) — `position: fixed` places it regardless.
 */
export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  footer,
  wide = false,
  children,
  testId,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (!firstEl || !lastEl) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === firstEl || active === panel)) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && active === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc on the dialog is the keyboard path; the overlay is a pointer-only affordance. */}
      <div className="drawer-overlay" onClick={onClose} aria-hidden data-testid="drawer-overlay" />
      <div
        ref={panelRef}
        className={`drawer${wide ? ' drawer-wide' : ''}`}
        // biome-ignore lint/a11y/useSemanticElements: a native <dialog> needs showModal() (top layer, above the toast region) or loses the focus trap; the dialog pattern is implemented explicitly above.
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
      >
        <header className="drawer-header">
          <div className="drawer-header-text">
            <h2 className="drawer-title" id={titleId}>
              {title}
            </h2>
            {subtitle !== undefined ? <div className="drawer-subtitle">{subtitle}</div> : null}
          </div>
          <Button
            variant="ghost"
            size="s"
            icon="close"
            iconOnly
            aria-label="Close"
            onClick={onClose}
          />
        </header>
        <div className="drawer-body">{children}</div>
        {footer !== undefined ? <footer className="drawer-footer">{footer}</footer> : null}
      </div>
    </>
  );
}
