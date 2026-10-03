// @vitest-environment jsdom
import type { ExplainResultWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/http-client.js';
import { ConflictsPanel } from './ConflictsPanel.js';
import { GraphObjectsProvider } from './GraphObjectsContext.js';
import { CONFLICT, EXPLAIN_F1, type ScriptedHttp, iso, scriptedHttp } from './test-fixtures.js';

afterEach(() => cleanup());

/** The two sides of `CONFLICT` (f-2 vs f-9): same relation and Objects, different `port`, each
 *  from its own Source. */
function side(
  factId: string,
  port: number,
  uri: string,
  extra: Record<string, unknown> = {},
): ExplainResultWire {
  const fact = EXPLAIN_F1.fact;
  if (!fact) throw new Error('EXPLAIN_F1 is a Fact');
  return {
    ...EXPLAIN_F1,
    fact: {
      ...fact,
      id: factId,
      sourceObjectId: 'c-1',
      targetObjectId: 'h-1',
      properties: { port, protocol: 'tcp', ...extra },
      lastObservation: {
        id: `obs-${factId}`,
        createdAt: iso(-60_000),
        source: {
          id: `src-${factId}`,
          kind: 'collector',
          uri,
          visibility: 'workspace',
          ownerPrincipal: null,
        },
      },
    },
  };
}

const SIDES: Record<string, ExplainResultWire> = {
  'f-2': side('f-2', 80, 'collector://inventory-a'),
  'f-9': side('f-9', 81, 'collector://inventory-b'),
};

function conflictHttp(overrides: Parameters<typeof scriptedHttp>[0] = {}): ScriptedHttp {
  return scriptedHttp({
    explain: (params) => {
      const { nodeId } = params as { nodeId: string };
      const result = SIDES[nodeId];
      if (!result) throw new Error(`unscripted explain ${nodeId}`);
      return result;
    },
    resolve_conflict: () => ({ ...CONFLICT, status: 'resolved' }),
    ...overrides,
  });
}

function renderPanel(http: ScriptedHttp, onResolved = vi.fn()) {
  render(
    <GraphObjectsProvider http={http} identityKeys={new Map([['Host', ['hostname']]])}>
      <ConflictsPanel http={http} conflicts={[CONFLICT]} loading={false} onResolved={onResolved} />
    </GraphObjectsProvider>,
  );
  return onResolved;
}

describe('ConflictsPanel — R-47: the two Facts are on screen before a side is chosen', () => {
  it('reads nothing until a row is opened, then shows both Facts: relation, Objects (linked), value with the disagreement marked, Source, provenance link', async () => {
    const http = conflictHttp();
    renderPanel(http);
    expect(http.callsTo('explain')).toEqual([]);
    // No resolve control until the comparison is open.
    expect(screen.queryByTestId('graph-conflict-resolve')).toBeNull();

    fireEvent.click(screen.getByTestId('graph-conflict-review'));
    const sides = await screen.findAllByTestId('graph-conflict-side');
    expect(sides.map((el) => el.getAttribute('data-side'))).toEqual(['A', 'B']);
    expect(http.callsTo('explain')).toEqual(
      expect.arrayContaining([{ nodeId: 'f-2' }, { nodeId: 'f-9' }]),
    );

    const [a, b] = sides as [HTMLElement, HTMLElement];
    expect(a.textContent).toContain('runs_on');
    // Each side links to its Objects' own view (the object view of the graph page).
    // (Once the two Objects' names have resolved — a bare-id chip carries no link.)
    await waitFor(() => {
      const hrefs = within(a)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href'));
      expect(hrefs).toEqual(
        expect.arrayContaining(['#/work/graph?objectId=c-1', '#/work/graph?objectId=h-1']),
      );
    });
    expect(a.textContent).toContain('node-a');

    // Values side by side: `port` differs and is marked, `protocol` agrees and is not.
    const differing = a.querySelectorAll('[data-differs="true"]');
    expect([...differing].map((row) => row.textContent)).toEqual(['port80']);
    expect(within(b).getByTestId('graph-conflict-side-values').textContent).toContain('81');

    // Where each came from.
    expect(within(a).getByTestId('graph-conflict-side-source').textContent).toContain(
      'collector://inventory-a',
    );
    expect(within(b).getByTestId('graph-conflict-side-source').textContent).toContain(
      'collector://inventory-b',
    );
    // And a way into each Fact's full provenance.
    expect(within(b).getByTestId('graph-conflict-side-provenance').getAttribute('href')).toContain(
      'nodeId=f-9',
    );
  });

  it('a key only one side has is shown as missing on the other and marked', async () => {
    const http = conflictHttp({
      explain: (params) => {
        const { nodeId } = params as { nodeId: string };
        return nodeId === 'f-2'
          ? side('f-2', 80, 'collector://inventory-a', { tls: true })
          : side('f-9', 80, 'collector://inventory-b');
      },
    });
    renderPanel(http);
    fireEvent.click(screen.getByTestId('graph-conflict-review'));
    const [, b] = (await screen.findAllByTestId('graph-conflict-side')) as [
      HTMLElement,
      HTMLElement,
    ];
    const differing = b.querySelectorAll('[data-differs="true"]');
    expect([...differing].map((row) => row.textContent)).toEqual(['tls—']);
  });

  it('resolves from under the comparison with the chosen side and a reason, then reloads', async () => {
    const http = conflictHttp();
    const onResolved = renderPanel(http);
    fireEvent.click(screen.getByTestId('graph-conflict-review'));
    await screen.findAllByTestId('graph-conflict-side');

    fireEvent.click(screen.getByTestId('graph-conflict-resolve'));
    const confirm = await screen.findByTestId('graph-conflict-resolve-confirm');
    fireEvent.change(within(confirm).getByRole('combobox'), { target: { value: 'keep_b' } });
    fireEvent.change(within(confirm).getByTestId('graph-conflict-reason'), {
      target: { value: 'inventory-b is the live collector' },
    });
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(http.callsTo('resolve_conflict')).toEqual([
      {
        conflictId: CONFLICT.id,
        resolution: 'keep_b',
        reason: 'inventory-b is the live collector',
      },
    ]);
  });

  it('a side that cannot be read shows the error with a retry, and no resolve control', async () => {
    let failing = true;
    const http = conflictHttp({
      explain: (params) => {
        const { nodeId } = params as { nodeId: string };
        if (nodeId === 'f-9' && failing) {
          throw new HttpError('capability_error', 'no such node', 'not_found');
        }
        return SIDES[nodeId];
      },
    });
    renderPanel(http);
    fireEvent.click(screen.getByTestId('graph-conflict-review'));
    const banner = await screen.findByTestId('graph-conflict-compare-error');
    expect(screen.queryByTestId('graph-conflict-side')).toBeNull();
    expect(screen.queryByTestId('graph-conflict-resolve')).toBeNull();

    failing = false;
    fireEvent.click(within(banner).getByRole('button'));
    expect(await screen.findAllByTestId('graph-conflict-side')).toHaveLength(2);
  });
});
