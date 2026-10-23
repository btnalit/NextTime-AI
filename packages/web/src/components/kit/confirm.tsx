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
 *   Popper repositions on collision; a body too tall for above or below moves beside the trigger
 *   when there is room). `modal` — focus moves onto the confirm button on open, or onto 取消
 *   when `danger` or `confirmDisabled` (`onOpenAutoFocus`, overridden: Radix's own default
 *   targets the first focusable descendant, not necessarily either button) and back to the
 *   trigger on close via `useRestoreFocusOnClose` below (a manual replacement for Radix's
 *   built-in restore, which only fires through a rendered `Trigger`'s own ref — this file uses
 *   `Anchor` instead, precisely because several callers cannot reach their real trigger
 *   element, e.g. a shared card's own Approve/Reject button with no forwarded ref).
 *   Escape/outside-click close it unless a confirm is in flight.
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

/** Shared confirm-button state machine for the `medium`/`irreversible` tiers. A failed attempt's
 *  error is dropped whenever `open` turns true (R-44 for the irreversible tier; UX acceptance of
 *  #579 P2 for every tier): both stay mounted while closed, so a refusal the caller was told to
 *  fix by reopening — `manifest_changed`'s 「请重新打开查看」 — would otherwise greet the reopened
 *  dialog as if it still stood. Reset during render (React's "adjust state when a prop changes"
 *  pattern), so the dialog never paints with the old error. */
function useConfirmRun(open: boolean, onConfirm: () => void | Promise<void>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openSeen, setOpenSeen] = useState(open);
  if (open !== openSeen) {
    setOpenSeen(open);
    if (open) setError(null);
  }
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
  return { busy, error, run };
}

function TargetLine({ target }: { readonly target: string | undefined }) {
  const t = useT();
  if (target === undefined) return null;
  return (
    <dl className="flex flex-col gap-0.5 text-13">
      <dt className="text-text-2">{t('目标', 'Target')}</dt>
      <dd className="font-medium text-text wrap-anywhere" data-testid="confirm-target">
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
      // Pinned with the buttons (legacy 347), so a long refusal scrolls inside itself rather
      // than pushing them back off the confirm.
      className="max-h-40 overflow-y-auto rounded-s border border-danger bg-danger-soft px-3 py-2 text-13 text-danger"
    />
  );
}

/** Legacy 347 (UX acceptance of #612 and #651): a confirm is a scrolling body over a pinned action
 *  row, never one scrolling box — capped to the viewport, a tall body (a long impact list, a
 *  loosening warning) used to push 确认 / 取消 below the fold, so the last look before an action
 *  could be clicked through half-read or not found at all. `padding` follows the surface: `m` for
 *  the popover, `l` for the centred dialog. */
function ConfirmBody({
  padding = 'm',
  onOverflow,
  children,
}: {
  readonly padding?: 'm' | 'l';
  /** Called while the body does not fit — the medium tier uses it to move beside its trigger. */
  readonly onOverflow?: () => void;
  readonly children: ReactNode;
}) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement>(null);
  const moreBelow = useMoreBelow(bodyRef);
  const latestOnOverflow = useRef(onOverflow);
  latestOnOverflow.current = onOverflow;
  useEffect(() => {
    if (moreBelow) latestOnOverflow.current?.();
  }, [moreBelow]);
  return (
    <div
      ref={bodyRef}
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain',
        padding === 'l' ? 'p-5' : 'p-4',
      )}
      data-testid="confirm-body"
    >
      {children}
      {/* Legacy 404 (UX acceptance of #653 P3-1): a cut-off body said so only through a half-shown
       *  line — on a loosening confirm, the 分类变化 being confirmed could sit under the fold
       *  unnoticed. While more is below, a fade and a 「下面还有内容」 chip sit over the bottom
       *  edge; the chip scrolls the body on. Sticky against the body's own bottom edge (the
       *  negative offset undoes its padding), so it adds no gap once the end is reached. */}
      {moreBelow ? (
        <div
          className={cn(
            'pointer-events-none sticky flex shrink-0 justify-center pt-6 pb-2',
            'bg-[linear-gradient(to_top,var(--surface-1)_45%,transparent)]',
            padding === 'l' ? '-bottom-5 -mb-5' : '-bottom-4 -mb-4',
          )}
          data-testid="confirm-more-below"
        >
          <button
            type="button"
            // Legacy 411 (UX acceptance of #655 P3-2): clicking the chip leaves focus where it was —
            // on a danger confirm that is 取消 — instead of dropping it onto the popover once the
            // chip unmounts; keyboard readers scroll the body itself, so it stays out of Tab order.
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            className="pointer-events-auto rounded-full border border-border bg-surface-1 px-3 py-1 text-12 text-text-2 shadow-1 hover:text-text"
            onClick={() => {
              const body = bodyRef.current;
              body?.scrollBy?.({ top: body.clientHeight * 0.8, behavior: 'smooth' });
            }}
          >
            {t('↓ 下面还有内容', '↓ More below')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Whether the body scrolls on past its bottom edge — re-measured on scroll and whenever the body
 *  or its content changes size (Radix sets the popover's available height after the first paint). */
function useMoreBelow(ref: { readonly current: HTMLDivElement | null }): boolean {
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    const body = ref.current;
    if (body === null) return;
    const update = () => setMoreBelow(body.scrollHeight - body.scrollTop - body.clientHeight > 4);
    update();
    body.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(body);
    for (const child of Array.from(body.children)) observer?.observe(child);
    return () => {
      body.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [ref]);
  return moreBelow;
}

function ConfirmActions({
  padding = 'm',
  children,
}: {
  readonly padding?: 'm' | 'l';
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-3 border-t border-border',
        padding === 'l' ? 'px-5 py-4' : 'px-4 py-3',
      )}
      data-testid="confirm-actions"
    >
      {children}
    </div>
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

const SIDE_OFFSET = 8;
const COLLISION_PADDING = 12;

/** The medium tier's width, `min(24rem, 100vw − 24px)`, in pixels. */
function popoverWidthPx(): number {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Math.min(24 * rem, window.innerWidth - 24);
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
  const { busy, error, run } = useConfirmRun(open, onConfirm, () => onOpenChange(false));
  useRestoreFocusOnClose(open);
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
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
  // Legacy 410 (UX acceptance of #655 P3-1): on a short viewport (1280×800) neither the space
  // above nor below the trigger fits a loosening confirm, and the 分类变化 it asks about sat under
  // the fold. When the body overflows and there is room beside the trigger, the popover moves to
  // that side, where it may use the viewport's full height. Kept until it closes, so it never
  // flips back.
  const [beside, setBeside] = useState<'left' | 'right' | null>(null);
  if (!open && beside !== null) setBeside(null);
  function moveBesideIfRoom(): void {
    if (beside !== null) return;
    const rect = virtualAnchor.current.getBoundingClientRect();
    const needed = popoverWidthPx() + SIDE_OFFSET + COLLISION_PADDING;
    const left = rect.left;
    const right = window.innerWidth - rect.right;
    if (Math.max(left, right) < needed) return;
    setBeside(left >= right ? 'left' : 'right');
  }
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
            side={beside ?? 'bottom'}
            align={beside === null ? 'end' : 'center'}
            sideOffset={SIDE_OFFSET}
            collisionPadding={COLLISION_PADDING}
            data-testid={testId}
            data-tier="medium"
            data-beside={beside ?? undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              // Legacy 405 (UX acceptance of #653 P3-2): a `danger` confirm (loosening an
              // approval, disabling, discarding) opens on 取消, so an Enter typed out of habit
              // never runs it; the irreversible tier's AlertDialog already does (Radix).
              // UX acceptance of #679 P3-1: so does one whose confirm button starts disabled (a
              // box to tick, a reason to type) — a disabled button takes no focus, which left it
              // on the trigger behind the popover, unheard by a screen reader. Never onto the
              // first box to tick: a stray Space would tick it before it was read.
              (danger || confirmDisabled ? cancelRef : confirmRef).current?.focus();
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
            // UX acceptance of #612 (MUST-1): a tall confirm (a long impact list, a loosening
            // warning) never runs off the viewport where nothing can scroll it back — it is capped
            // to the space Radix measured on its side. Legacy 347 (UX acceptance of #612, #651):
            // only the body scrolls; the buttons (and a refusal) stay pinned under it, so the last
            // look before loosening an approval never needs a scroll to reach 发布 / 取消. 24rem
            // (was 20rem) also makes the usual confirm shorter.
            className={cn(
              'z-50 flex w-[min(24rem,calc(100vw-24px))] flex-col rounded-m border border-border',
              'bg-surface-1 shadow-1 max-h-[var(--radix-popover-content-available-height)]',
            )}
          >
            <ConfirmBody onOverflow={moveBesideIfRoom}>
              <div id={titleId} className="text-14 font-semibold text-text">
                {title}
              </div>
              {description !== undefined ? (
                <div className="text-13 text-text-2">{description}</div>
              ) : null}
              <TargetLine target={target} />
              <ImpactList impact={impact} />
              {children}
            </ConfirmBody>
            <ConfirmActions>
              <ConfirmErrorBanner error={error} overrides={errorOverrides} />
              <div className="flex flex-row-reverse flex-wrap items-center gap-2">
                {/* ux-lint-allow-disabled: `confirmDisabled` is the caller's; its body says why (credential review, typed name). */}
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
                  ref={cancelRef}
                  variant="ghost"
                  size="s"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                  data-testid="confirm-cancel"
                >
                  {resolvedCancelLabel}
                </Button>
              </div>
            </ConfirmActions>
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
  const { busy, error, run } = useConfirmRun(open, onConfirm, () => onOpenChange(false));
  useRestoreFocusOnClose(open);
  const [typed, setTyped] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  // R-44 (review 2026-10-02): this tier stays mounted for as long as its caller renders it (only
  // the portal depends on `open`), so the retyped name and the acknowledgement would otherwise
  // survive a Cancel — and the next open would arrive pre-filled, one click from an irreversible
  // action. Reset both whenever `open` turns true, during render (React's "adjust state when a
  // prop changes" pattern), so the dialog never paints with the old values; `useConfirmRun` drops
  // the failed attempt's error the same way.
  const [openSeen, setOpenSeen] = useState(open);
  if (open !== openSeen) {
    setOpenSeen(open);
    if (open) {
      setTyped('');
      setAcknowledged(false);
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
              'flex-col rounded-l border border-border bg-surface-1 shadow-1',
              // UX acceptance of #612 (MUST-1): centred, a tall one would overflow both edges.
              // Legacy 347: only the body scrolls — the typed name, the acknowledgement and the
              // button they unlock stay pinned under it.
              'max-h-[calc(100dvh-2rem)]',
            )}
          >
            <ConfirmBody padding="l">
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
            </ConfirmBody>
            <ConfirmActions padding="l">
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
                {/* ux-lint-allow-disabled: the confirm asks to type the name right above; until it matches, that line says so. */}
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
            </ConfirmActions>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      ) : null}
    </AlertDialogPrimitive.Root>
  );
}
