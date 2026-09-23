import {
  type HTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
  forwardRef,
} from 'react';
import { cn } from '../../lib/cn.js';

/**
 * components/kit/table (S8 W1-A0, docs/development-tasks.md §5e decision F3): a styled table
 * shell only — plain semantic `<table>` markup on the §5.9 tokens, no data-grid behaviour (S3's
 * "responsive data table" work wires TanStack Table on top of this in a later W1-A lane). Not
 * wired into any page yet.
 */
export const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement>>(function Table(
  { className, ...rest },
  ref,
) {
  return (
    <div className="w-full overflow-x-auto">
      <table ref={ref} className={cn('w-full border-collapse text-13', className)} {...rest} />
    </div>
  );
});

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...rest }, ref) {
  return <thead ref={ref} className={cn('border-b border-border-strong', className)} {...rest} />;
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...rest }, ref) {
  return <tbody ref={ref} className={className} {...rest} />;
});

export const TableFooter = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableFooter({ className, ...rest }, ref) {
  return (
    <tfoot
      ref={ref}
      className={cn('border-t border-border bg-surface-2 text-text-2', className)}
      {...rest}
    />
  );
});

export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  function TableRow({ className, ...rest }, ref) {
    return (
      <tr
        ref={ref}
        className={cn('border-b border-border last:border-b-0 hover:bg-surface-2', className)}
        {...rest}
      />
    );
  },
);

export const TableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  function TableHead({ className, ...rest }, ref) {
    return (
      <th
        ref={ref}
        className={cn('px-3 py-2 text-left text-12 font-medium text-text-3', className)}
        {...rest}
      />
    );
  },
);

export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  function TableCell({ className, ...rest }, ref) {
    return <td ref={ref} className={cn('px-3 py-2 text-text', className)} {...rest} />;
  },
);

export const TableCaption = forwardRef<
  HTMLTableCaptionElement,
  HTMLAttributes<HTMLTableCaptionElement>
>(function TableCaption({ className, ...rest }, ref) {
  return <caption ref={ref} className={cn('mt-2 text-12 text-text-3', className)} {...rest} />;
});
