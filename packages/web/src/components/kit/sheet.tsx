import * as DialogPrimitive from '@radix-ui/react-dialog';
import { type VariantProps, cva } from 'class-variance-authority';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

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
  'fixed z-50 flex flex-col gap-4 border-border bg-surface-1 p-5 shadow-1',
  {
    variants: {
      side: {
        right: 'inset-y-0 right-0 h-full w-full max-w-md border-l',
        left: 'inset-y-0 left-0 h-full w-full max-w-md border-r',
        top: 'inset-x-0 top-0 w-full border-b',
        bottom: 'inset-x-0 bottom-0 w-full border-t',
      },
    },
    defaultVariants: {
      side: 'right',
    },
  },
);

export interface SheetContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(function SheetContent({ side, className, children, ...rest }, ref) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(sheetVariants({ side }), className)}
        {...rest}
      >
        {children}
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
      className={cn('mt-auto flex flex-row-reverse flex-wrap items-center gap-2', className)}
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
