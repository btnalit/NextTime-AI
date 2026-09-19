// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupFacts } from '../../lib/graph-view.js';
import { GROUP_PREVIEW_ROWS, NeighbourList } from './NeighbourList.js';
import { CONFLICT, FACTS, NOW, fact, iso } from './test-fixtures.js';

afterEach(cleanup);

describe('NeighbourList / FactRow', () => {
  it('renders grouped rows with direction, status, validity and real action buttons', () => {
    const onExpand = vi.fn();
    const onProvenance = vi.fn();
    render(
      <NeighbourList
        groups={groupFacts(FACTS, 'h-1')}
        objectId="h-1"
        asOf={NOW}
        conflicts={new Map([[CONFLICT.factAId, [CONFLICT]]])}
        onExpand={onExpand}
        onProvenance={onProvenance}
      />,
    );
    const rows = screen.getAllByTestId('graph-fact-row');
    expect(rows.map((row) => row.getAttribute('data-fact-id'))).toEqual(['f-3', 'f-1', 'f-2']);
    expect(rows.map((row) => row.getAttribute('data-direction'))).toEqual(['out', 'in', 'in']);
    const f2 = rows[2] as HTMLElement;
    expect(within(f2).getByTestId('graph-fact-conflict')).toBeTruthy();
    expect(f2.getAttribute('data-freshness')).toBe('conflict');
    // Without a page-level Object cache the neighbour chip is the bare-id fallback, never empty.
    expect(within(f2).getByTestId('graph-fact-neighbour').className).toContain('ref-chip-bare');

    fireEvent.click(within(f2).getByTestId('graph-fact-expand'));
    expect(onExpand).toHaveBeenCalledWith('c-2');
    fireEvent.click(within(f2).getByTestId('graph-fact-provenance'));
    expect(onProvenance).toHaveBeenCalledWith(FACTS[1]);
  });

  it('cuts a long group at the preview size and expands on 显示全部', () => {
    const many = Array.from({ length: GROUP_PREVIEW_ROWS + 3 }, (_, index) =>
      fact({ id: `f-${index}`, sourceObjectId: `c-${index}`, lastObservedAt: iso(-1000) }),
    );
    render(
      <NeighbourList
        groups={groupFacts(many, 'h-1')}
        objectId="h-1"
        asOf={NOW}
        conflicts={new Map()}
        onExpand={() => undefined}
        onProvenance={() => undefined}
      />,
    );
    expect(screen.getAllByTestId('graph-fact-row')).toHaveLength(GROUP_PREVIEW_ROWS);
    const more = screen.getByTestId('graph-group-show-all');
    expect(more.textContent).toContain(`(${GROUP_PREVIEW_ROWS + 3})`);
    fireEvent.click(more);
    expect(screen.getAllByTestId('graph-fact-row')).toHaveLength(GROUP_PREVIEW_ROWS + 3);
    expect(screen.queryByTestId('graph-group-show-all')).toBeNull();
  });

  it('shows a self-link without an Expand button', () => {
    const self = fact({ id: 'f-self', sourceObjectId: 'h-1', targetObjectId: 'h-1' });
    render(
      <NeighbourList
        groups={groupFacts([self], 'h-1')}
        objectId="h-1"
        asOf={NOW}
        conflicts={new Map()}
        onExpand={() => undefined}
        onProvenance={() => undefined}
      />,
    );
    const row = screen.getByTestId('graph-fact-row');
    expect(row.getAttribute('data-direction')).toBe('self');
    expect(within(row).queryByTestId('graph-fact-expand')).toBeNull();
    expect(within(row).getByTestId('graph-fact-provenance')).toBeTruthy();
  });
});
