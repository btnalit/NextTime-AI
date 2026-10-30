import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
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
import { useT } from '../../lib/i18n.js';
import { Button, type ButtonProps } from './button.js';

/**
 * components/kit/discard-guard (legacy 497, coordinator's rule of 2026-10-29): a drawer whose form
 * was edited does not close on a stray Escape, outside click or 取消 — it asks 「放弃未保存的内容？」
 * first, focus on 继续编辑. One that was not edited closes as before. Both drawers — `kit/sheet`'s
 * `SheetContent` and the legacy `components/ui/Drawer` — use it, so every form in one gets the rule
 * without wiring of its own; a form's own 取消 asks through `useGuardedClose`.
 *
 * "Edited" means a field the person changed still holds something other than what it held before
 * they touched it, and is still on the page:
 * - a field is one inside a `<form>` or a `data-discard-guard` container (a form built without a
 *   `<form>`). A control that applies itself at once (a workspace's switch, a gate checkbox) is
 *   in neither: there is nothing unsaved to lose. One that only narrows or navigates what the
 *   drawer shows (a search box, a pick list for a purge) sits under `data-no-discard-guard`;
 * - typing something and deleting it again, or a form that clears itself after saving, is not an
 *   edit; a form submitted and replaced by its result (a draft proposed) is gone from the page.
 */
const FIELD = 'input, select, textarea';
const NOT_A_VALUE = new Set(['hidden', 'button', 'submit', 'reset', 'image']);

type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function asField(target: EventTarget | null): FieldElement | null {
  if (
    !(target instanceof HTMLInputElement) &&
    !(target instanceof HTMLSelectElement) &&
    !(target instanceof HTMLTextAreaElement)
  ) {
    return null;
  }
  if (target instanceof HTMLInputElement && NOT_A_VALUE.has(target.type)) return null;
  if (target.closest('form, [data-discard-guard]') === null) return null;
  if (target.closest('[data-no-discard-guard]') !== null) return null;
  return target;
}

function fieldValue(field: FieldElement): string {
  if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
    return String(field.checked);
  }
  if (field instanceof HTMLSelectElement && field.multiple) {
    return Array.from(field.selectedOptions, (option) => option.value).join('\n');
  }
  return field.value;
}

export interface DiscardGuard {
  /** Watch a drawer's element for edits; returns the detach. DOM events, not React's, so a detail
   *  portaled into the drawer (as `kit/master-detail` does) counts too. */
  readonly attach: (element: HTMLElement) => () => void;
  /** Whether a field the person changed still differs from what it held before, on the page. */
  readonly edited: () => boolean;
  /** Forget earlier edits — the drawer (re)opened. */
  readonly reset: () => void;
  /** Run `close` now, or once the person confirms discarding what they edited. */
  readonly guard: (close: () => void) => void;
  /** The confirmation, rendered inside the drawer. */
  readonly confirm: ReactNode;
}

export function useDiscardGuard(): DiscardGuard {
  const t = useT();
  // Fields the person changed, and what each held before they did.
  const touched = useRef(new Set<FieldElement>());
  const before = useRef(new WeakMap<FieldElement, string>());
  const attached = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  // What had focus when the question opened — 继续编辑 hands it back there.
  const returnTo = useRef<Element | null>(null);
  const note = useCallback((root: Element) => {
    const fields = root.matches(FIELD) ? [root] : Array.from(root.querySelectorAll(FIELD));
    for (const element of fields) {
      const field = asField(element);
      if (field !== null && !touched.current.has(field) && !before.current.has(field)) {
        before.current.set(field, fieldValue(field));
      }
    }
  }, []);
  const reset = useCallback(() => {
    touched.current.clear();
    before.current = new WeakMap();
    if (attached.current !== null) note(attached.current);
  }, [note]);
  const attach = useCallback(
    (element: HTMLElement) => {
      attached.current = element;
      note(element);
      // A field rendered later (a step, a row added) is noted as it first appears; one focused
      // is noted again then, so a value filled in by the page (a loaded default) is its "before".
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) if (node instanceof Element) note(node);
        }
      });
      observer.observe(element, { childList: true, subtree: true });
      const onFocus = (event: Event) => {
        const field = asField(event.target);
        if (field !== null && !touched.current.has(field))
          before.current.set(field, fieldValue(field));
      };
      const onEdit = (event: Event) => {
        const field = asField(event.target);
        if (field !== null) touched.current.add(field);
      };
      element.addEventListener('focusin', onFocus, true);
      element.addEventListener('input', onEdit, true);
      element.addEventListener('change', onEdit, true);
      return () => {
        observer.disconnect();
        element.removeEventListener('focusin', onFocus, true);
        element.removeEventListener('input', onEdit, true);
        element.removeEventListener('change', onEdit, true);
        if (attached.current === element) attached.current = null;
      };
    },
    [note],
  );
  const edited = useCallback(
    () =>
      [...touched.current].some(
        (field) => field.isConnected && fieldValue(field) !== before.current.get(field),
      ),
    [],
  );
  const guard = useCallback(
    (close: () => void) => {
      if (!edited()) {
        close();
        return;
      }
      returnTo.current = document.activeElement;
      setPending(() => close);
    },
    [edited],
  );
  const confirm = (
    <AlertDialogPrimitive.Root
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
    >
      {pending !== null ? (
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
          <AlertDialogPrimitive.Content
            data-testid="discard-confirm"
            onEscapeKeyDown={(event) => {
              // Escape answers this question (继续编辑) — it never also reaches a legacy
              // `components/ui/Drawer`'s own document listener around it.
              event.stopPropagation();
            }}
            onCloseAutoFocus={(event) => {
              // Radix would hand focus to a trigger this question has none of (<body>): back to
              // where the person was editing instead. After 放弃 that is gone with the drawer,
              // whose own close places focus.
              event.preventDefault();
              const back = returnTo.current;
              returnTo.current = null;
              if (back instanceof HTMLElement && back.isConnected) back.focus();
            }}
            className={cn(
              'fixed left-1/2 top-1/2 z-50 flex w-[min(24rem,calc(100vw-24px))] -translate-x-1/2',
              '-translate-y-1/2 flex-col gap-3 rounded-l border border-border bg-surface-1 p-5 shadow-1',
            )}
          >
            <AlertDialogPrimitive.Title className="text-16 font-semibold text-text">
              {t('放弃未保存的内容？', 'Discard unsaved changes?')}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="text-13 text-text-2">
              {t(
                '关闭后，这里填写或改动的内容不会保留。',
                'Once closed, what you filled in or changed here is not kept.',
              )}
            </AlertDialogPrimitive.Description>
            <div className="flex flex-row-reverse flex-wrap gap-2">
              {/* Radix focuses Cancel first: an Enter typed out of habit keeps the edits. */}
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="primary" size="s" data-testid="discard-confirm-keep">
                  {t('继续编辑', 'Keep editing')}
                </Button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                <Button
                  variant="danger"
                  size="s"
                  data-testid="discard-confirm-discard"
                  onClick={() => {
                    const close = pending;
                    touched.current.clear();
                    setPending(null);
                    close?.();
                  }}
                >
                  {t('放弃', 'Discard')}
                </Button>
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      ) : null}
    </AlertDialogPrimitive.Root>
  );
  return { attach, edited, reset, guard, confirm };
}

const GuardedCloseContext = createContext<((close: () => void) => void) | null>(null);

/** Gives the drawer's guard to the form inside it (`null`: no drawer around it now). */
export function GuardedCloseProvider({
  guard,
  children,
}: {
  readonly guard: ((close: () => void) => void) | null;
  readonly children: ReactNode;
}) {
  return <GuardedCloseContext.Provider value={guard}>{children}</GuardedCloseContext.Provider>;
}

/** A form's 取消: `guarded(onCancel)` asks first inside a drawer whose form was edited, and just
 *  closes anywhere else (a page, the wide catalog pane). */
export function useGuardedClose(): (close: () => void) => void {
  const guard = useContext(GuardedCloseContext);
  return useMemo(() => guard ?? ((close: () => void) => close()), [guard]);
}

/** A drawer footer's 取消 for a component that renders the drawer itself: `onCancel` runs through
 *  the drawer's guard. */
export function GuardedCancelButton({
  onCancel,
  ...rest
}: Omit<ButtonProps, 'onClick'> & { readonly onCancel: () => void }) {
  const guarded = useGuardedClose();
  return <Button {...rest} onClick={() => guarded(onCancel)} />;
}
