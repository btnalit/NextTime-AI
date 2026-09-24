// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from './data-table.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Row {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly note: string;
}

const ROWS: readonly Row[] = [
  { id: 'a', name: 'Zebra', status: 'active', note: 'z-note' },
  { id: 'b', name: 'Apple', status: 'disabled', note: 'a-note' },
];

const COLUMNS: readonly DataTableColumn<Row>[] = [
  {
    id: 'name',
    header: '名称',
    cell: (row) => row.name,
    priority: 'primary',
    sortable: true,
    sortValue: (row) => row.name,
  },
  { id: 'status', header: '状态', cell: (row) => row.status, priority: 'high' },
  { id: 'note', header: '备注', cell: (row) => row.note },
];

/** A minimal `matchMedia` mock fixed at one match state — `data-table.tsx` only reads `.matches`
 *  and subscribes via `addEventListener`, both of which this satisfies. */
function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('kit/DataTable', () => {
  it('renders a real table with column headers and rows at wide widths', () => {
    mockMatchMedia(false);
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        ariaLabel="Test rows"
        testId="test-table"
      />,
    );
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((el) => el.textContent)).toEqual([
      '名称',
      '状态',
      '备注',
    ]);
    const rows = screen.getAllByRole('row');
    // header row + 2 data rows
    expect(rows).toHaveLength(3);
  });

  it('renders a card list with list semantics at narrow widths', () => {
    mockMatchMedia(true);
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        ariaLabel="Test rows"
        testId="test-table"
      />,
    );
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByRole('list', { name: 'Test rows' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
  });

  it('shows primary/high columns in the card header and low columns as label/value pairs', () => {
    mockMatchMedia(true);
    render(
      <DataTable columns={COLUMNS} data={ROWS} getRowId={(row) => row.id} ariaLabel="Test rows" />,
    );
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    const first = items[0];
    expect(first).toBeDefined();
    expect(first?.textContent).toContain('Zebra');
    expect(first?.textContent).toContain('active');
    expect(first?.textContent).toContain('备注');
    expect(first?.textContent).toContain('z-note');
  });

  it('sorts by a sortable column when its header is clicked', () => {
    mockMatchMedia(false);
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        ariaLabel="Test rows"
        testId="test-table"
      />,
    );
    // Default order is insertion order (Zebra, Apple) until sorted.
    let cells = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    expect(cells[0]).toContain('Zebra');

    fireEvent.click(screen.getByRole('button', { name: /名称/ }));
    cells = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    expect(cells[0]).toContain('Apple');

    fireEvent.click(screen.getByRole('button', { name: /名称/ }));
    cells = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    expect(cells[0]).toContain('Zebra');
  });

  it('does not sort a column with no sortValue', () => {
    mockMatchMedia(false);
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        ariaLabel="Test rows"
        testId="test-table"
      />,
    );
    expect(screen.queryByRole('button', { name: /备注/ })).toBeNull();
  });

  it('calls onRowClick with the row, but not when a nested button is clicked', () => {
    mockMatchMedia(false);
    const onRowClick = vi.fn();
    const columnsWithAction: readonly DataTableColumn<Row>[] = [
      ...COLUMNS,
      {
        id: 'action',
        header: '',
        priority: 'high',
        cell: () => <button type="button">操作</button>,
      },
    ];
    render(
      <DataTable
        columns={columnsWithAction}
        data={ROWS}
        getRowId={(row) => row.id}
        ariaLabel="Test rows"
        onRowClick={onRowClick}
        rowTestId={(row) => `row-${row.id}`}
      />,
    );
    const rowA = screen.getByTestId('row-a');
    fireEvent.click(within(rowA).getByRole('button', { name: '操作' }));
    expect(onRowClick).not.toHaveBeenCalled();

    fireEvent.click(rowA);
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it('renders an empty table body for an empty data array without throwing', () => {
    mockMatchMedia(false);
    render(
      <DataTable columns={COLUMNS} data={[]} getRowId={(row) => row.id} ariaLabel="Test rows" />,
    );
    expect(screen.getAllByRole('row')).toHaveLength(1); // header row only
  });
});
