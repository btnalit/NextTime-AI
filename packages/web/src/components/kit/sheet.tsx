import * as DialogPrimitive from '@radix-ui/react-dialog';
import { type VariantProps, cva } from 'class-variance-authority';
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
  useCallback,
  useRef,
} from 'react';
import { cn } from '../../lib/cn.js';
import { type DiscardGuard, GuardedCloseProvider, useDiscardGuard } from './discard-guard.js';

/**
 * components/kit/sheet (S8 W1-A0, docs/development-tasks.md §5e decision F3): a side drawer on
 * Radix Dialog (per the dispatch: "side drawer on Radix Dialog"), the Tailwind/Radix counterpart
 * of the existing hand-rolled `components/ui/Drawer`. `side` defaults to `right`, matching Drawer.
 * Not wired into any page yet.
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetPortal = DialogPrimitive.Portal;

export const SheetOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function SheetOverlay({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('fixed inset-0 z-50 bg-overlay', className)}
      {...rest}
    />
  );
});

const sheetVariants = cva(
  // `--overlay-actions-inset` = the bottom padding a pinned action row covers (legacy 347). The
  // sheet is its own scroller, so it leaves that row out of what a focused field (a refusal's
  // banner) scrolls into — as `.drawer-body` does in styles/pages.css (#791 UX acceptance P3-1).
  'fixed z-50 flex flex-col gap-4 overflow-y-auto border-border bg-surface-1 p-5 shadow-1 [--overlay-actions-inset:1.25rem] [&:has(.overlay-actions)]:[scroll-padding-bottom:112px]',
  {
    variants: {
      side: {
        right: 'inset-y-0 right-0 h-full w-full border-l',
        left: 'inset-y-0 left-0 h-full w-full border-r',
        top: 'inset-x-0 top-0 w-full border-b',
        bottom: 'inset-x-0 bottom-0 w-full border-t',
      },
      // console redesign P2 (components/systems/SystemsPage): `default` keeps every existing
      // consumer's exact width (`max-w-md`, unchanged); `wide` is for a multi-step form
      // (`ConnectSystemLauncher`/`OnboardingWizard`/`CompleteConnectionForm`/
      // `RequestConnectionForm`) that used to open in `components/ui/Drawer`'s own `wide` prop
      // (640px) — a page built only from `components/kit/*` has no other way to size one wider,
      // since Tailwind utilities are only generated for files under `components/kit/**`
      // (`styles/tailwind.css`'s `@source`).
      size: {
        default: 'max-w-md',
        wide: 'max-w-2xl',
      },
    },
    defaultVariants: {
      side: 'right',
      size: 'default',
    },
  },
);

export interface SheetContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  /** The guard to use — for a caller that hands it to content it renders elsewhere (a portal,
   *  `kit/master-detail`); by default the sheet keeps its own. */
  readonly discardGuard?: DiscardGuard;
}

/**
 * Legacy 497: an edited form in the sheet is not lost to a stray Escape or outside click — the
 * sheet asks 「放弃未保存的内容？」 first (`kit/discard-guard`), and a form's own 取消 asks the same
 * through `useGuardedClose`. A sheet nothing was typed into closes as before. A caller's own
 * `onEscapeKeyDown` / `onInteractOutside` runs first; one that prevents the close keeps it.
 */
export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(function SheetContent(
  {
    side,
    className,
    children,
    onEscapeKeyDown,
    onInteractOutside,
    onOpenAutoFocus,
    discardGuard,
    ...rest
  },
  ref,
) {
  const own = useDiscardGuard();
  const discard = discardGuard ?? own;
  // The sheet's own close, as its Close button would — the Root's `onOpenChange(false)`.
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => closeRef.current?.click();
  // The guard watches the sheet's element itself: a detail portaled into it is outside its React
  // tree, so React's own events would not see its edits.
  const detach = useRef<{ el: HTMLElement; off: () => void } | null>(null);
  const attach = discard.attach;
  const contentRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (detach.current?.el !== el) {
        detach.current?.off();
        detach.current = el === null ? null : { el, off: attach(el) };
      }
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref, attach],
  );
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={contentRef}
        className={cn(sheetVariants({ side }), className)}
        {...rest}
        onOpenAutoFocus={(event) => {
          discard.reset();
          onOpenAutoFocus?.(event);
        }}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (event.defaultPrevented || !discard.edited()) return;
          event.preventDefault();
          discard.guard(close);
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (event.defaultPrevented || !discard.edited()) return;
          event.preventDefault();
          discard.guard(close);
        }}
      >
        <GuardedCloseProvider guard={discard.guard}>{children}</GuardedCloseProvider>
        <DialogPrimitive.Close ref={closeRef} hidden tabIndex={-1} aria-hidden />
        {discard.confirm}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
});

export function SheetHeader({ className, ...rest }: ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('flex flex-col gap-1.5', className)} {...rest} />;
}

export function SheetFooter({ className, ...rest }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      // Legacy 347: pinned to the bottom of the sheet while its body scrolls (styles/ui.css).
      className={cn(
        'overlay-actions mt-auto flex flex-row-reverse flex-wrap items-center gap-2',
        className,
      )}
      {...rest}
    />
  );
}

export const SheetTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function SheetTitle({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-16 font-semibold text-text', className)}
      {...rest}
    />
  );
});

export const SheetDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function SheetDescription({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-13 text-text-2', className)}
      {...rest}
    />
  );
});
