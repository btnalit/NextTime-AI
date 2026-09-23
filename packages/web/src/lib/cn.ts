import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * lib/cn: the shadcn/ui-style className combinator — `clsx` for conditional/array class
 * composition, `tailwind-merge` to resolve conflicting Tailwind utilities in favour of the last
 * one (e.g. `cn('p-2', condition && 'p-4')` keeps `p-4`, not both). Used only by
 * `components/kit/*` — every other component keeps composing plain string classNames the way
 * `components/ui/*` already does (no `cn` there; do not introduce it outside kit).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
