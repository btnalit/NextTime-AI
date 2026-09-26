import { Slot } from '@radix-ui/react-slot';
import { type VariantProps, cva } from 'class-variance-authority';
import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

/** Mirrors `components/ui/Button`'s four weights and two sizes (docs/console-completion-plan.md
 *  §5.9; design system v2: primary is the brand `--primary` with hover and press steps, one per
 *  page). `s` stays at the 28px floor §5.9 principle 6 allows for in-row/toast placement; `m` is
 *  the default 36px minimum click height. */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-m text-13 font-medium transition-[color,background-color,border-color,box-shadow] duration-150 ease-out disabled:pointer-events-none disabled:opacity-55',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-text-on-primary shadow-card hover:bg-primary-hover active:bg-primary-press',
        secondary: 'border border-border-strong bg-surface-2 text-text hover:bg-surface-3',
        ghost: 'bg-transparent text-text-2 hover:bg-surface-2 hover:text-text',
        danger: 'bg-danger-soft text-danger hover:bg-danger hover:text-text-on-accent',
      },
      size: {
        s: 'h-7 px-2 text-12',
        m: 'h-9 px-3',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'm',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Renders the single child as the button element (Radix `Slot`) instead of a `<button>` — for
   *  "this is really a link styled as a button" cases. The child must accept `className`/`ref`. */
  readonly asChild?: boolean;
}

/**
 * components/kit/button (S8 W1-A0, docs/development-tasks.md §5e decision F3): the Tailwind/Radix
 * foundation's button primitive. Not wired into any page yet — `components/ui/Button` remains the
 * one every page renders until its own migration lane (risk ①, same section). `type` defaults to
 * `button` so a stray click inside a form never submits it by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type = 'button', ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    />
  );
});
