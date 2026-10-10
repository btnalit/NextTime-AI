import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { type ErrorOverrides, errorToastText } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { Button } from './button.js';
import { InlineError } from './inline-error.js';

/** §5.9 principle 4 — confirmation by impact, folded to three renderable tiers (S8 W1-A7, audit
 *  S13/RT2): `low` (直接执行 + Toast 撤销) and `irreversible` (键入目标名称 + 知情勾选) are unchanged
 *  from the doc's own definitions; the doc's `medium`/`high` split (一键批准 vs. 列影响范围的确认
 *  对话框) collapses into one `medium` — both were "reversible, needs a look before it runs", and
 *  once the confirm is a popover anchored to its own trigger (this file's whole point) rather than
 *  a plain `<section>` rendered wherever the caller happened to place it in the tree, there is no
 *  longer a reason for "high" to route to a separate full-screen surface just to stay near the
 *  click that opened it — `medium` already renders `impact` when the caller passes it. */
export type ConfirmLevel = 'low' | 'medium' | 'irreversible';

export interface ConfirmNotify {
  readonly tone: 'ok' | 'danger';
  readonly title: string;
  readonly description?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  readonly key?: string;
}

export interface ConfirmProps {
  readonly tier: ConfirmLevel;
  /** Controlled, Radix-style — the caller's own trigger flips this on; Escape / Cancel / a
   *  successful confirm flips it back off through this same setter. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The trigger, rendered in place exactly where the caller used to render it — `medium`
   *  positions its popover relative to this node (`Popover.Anchor`, not `Trigger`: the caller
   *  already owns the click that flips `open`, so `Confirm` only needs to know *where* to point
   *  the popover, never needs to intercept the click itself). `irreversible`/`low` render it as a
   *  plain sibling. Omit only when the trigger has already unmounted by the time this tier opens
   *  (a wizard's own "next step" — `irreversible` is a centred modal regardless). */
  readonly anchor?: ReactNode;
  readonly title: string;
  readonly description?: ReactNode;
  /** The target's display name — shown in `medium`/`irreversible`, retyped for `irreversible`.
   *  Omit for a batch with no single name (`irreversible` then only asks for the acknowledgement
   *  checkbox, same as the pre-kit component). */
  readonly target?: string;
  /** What the change touches, one line each — rendered under "影响范围 Impact". */
  readonly impact?: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Destructive styling on the confirm button (`irreversible` is always destructive). */
  readonly danger?: boolean;
  /** May be async — the confirm button disables and `aria-busy`s; a thrown error renders inline
   *  and the confirm stays open. */
  readonly onConfirm: () => void | Promise<void>;
  /** This action's own copy for particular error codes (`lib/errors.ts` `presentError`); throw
   *  the error as it came and name the copy here, so the kernel's text still reaches 「技术细节」. */
  readonly errorOverrides?: ErrorOverrides;
  /** Extra body content (parameters, a RefChip, a typed field the caller collects). */
  readonly children?: ReactNode;
  /** `medium`/`irreversible`: keeps the confirm button disabled while a field the caller collects
   *  in `children` is still incomplete (e.g. a required, audited reason). */
  readonly confirmDisabled?: boolean;
  readonly testId?: string;
  /** `low` only: pushes the after-the-fact toast. `kit/confirm` carries no toast system of its
   *  own (S8 risk ① — a new `components/kit/*` file may not import `components/ui/*`); the caller
   *  wires its own `useToast().push` straight through (the shapes match `ui/Toast`'s `ToastInput`
   *  structurally). */
  readonly notify?: (input: ConfirmNotify) => void;
  /** `low` only: the toast's undo action. */
  readonly undo?: { readonly label?: string; readonly onUndo: () => void | Promise<void> };
}

/**
 * components/kit/confirm (S8 W1-A7, docs/console-completion-plan.md §5.9 principle 4; audit
 * S13/RT2 "确认按影响分级... 就近弹出"): the Radix/Tailwind replacement for `components/ui/
 * ConfirmTier` — every tier now renders next to the control that opened it instead of wherever
 * the caller happened to place the JSX.
 *
 * - `low`: fires `onConfirm` the moment `open` flips true, then `notify`s success (with `undo`)
 *   or failure, then closes. No visible surface of its own — `anchor` is rendered plain.
 * - `medium`: a Radix `Popover` anchored to `anchor` (`side="bottom" align="end"`, an 8px offset;
 *   Popper repositions on collision). `modal` — focus moves onto the confirm button on open
 *   (`onOpenAutoFocus`, overridden: Radix's own default targets the first focusable descendant,
 *   not necessarily the confirm button) and back to the trigger on close via
 *   `useRestoreFocusOnClose` below (a manual replacement for Radix's built-in restore, which only
 *   fires through a rendered `Trigger`'s own ref — this file uses `Anchor` instead, precisely
 *   because several callers cannot reach their real trigger element, e.g. a shared card's own
 *   Approve/Reject button with no forwarded ref). Escape/outside-click close it unless a confirm
 *   is in flight.
 * - `irreversible`: a centred Radix `AlertDialog` (never anchored — a destructive, unrecoverable
 *   action gets the viewport's full attention regardless of where the trigger sits). The danger
 *   button stays disabled until the target name is retyped (skipped when `target` is omitted —
 *   a batch action with no single name to type) and the acknowledgement is checked.
 */
export function Confirm(props: ConfirmProps) {
  if (props.tier === 'low') return <LowTier {...props} />;
  if (props.tier === 'medium') return <MediumTier {...props} />;
  return <IrreversibleTier {...props} />;
}

/** Runs the action once, keeping the latest callbacks in refs so a re-render with a fresh closure
 *  never re-fires the effect (which keys on `open` alone). */
function LowTier({
  anchor,
  open,
  onOpenChange,
  onConfirm,
  notify,
  undo,
  title,
  errorOverrides,
}: ConfirmProps) {
  const t = useT();
  const latest = useRef({ onConfirm, onOpenChange, notify, undo, title, t, errorOverrides });
  latest.current = { onConfirm, onOpenChange, notify, undo, title, t, errorOverrides };
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const { onConfirm, onOpenChange, notify, undo, title, t, errorOverrides } = latest.current;
      try {
        await onConfirm();
        if (cancelled) return;
        notify?.({
          tone: 'ok',
          title,
          key: `confirm-low:${title}`,
          action: undo
            ? { label: undo.label ?? t('撤销', 'Undo'), onClick: () => void undo.onUndo() }
            : undefined,
        });
      } catch (error) {
        if (cancelled) return;
        notify?.({
          tone: 'danger',
          title: `${title} — ${t('失败', 'failed')}`,
          description: errorToastText(error, t, errorOverrides),
        });
      }
      onOpenChange(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);
  return <>{anchor}</>;
}

/** Shared confirm-button state machine for the `medium`/`irreversible` tiers. `clearError` lets a
 *  tier start a fresh attempt without a stale banner (R-44). */
function useConfirmRun(onConfirm: () => void | Promise<void>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const clearError = () => setError(null);
  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, clearError };
}

function TargetLine({ target }: { readonly target: string | undefined }) {
  const t = useT();
  if (target === undefined) return null;
  return (
    <dl className="flex flex-col gap-0.5 text-13">
      <dt className="text-text-2">{t('目标', 'Target')}</dt>
      <dd className="font-medium text-text" data-testid="confirm-target">
        {target}
      </dd>
    </dl>
  );
}

function ImpactList({ impact }: { readonly impact: readonly string[] | undefined }) {
  const t = useT();
  if (impact === undefined || impact.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-12 font-medium text-text-2">{t('影响范围', 'Impact')}</span>
      <ul className="flex flex-col gap-0.5 text-13 text-text" data-testid="confirm-impact">
        {impact.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** The confirm's inline error (`kit/inline-error`, console audit P1-1): the readable body plus
 *  「技术细节」, with `data-error-code` as `components/ui/ErrorBanner` has it, so a caller's
 *  assertions against `confirm-error` keep working. */
function ConfirmErrorBanner({
  error,
  overrides,
}: {
  readonly error: unknown;
  readonly overrides: ErrorOverrides | undefined;
}) {
  if (error === null) return null;
  return (
    <InlineError
      error={error}
      overrides={overrides}
      testId="confirm-error"
      className="rounded-s border border-danger bg-danger-soft px-3 py-2 text-13 text-danger"
    />
  );
}

/** Restores focus to whatever had it right before `open` turned true, once `open` turns back
 *  false. Radix's own auto-restore (`Popover`/`AlertDialog`) only fires through a rendered
 *  `Trigger`'s own ref — `Confirm` uses `Anchor`/a plain sibling instead (its `anchor` is
 *  sometimes a wrapper around a control this file cannot reach directly, e.g. a shared card's own
 *  button — see the module doc comment), so this does the same job generically off whatever
 *  `document.activeElement` was at open time, which in every real caller is the element the user
 *  just clicked. */
function useRestoreFocusOnClose(open: boolean): void {
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      return;
    }
    restoreRef.current?.focus?.();
    restoreRef.current = null;
  }, [open]);
}

function MediumTier({
  anchor,
  open,
  onOpenChange,
  title,
  description,
  target,
  impact,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  children,
  confirmDisabled = false,
  testId,
  errorOverrides,
}: ConfirmProps) {
  const t = useT();
  const resolvedConfirmLabel = confirmLabel ?? t('确认', 'Confirm');
  const resolvedCancelLabel = cancelLabel ?? t('取消', 'Cancel');
  const { busy, error, run } = useConfirmRun(onConfirm, () => onOpenChange(false));
  useRestoreFocusOnClose(open);
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  // `display: contents` keeps every caller's layout untouched, but it also leaves the wrapper
  // with no box — Popper measuring it gets a zero rect and pins the popover to the viewport's
  // top-left. Popper measures the wrapped trigger instead (Radix's `virtualRef`).
  const anchorWrapRef = useRef<HTMLDivElement>(null);
  const virtualAnchor = useRef({
    getBoundingClientRect: (): DOMRect => {
      const wrap = anchorWrapRef.current;
      return (wrap?.firstElementChild ?? wrap)?.getBoundingClientRect() ?? new DOMRect();
    },
  });
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      modal
    >
      <div ref={anchorWrapRef} className="contents">
        {anchor}
      </div>
      <PopoverPrimitive.Anchor virtualRef={virtualAnchor} />
      {open ? (
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            // biome-ignore lint/a11y/useSemanticElements: Radix's Popover.Content renders a
            // styled, positioned `div` (Popper anchoring, portal, focus scope) a native `<dialog>`
            // cannot provide without losing all of that — the same trade-off `components/ui/
            // Drawer.tsx` already makes for its own hand-rolled dialog pattern.
            role="dialog"
            aria-labelledby={titleId}
            side="bottom"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            data-testid={testId}
            data-tier="medium"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              confirmRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              // Radix's dismissable layer listens in the capture phase; a caller may render
              // `anchor` inside `components/ui/Drawer`'s own hand-rolled bubble-phase `document`
              // Escape listener — stop it here so Escape closes only this popover, never a legacy
              // drawer wrapped around it too (both would otherwise see the same keydown).
              event.stopPropagation();
              if (busy) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (busy) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (busy) event.preventDefault();
            }}
            className={cn(
              'z-50 flex w-80 flex-col gap-3 rounded-m border border-border bg-surface-1 p-4 shadow-1',
            )}
          >
            <div id={titleId} className="text-14 font-semibold text-text">
              {title}
            </div>
            {description !== undefined ? (
              <div className="text-13 text-text-2">{description}</div>
            ) : null}
            <TargetLine target={target} />
            <ImpactList impact={impact} />
            {children}
            <ConfirmErrorBanner error={error} overrides={errorOverrides} />
            <div className="flex flex-row-reverse flex-wrap items-center gap-2">
              <Button
                ref={confirmRef}
                variant={danger ? 'danger' : 'primary'}
                size="s"
                aria-busy={busy}
                disabled={busy || confirmDisabled}
                onClick={() => void run()}
                data-testid="confirm-button"
              >
                {resolvedConfirmLabel}
              </Button>
              <Button
                variant="ghost"
                size="s"
                onClick={() => onOpenChange(false)}
                disabled={busy}
                data-testid="confirm-cancel"
              >
                {resolvedCancelLabel}
              </Button>
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      ) : null}
    </PopoverPrimitive.Root>
  );
}

function IrreversibleTier({
  anchor,
  open,
  onOpenChange,
  title,
  description,
  target,
  impact,
  confirmLabel,
  cancelLabel,
  onConfirm,
  children,
  confirmDisabled = false,
  testId,
  errorOverrides,
}: ConfirmProps) {
  const t = useT();
  const resolvedConfirmLabel = confirmLabel ?? t('确认', 'Confirm');
  const resolvedCancelLabel = cancelLabel ?? t('取消', 'Cancel');
  const { busy, error, run, clearError } = useConfirmRun(onConfirm, () => onOpenChange(false));
  useRestoreFocusOnClose(open);
  const [typed, setTyped] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  // R-44 (review 2026-10-02): this tier stays mounted for as long as its caller renders it (only
  // the portal depends on `open`), so the retyped name, the acknowledgement and a failed attempt's
  // error would otherwise survive a Cancel — and the next open would arrive pre-filled, one click
  // from an irreversible action. Reset all three whenever `open` turns true, during render (React's
  // "adjust state when a prop changes" pattern), so the dialog never paints with the old values.
  const [openSeen, setOpenSeen] = useState(open);
  if (open !== openSeen) {
    setOpenSeen(open);
    if (open) {
      setTyped('');
      setAcknowledged(false);
      clearError();
    }
  }
  const typedId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const nameMatches = target === undefined ? true : typed.trim() === target;
  const ready = nameMatches && acknowledged && !confirmDisabled;

  return (
    <AlertDialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      {anchor}
      {open ? (
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
          <AlertDialogPrimitive.Content
            data-testid={testId}
            data-tier="irreversible"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onEscapeKeyDown={(event) => {
              // See the same guard in `MediumTier` above — stops Escape from also reaching a
              // legacy `components/ui/Drawer` this dialog might be rendered inside.
              event.stopPropagation();
              if (busy) event.preventDefault();
            }}
            className={cn(
              'fixed left-1/2 top-1/2 z-50 flex w-full max-w-md -translate-x-1/2 -translate-y-1/2',
              'flex-col gap-3 rounded-l border border-border bg-surface-1 p-5 shadow-1',
            )}
          >
            <AlertDialogPrimitive.Title id={titleId} className="text-16 font-semibold text-text">
              {title}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description id={descriptionId} className="text-13 text-text-2">
              {t(
                '不可逆：请键入目标名称并确认知情',
                'Irreversible: type the target name and confirm you understand',
              )}
            </AlertDialogPrimitive.Description>
            {description !== undefined ? (
              <div className="text-13 text-text-2">{description}</div>
            ) : null}
            <TargetLine target={target} />
            <ImpactList impact={impact} />
            {children}
            {target !== undefined ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={typedId} className="text-13 font-medium text-text">
                  键入 "{target}
                  {t('" 以确认', 'Type the target name to confirm')}
                </label>
                <input
                  id={typedId}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 rounded-m border border-border-strong bg-surface-1 px-2 text-13 text-text"
                  data-testid="confirm-typed-name"
                />
              </div>
            ) : null}
            <label className="flex items-start gap-2 text-13 text-text">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                data-testid="confirm-acknowledge"
                className="mt-0.5"
              />
              <span>
                {t(
                  '我知道此操作不可逆，且会写入平台审计。',
                  'I understand this cannot be undone and is recorded in the platform audit.',
                )}
              </span>
            </label>
            <ConfirmErrorBanner error={error} overrides={errorOverrides} />
            <div className="flex flex-row-reverse flex-wrap items-center gap-2">
              <Button
                variant="danger"
                size="s"
                aria-busy={busy}
                disabled={busy || !ready}
                onClick={() => void run()}
                data-testid="confirm-button"
              >
                {resolvedConfirmLabel}
              </Button>
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="ghost" size="s" disabled={busy} data-testid="confirm-cancel">
                  {resolvedCancelLabel}
                </Button>
              </AlertDialogPrimitive.Cancel>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      ) : null}
    </AlertDialogPrimitive.Root>
  );
}
