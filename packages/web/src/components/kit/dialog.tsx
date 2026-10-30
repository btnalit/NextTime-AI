import * as DialogPrimitive from '@radix-ui/react-dialog';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';
import { GuardedDialogContent, type GuardedDialogContentProps } from './discard-guard.js';

/**
 * components/kit/dialog (S8 W1-A0, docs/development-tasks.md §5e decision F3): a centred modal on
 * Radix Dialog — focus trap, Escape, focus return and the portal all come from the primitive
 * (`components/ui/Drawer` hand-rolls the same behaviour for the existing side-drawer pattern).
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('fixed inset-0 z-50 bg-overlay', className)}
      {...rest}
    />
  );
});

/** Legacy 497, extended to dialogs (#794 UX P3-2, coordinator 2026-10-30): an edited form asks
 *  「放弃未保存的内容？」 before Escape, an outside click or its 取消 drop it, as in a drawer. */
export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  GuardedDialogContentProps
>(function DialogContent({ className, children, ...rest }, ref) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <GuardedDialogContent
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
          'rounded-l border border-border bg-surface-1 p-5 shadow-1',
          // UX acceptance of #612 (MUST-1): centred, a tall one would overflow both edges.
          'max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain',
          // The bottom padding a pinned `DialogFooter` covers (legacy 347).
          '[--overlay-actions-inset:1.25rem]',
          className,
        )}
        {...rest}
      >
        {children}
      </GuardedDialogContent>
    </DialogPortal>
  );
});

export function DialogHeader({ className, ...rest }: ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('mb-4 flex flex-col gap-1.5', className)} {...rest} />;
}

export function DialogFooter({ className, ...rest }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      // Legacy 347: pinned to the bottom of the dialog while its body scrolls (styles/ui.css).
      className={cn(
        'overlay-actions mt-5 flex flex-row-reverse flex-wrap items-center gap-2',
        className,
      )}
      {...rest}
    />
  );
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-16 font-semibold text-text', className)}
      {...rest}
    />
  );
});

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...rest }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-13 text-text-2', className)}
      {...rest}
    />
  );
});
