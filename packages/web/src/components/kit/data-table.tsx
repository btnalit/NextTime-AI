import {
  type ColumnDef,
  type SortingState,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useMemo,
  useState,
} from 'react';
import { NARROW_TABLE_QUERY, useMediaQuery } from '../../hooks/useMediaQuery.js';
import { cn } from '../../lib/cn.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table.js';

export type DataTableColumnPriority = 'primary' | 'high' | 'low';

export interface DataTableColumn<T> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: T) => ReactNode;
  /**
   * `'primary'` — the row's name/title. Always visible: the card title, and (in `layout="sticky"`)
   * the first pinned column. At most one column should use this.
   *
   * `'high'` — status and the row's primary action belong here. Always visible next to the title
   * in card mode, and pinned alongside `primary` in `layout="sticky"`. A page typically marks its
   * status column and its one always-visible action column `'high'`.
   *
   * `'low'` (default) — everything else: a label/value pair under the card title in card mode,
   * part of the horizontally-scrolling region in `layout="sticky"` mode, an ordinary column at
   * wide widths either way.
   */
  readonly priority?: DataTableColumnPriority;
  /** Enables the TanStack sort-state/comparator machinery for this column — requires `sortValue`
   *  (silently not sortable without one, since there is nothing to compare on). */
  readonly sortable?: boolean;
  readonly sortValue?: (row: T) => string | number | null | undefined;
  /** Card mode only: omit this column's label/value pair — its content already shows through a
   *  `primary`/`high` column, or is redundant there (e.g. an "Actions" header with no label worth
   *  repeating). */
  readonly hideInCard?: boolean;
  readonly headerClassName?: string;
  readonly cellClassName?: string;
  /** `layout="sticky"` only: the pinned column's fixed width in px, used both for its `min-width`
   *  and for stacking the next pinned column's `left` offset. Defaults to 200 for `'primary'`, 140
   *  for `'high'`. Ignored for `'low'` columns (never pinned) and in `layout="card"`. */
  readonly width?: number;
}

export interface DataTableProps<T> {
  readonly columns: readonly DataTableColumn<T>[];
  readonly data: readonly T[];
  readonly getRowId: (row: T) => string;
  /** Accessible name for the table / card list (`aria-label`). */
  readonly ariaLabel: string;
  /**
   * `'card'` (default) — at `NARROW_TABLE_QUERY` (≤ 768px) rows become cards (list semantics:
   * `<ul>`/`<li>`, primary+high columns in the header, the rest as label/value pairs); above that,
   * a real `<table>` with a sticky header.
   *
   * `'sticky'` — for a table with too many columns to ever fit one screen (e.g. Providers, audit
   * S3: overflows even at 1440). Always a real `<table>`: the `primary`/`high` columns pin to the
   * left and the rest scrolls horizontally underneath, at every width — never collapses to cards.
   */
  readonly layout?: 'card' | 'sticky';
  readonly onRowClick?: (row: T) => void;
  readonly rowClassName?: (row: T) => string | undefined;
  /** The exact `data-testid` for one row — e.g. `` (row) => `provider-row-${row.id}` `` — kept
   *  stable across the card/table split so existing e2e locators do not change. */
  readonly rowTestId?: (row: T) => string;
  /** Extra `data-*` attributes some e2e locators key off besides `rowTestId` (e.g.
   *  `{ 'data-workspace-id': row.id }`). Applied to both the `<tr>` and the card `<li>`. */
  readonly rowDataAttrs?: (row: T) => Readonly<Record<string, string>>;
  /** `data-testid` for the outer `<table>` (wide/sticky) or `<ul>` (card). */
  readonly testId?: string;
  readonly defaultSort?: { readonly id: string; readonly desc?: boolean };
}

const DEFAULT_PINNED_WIDTH: Readonly<Record<DataTableColumnPriority, number>> = {
  primary: 200,
  high: 140,
  low: 160,
};

function isPinned(priority: DataTableColumnPriority): boolean {
  return priority !== 'low';
}

/** Cumulative `left` px for every pinned (`primary`/`high`) column, in column order. */
function pinnedOffsets<T>(columns: readonly DataTableColumn<T>[]): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>();
  let left = 0;
  for (const col of columns) {
    const priority = col.priority ?? 'low';
    if (!isPinned(priority)) continue;
    offsets.set(col.id, left);
    left += col.width ?? DEFAULT_PINNED_WIDTH[priority];
  }
  return offsets;
}

/** A click on a nested interactive element (a real button/link/input inside the row) must not
 *  also trigger the row's own `onRowClick` — the same guard `ui/DataList`'s `DataRow` uses. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? target.closest('button, a, input, select, textarea') !== null
    : false;
}

/**
 * components/kit/data-table (S8 W1-A4, docs/development-tasks.md §5e decision F3, audit S3): a
 * responsive table on `@tanstack/react-table` (sorting only — headless: this component owns every
 * pixel of markup, not `flexRender`) over the kit `table` shell. At ≤ 768px every row becomes a
 * card (`layout="card"`, the default); a table too dense to ever fit one screen keeps a real
 * `<table>` with its `primary`/`high` columns pinned and the rest scrolling underneath
 * (`layout="sticky"`).
 *
 * Deliberately does *not* render loading/error/empty states — every page already gates on those
 * with `SkeletonRows`/`ErrorBanner`/`EmptyState` before reaching this component (see
 * `PlatformUsersPage` for the established shape); duplicating that here would be a second, looser
 * copy of the same three states. `data` is assumed non-empty and ready.
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  ariaLabel,
  layout = 'card',
  onRowClick,
  rowClassName,
  rowTestId,
  rowDataAttrs,
  testId,
  defaultSort,
}: DataTableProps<T>) {
  const isNarrow = useMediaQuery(NARROW_TABLE_QUERY);
  const asCards = layout === 'card' && isNarrow;

  const [sorting, setSorting] = useState<SortingState>(
    defaultSort ? [{ id: defaultSort.id, desc: defaultSort.desc === true }] : [],
  );

  const tanColumns = useMemo<ColumnDef<T, unknown>[]>(
    () =>
      columns.map((col) =>
        col.sortable === true && col.sortValue
          ? {
              id: col.id,
              accessorFn: (row: T) => col.sortValue?.(row) ?? null,
              enableSorting: true,
            }
          : { id: col.id, enableSorting: false },
      ),
    [columns],
  );

  const table = useReactTable({
    data: data as T[],
    columns: tanColumns,
    getRowId: (row) => getRowId(row),
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Sorted, still the caller's own `T` rows — every column's `cell`/`header` stays a plain
  // function this component calls directly (see the module doc: no `flexRender`).
  const rows = table.getRowModel().rows.map((row) => row.original);

  function rowProps(row: T): {
    readonly onClick?: (event: ReactMouseEvent) => void;
    readonly onKeyDown?: (event: ReactKeyboardEvent) => void;
    readonly tabIndex?: number;
  } {
    if (!onRowClick) return {};
    return {
      tabIndex: 0,
      onClick: (event) => {
        if (isInteractiveTarget(event.target)) return;
        onRowClick(row);
      },
      onKeyDown: (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onRowClick(row);
        }
      },
    };
  }

  /** A column header's content — a plain sort toggle button when the column is sortable, the
   *  header node as-is otherwise. A function, not a component: it is called inline (`{renderHeader
   *  (col)}`), never rendered as a JSX tag, so it never remounts on re-render the way a component
   *  defined inside another component's body would. */
  function renderHeader(col: DataTableColumn<T>): ReactNode {
    if (col.sortable !== true || !col.sortValue) return col.header;
    const sorted = table.getColumn(col.id)?.getIsSorted();
    const handler = table.getColumn(col.id)?.getToggleSortingHandler();
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 text-inherit"
        onClick={handler}
        data-testid={testId ? `${testId}-sort-${col.id}` : undefined}
      >
        {col.header}
        <span aria-hidden="true" className="text-text-3">
          {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : ''}
        </span>
      </button>
    );
  }

  if (asCards) {
    const primary = columns.filter((col) => (col.priority ?? 'low') === 'primary');
    const high = columns.filter((col) => (col.priority ?? 'low') === 'high');
    const low = columns.filter((col) => (col.priority ?? 'low') === 'low' && !col.hideInCard);
    return (
      <ul className="flex flex-col gap-2" aria-label={ariaLabel} data-testid={testId}>
        {rows.map((row) => {
          const id = getRowId(row);
          const props = rowProps(row);
          return (
            <li
              key={id}
              className={cn(
                'rounded-l border border-border bg-surface-1 p-3',
                onRowClick && 'cursor-pointer hover:bg-surface-2',
                rowClassName?.(row),
              )}
              data-testid={rowTestId?.(row)}
              {...rowDataAttrs?.(row)}
              {...props}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1 truncate font-medium text-text">
                  {primary.map((col) => (
                    <span key={col.id} className={col.cellClassName}>
                      {col.cell(row)}
                    </span>
                  ))}
                </div>
                {high.length > 0 ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {high.map((col) => (
                      <span key={col.id} className={col.cellClassName}>
                        {col.cell(row)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {low.length > 0 ? (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-13">
                  {low.map((col) => (
                    <Fragment key={col.id}>
                      <dt className="text-text-3">{col.header}</dt>
                      <dd className="min-w-0 truncate text-text">{col.cell(row)}</dd>
                    </Fragment>
                  ))}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  const sticky = layout === 'sticky';
  const offsets = sticky ? pinnedOffsets(columns) : undefined;

  return (
    <Table aria-label={ariaLabel} data-testid={testId}>
      <TableHeader className="sticky top-0 z-20 bg-surface-1">
        <TableRow>
          {columns.map((col) => {
            const priority = col.priority ?? 'low';
            const pinned = sticky && isPinned(priority);
            const left = pinned ? offsets?.get(col.id) : undefined;
            const width = pinned ? (col.width ?? DEFAULT_PINNED_WIDTH[priority]) : undefined;
            return (
              <TableHead
                key={col.id}
                className={cn(pinned && 'sticky z-30 bg-surface-1', col.headerClassName)}
                style={pinned ? { left, minWidth: width } : undefined}
              >
                {renderHeader(col)}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const id = getRowId(row);
          const props = rowProps(row);
          return (
            <TableRow
              key={id}
              className={cn(onRowClick && 'cursor-pointer', rowClassName?.(row))}
              data-testid={rowTestId?.(row)}
              {...rowDataAttrs?.(row)}
              {...props}
            >
              {columns.map((col) => {
                const priority = col.priority ?? 'low';
                const pinned = sticky && isPinned(priority);
                const left = pinned ? offsets?.get(col.id) : undefined;
                const width = pinned ? (col.width ?? DEFAULT_PINNED_WIDTH[priority]) : undefined;
                return (
                  <TableCell
                    key={col.id}
                    className={cn(pinned && 'sticky z-10 bg-surface-1', col.cellClassName)}
                    style={pinned ? { left, minWidth: width } : undefined}
                  >
                    {col.cell(row)}
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
