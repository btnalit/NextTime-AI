import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * components/kit/tooltip (S8 W1-A0, docs/development-tasks.md §5e decision F3): a thin styled
 * wrapper over Radix Tooltip. `TooltipProvider` must wrap the app/subtree once (it owns the
 * shared show/hide delay) — a page that adopts this kit mounts one `TooltipProvider` near its
 * root, same shape as `components/ui/Toast`'s `ToastProvider`. Not wired into any page yet.
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 rounded-s border border-border bg-surface-1 px-2 py-1.5 text-12 text-text shadow-1',
        className,
      )}
      {...rest}
    />
  );
});
