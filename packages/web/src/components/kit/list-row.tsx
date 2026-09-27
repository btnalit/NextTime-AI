import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export interface ListProps {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly className?: string;
}

/**
 * components/kit/list-row (console redesign P3-4, V6 "待我审批" master list): a selectable list —
 * a plain `<ul>` of real `<button>` rows. Native button semantics (focus, Enter/Space, disabled)
 * replace the hand-rolled `tabIndex`/`onKeyDown` arrow-key handling `components/ui/DataList` needed
 * for its own non-button `<li>` rows; a row has no synthetic keyboard code to keep in sync. Divider
 * between rows is the list's own hairline border (`border-border`), not a per-row shadow.
 *
 * Generic on purpose — `List`/`ListRow` carry no domain fields (no id, no chip, no meta line): the
 * caller composes a row's body from its own leading slot + `children`. First consumer is the
 * approvals queue; the Tasks and Members lists are meant to adopt the same primitive next (see the
 * dispatch this shipped under), so nothing here should grow an approvals-specific prop.
 */
export function List({ ariaLabel, children, testId, className }: ListProps) {
  return (
    <ul aria-label={ariaLabel} data-testid={testId} className={cn('flex flex-col', className)}>
      {children}
    </ul>
  );
}

export type ListRowAccent = 'danger' | 'warn';

const ACCENT_BORDER: Readonly<Record<ListRowAccent, string>> = {
  danger: 'border-l-4 border-l-danger',
  warn: 'border-l-4 border-l-warn',
};

export interface ListRowProps {
  readonly children: ReactNode;
  /** A leading chip/icon column, top-aligned against the first line of `children`. */
  readonly leading?: ReactNode;
  readonly selected?: boolean;
  /** Omit for a non-interactive row (rare — every current caller passes this). */
  readonly onSelect?: () => void;
  /** A 4px left accent border — the row's own emphasis colour (approvals: blast radius), never a
   *  fill on the whole row (design system v2: colour is a mark, not a background). */
  readonly accent?: ListRowAccent;
  readonly testId?: string;
  readonly className?: string;
}

/**
 * One row — 10x16 padding (`py-2.5 px-4`), hover `--surface-2`, selected `--accent-soft`,
 * 150ms colour transition; the focus ring comes from the app-wide `:focus-visible` rule
 * (`styles/base.css`, unlayered — it already wins over any Tailwind utility here per the Cascade
 * Layers ordering `styles/tailwind.css` documents), so this file adds none of its own.
 */
export function ListRow({
  children,
  leading,
  selected = false,
  onSelect,
  accent,
  testId,
  className,
}: ListRowProps) {
  const interactive = onSelect !== undefined;
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        disabled={!interactive}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        data-testid={testId}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors duration-150',
          accent !== undefined ? ACCENT_BORDER[accent] : 'border-l-4 border-l-transparent',
          interactive ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default',
          selected && 'bg-accent-soft',
          className,
        )}
      >
        {leading !== undefined ? <span className="mt-0.5 shrink-0">{leading}</span> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-1 text-text">{children}</span>
      </button>
    </li>
  );
}
