import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * components/kit/dropdown-menu (S8 W1-A3, docs/development-tasks.md §5e decision F3, audit C3): an
 * overflow-actions menu on Radix Dropdown Menu — positioning, roving focus, Escape and
 * outside-click all come from the primitive. First (and so far only) consumer: `chat/ChatHeader`'s
 * 改名 / 归档 overflow menu — row 1 of the two-row chat top bar has no room left for two more
 * buttons at 1280/768 once the title, status badge and Stop are laid out (audit C3).
 */
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-36 rounded-m border border-border bg-surface-1 p-1 shadow-1',
          className,
        )}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(function DropdownMenuItem({ className, ...rest }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        'flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-s px-2 py-1.5 text-13 text-text outline-none data-[highlighted]:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-55',
        className,
      )}
      {...rest}
    />
  );
});

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...rest }, ref) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={cn('my-1 h-px bg-border', className)}
      {...rest}
    />
  );
});
