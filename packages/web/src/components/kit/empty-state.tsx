import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export interface EmptyStateProps {
  /** A rendered icon (e.g. `<Icon name="..." size="l" />` from `components/ui/Icon`, or any inline
   *  SVG) — kit primitives may not import the legacy `components/ui/*` icon set directly
   *  (`scripts/guards/legacy-ui-importers.json` only shrinks), so this takes an already-rendered
   *  node instead of an `IconName`. */
  readonly icon?: ReactNode;
  /** Must name the object that is missing — "还没有 Skill", never a bare "还没有" (V9's fix for the
   *  catalog empty state that dropped the noun entirely and read as "there isn't ... anything"). */
  readonly title: string;
  /** One line: what "nothing here" means, and — when useful — what produces an item. */
  readonly body?: ReactNode;
  /** The one action the reader can take, when there is one. */
  readonly action?: ReactNode;
  /** `block` (default): centred, for a page or section's own empty state. `inline`: a single row
   *  — a table's empty body, a compact panel, anywhere a full block would overwhelm the layout. */
  readonly variant?: 'block' | 'inline';
  readonly testId?: string;
  readonly className?: string;
}

/**
 * components/kit/empty-state (console redesign P3-1, V9 "空态"): replaces the legacy
 * `components/ui/EmptyState`'s dashed-border card (`styles/ui.css` `.empty-state`, `border: 1px
 * dashed`) — the design artboards' own rule ("空态、加载、错误三态每张表都必须有") calls for a solid
 * or borderless treatment, never a dashed placeholder box. This version carries no border at all;
 * a subtle `surface-2` fill groups it instead. Two sizes rather than one: `block` for a page/section
 * that has nothing at all, `inline` for a single row inside something else that is otherwise
 * populated (a table, a drawer section).
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  variant = 'block',
  testId,
  className,
}: EmptyStateProps) {
  if (variant === 'inline') {
    return (
      <div
        className={cn(
          'flex items-center gap-3 rounded-m bg-surface-2 px-3 py-2.5 text-text-2',
          className,
        )}
        data-testid={testId}
        data-state="empty"
      >
        {icon !== undefined ? <span className="shrink-0 text-text-3">{icon}</span> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="m-0 truncate text-13 font-semibold text-text">{title}</p>
          {body !== undefined ? <p className="m-0 text-12 text-text-3">{body}</p> : null}
        </div>
        {action !== undefined ? <div className="shrink-0">{action}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-l bg-surface-2 px-4 py-6 text-center text-text-2',
        className,
      )}
      data-testid={testId}
      data-state="empty"
    >
      {icon !== undefined ? <span className="mb-1 text-text-3">{icon}</span> : null}
      <p className="m-0 text-14 font-semibold text-text">{title}</p>
      {body !== undefined ? <p className="m-0 max-w-96 text-13 text-text-3">{body}</p> : null}
      {action !== undefined ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
