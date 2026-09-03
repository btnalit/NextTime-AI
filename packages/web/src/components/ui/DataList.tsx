import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

export interface DataListProps {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly testId?: string;
}

/**
 * components/ui/DataList: a bordered list of `DataRow`s. Arrow keys move focus between rows;
 * Enter/Space activate the focused row (`DataRow.onSelect`). Rows stay plain `<li>`s so trailing
 * actions inside them remain real buttons.
 */
export function DataList({ ariaLabel, children, testId }: DataListProps) {
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.data-row'));
    const index = rows.findIndex((row) => row === document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next = rows[event.key === 'ArrowDown' ? index + 1 : index - 1];
    next?.focus();
  }

  return (
    <ul className="data-list" aria-label={ariaLabel} onKeyDown={onKeyDown} data-testid={testId}>
      {children}
    </ul>
  );
}

export interface DataRowProps {
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly trailing?: ReactNode;
  /** Makes the row focusable and clickable. */
  readonly onSelect?: () => void;
  readonly selected?: boolean;
  readonly testId?: string;
  readonly className?: string;
}

export function DataRow({
  leading,
  title,
  meta,
  trailing,
  onSelect,
  selected = false,
  testId,
  className,
}: DataRowProps) {
  const interactive = onSelect !== undefined;

  function onClick(event: MouseEvent<HTMLLIElement>): void {
    // A click on a trailing action (a real button) must not also open the row.
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    onSelect?.();
  }

  function onKeyDown(event: KeyboardEvent<HTMLLIElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.();
    }
  }

  return (
    <li
      className={`data-row${interactive ? ' data-row-interactive' : ''}${className ? ` ${className}` : ''}`}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
      aria-current={selected ? 'true' : undefined}
      data-testid={testId}
    >
      {leading !== undefined ? <div className="data-row-leading">{leading}</div> : null}
      <div className="data-row-main">
        <div className="data-row-title">{title}</div>
        {meta !== undefined ? <div className="data-row-meta">{meta}</div> : null}
      </div>
      {trailing !== undefined ? <div className="data-row-trailing">{trailing}</div> : null}
    </li>
  );
}
