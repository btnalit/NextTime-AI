import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The console's type scale (`styles/tailwind.css` `--text-12`…`--text-24`) registered as
 * tailwind-merge font sizes. Without it, `text-12` is an unknown `text-*` class that tailwind-merge
 * lumps together with colour utilities like `text-text-on-primary`, and "last one wins" deleted the
 * colour: every size-`s` primary / danger kit Button rendered its label in the inherited ink on an
 * ink (later brand) fill — invisible (P3-2 "新对话", P3-3's filter pill).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['12', '13', '14', '16', '19', '24'] }],
    },
  },
});

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
