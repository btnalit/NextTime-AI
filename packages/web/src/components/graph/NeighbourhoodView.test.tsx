// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeighbourhoodView, RING_MAX } from './NeighbourhoodView.js';
import { CONFLICT, FACTS, NOW, fact } from './test-fixtures.js';

afterEach(cleanup);

describe('NeighbourhoodView', () => {
  it('draws one focusable node per distinct neighbour, edges coloured by the worst freshness', () => {
    const onFocus = vi.fn();
    render(
      <NeighbourhoodView
        objectId="h-1"
        objectName="node-a"
        facts={FACTS}
        asOf={NOW}
        conflicts={new Map([[CONFLICT.factAId, [CONFLICT]]])}
        onFocus={onFocus}
      />,
    );
    const nodes = screen.getAllByTestId('graph-node');
    // c-1 is joined by two Facts (fresh + unobserved → worst is neutral), c-2 by a conflict.
    expect(nodes.map((node) => node.getAttribute('data-object-id'))).toEqual(['c-1', 'c-2']);
    expect(nodes[0]?.getAttribute('class')).toContain('graph-node-neutral');
    expect(nodes[1]?.getAttribute('class')).toContain('graph-node-danger');
    const edges = document.querySelectorAll('.graph-edge');
    expect(edges).toHaveLength(2);
    expect(edges[0]?.getAttribute('class')).toContain('graph-edge-neutral');
    expect(edges[1]?.getAttribute('class')).toContain('graph-edge-danger');
    // Keyboard path: Enter / Space on a node focuses it; other keys do nothing.
    fireEvent.keyDown(nodes[1] as Element, { key: 'Tab' });
    expect(onFocus).not.toHaveBeenCalled();
    fireEvent.keyDown(nodes[1] as Element, { key: 'Enter' });
    expect(onFocus).toHaveBeenCalledWith('c-2');
    fireEvent.click(nodes[0] as Element);
    expect(onFocus).toHaveBeenCalledWith('c-1');
    expect(screen.getByTestId('graph-node-centre').textContent).toContain('node-a');
  });

  it('caps the ring and counts the overflow in the centre', () => {
    const many = Array.from({ length: RING_MAX + 5 }, (_, index) =>
      fact({ id: `f-${index}`, sourceObjectId: `c-${index}` }),
    );
    render(
      <NeighbourhoodView
        objectId="h-1"
        objectName={undefined}
        facts={many}
        asOf={NOW}
        conflicts={new Map()}
        onFocus={() => undefined}
      />,
    );
    expect(screen.getAllByTestId('graph-node')).toHaveLength(RING_MAX);
    expect(screen.getByTestId('graph-node-centre').textContent).toContain('+5');
  });
});
