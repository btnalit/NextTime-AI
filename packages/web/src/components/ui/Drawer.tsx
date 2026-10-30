import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { GuardedCloseProvider, useDiscardGuard } from '../kit/discard-guard.js';
import { focusOrigin } from '../kit/focus-origin.js';
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
  // What had focus as the drawer opened — where focus goes back on close. Read while rendering the
  // opening: by the time an effect here runs, a form inside may already have focused its first
  // field, and focus would go back to that field, gone with the drawer (#794 UX P3-3).
  const [opener, setOpener] = useState<HTMLElement | null>(() => (open ? focusOrigin() : null));
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpener(focusOrigin());
  }
  // Legacy 497: an edited form asks 「放弃未保存的内容？」 before Escape, the overlay or × close
  // it (`kit/discard-guard`, as `kit/sheet` does); the form's own 取消 asks via `useGuardedClose`.
  const discard = useDiscardGuard();
  const requestClose = useRef(() => discard.guard(onClose));
  requestClose.current = () => discard.guard(onClose);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh drawer forgets old edits.
  useEffect(() => {
    if (!open || panelRef.current === null) return;
    const detach = discard.attach(panelRef.current);
    discard.reset();
    return detach;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose.current();
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
      if (opener?.isConnected) opener.focus();
    };
  }, [open, opener]);

  if (!open) return null;

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc on the dialog is the keyboard path; the overlay is a pointer-only affordance. */}
      <div
        className="drawer-overlay"
        onClick={() => requestClose.current()}
        aria-hidden
        data-testid="drawer-overlay"
      />
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
            onClick={() => requestClose.current()}
          />
        </header>
        <GuardedCloseProvider guard={discard.guard}>
          <div className="drawer-body">{children}</div>
          {footer !== undefined ? <footer className="drawer-footer">{footer}</footer> : null}
        </GuardedCloseProvider>
      </div>
      {discard.confirm}
    </>
  );
}
