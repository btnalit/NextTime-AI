// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { HttpError } from '../../lib/http-client.js';
import { GraphPage } from './GraphPage.js';
import { HOST, WEB, scriptedHttp } from './test-fixtures.js';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

beforeEach(() => {
  window.location.hash = '#/work/graph';
});

function renderPage(http = scriptedHttp()) {
  const view = render(
    <PermissionsProvider>
      <GraphPage http={http} />
    </PermissionsProvider>,
  );
  return { http, ...view };
}

async function openHost(http = scriptedHttp()) {
  window.location.hash = '#/work/graph?type=Host';
  const view = renderPage(http);
  const rows = await screen.findAllByTestId('graph-result-row');
  expect(rows).toHaveLength(1);
  fireEvent.click(rows[0] as HTMLElement);
  await screen.findByTestId('graph-object-card');
  return view;
}

describe('GraphPage', () => {
  it('lands on the recently-updated browse list, with the object pane empty and a legend', async () => {
    const { http } = renderPage();
    expect(screen.getByTestId('graph-results-loading')).toBeTruthy();
    const rows = await screen.findAllByTestId('graph-result-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('最近更新')).toBeTruthy();
    expect(screen.getByTestId('graph-no-object')).toBeTruthy();
    // S8 W4 (audit G3, i18n correctness fix): `formatWindow` now returns one language via `t()`
    // (default zh-CN here) instead of always gluing both together.
    expect(screen.getByTestId('graph-legend').textContent).toContain('2 小时');
    // Names come from the identity key (Host: hostname) and never a bare uuid.
    expect(within(rows[0] as HTMLElement).getByText('node-a')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('web')).toBeTruthy();
    // The first search is the bare browse: empty query, no type, a bounded page.
    expect(http.callsTo('search')[0]).toEqual({ query: '', limit: 25 });
    // The type filter is populated from list_types (object kinds only, sorted).
    const select = screen.getByTestId('graph-type-select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['', 'Container', 'Host']);
  });

  it('follows nextCursor with 加载更多', async () => {
    const { http } = renderPage();
    await screen.findAllByTestId('graph-result-row');
    fireEvent.click(screen.getByTestId('graph-load-more'));
    await waitFor(() => expect(screen.getAllByTestId('graph-result-row')).toHaveLength(3));
    expect(http.callsTo('search')[1]).toEqual({ query: '', limit: 25, cursor: 'page-2' });
    expect(screen.queryByTestId('graph-load-more')).toBeNull();
  });

  it('submits the type + query into the hash and re-searches', async () => {
    const { http } = renderPage();
    await screen.findAllByTestId('graph-result-row');
    fireEvent.change(screen.getByTestId('graph-type-select'), { target: { value: 'Host' } });
    fireEvent.change(screen.getByTestId('graph-q'), { target: { value: 'linux' } });
    fireEvent.submit(screen.getByTestId('graph-search-form'));
    await waitFor(() =>
      expect(http.callsTo('search').at(-1)).toEqual({
        query: 'linux',
        objectType: 'Host',
        limit: 25,
      }),
    );
    expect(window.location.hash).toBe('#/work/graph?q=linux&type=Host');
    expect(screen.getByText('结果')).toBeTruthy();
    expect(await screen.findAllByTestId('graph-result-row')).toHaveLength(1);
  });

  it('shows the empty and error states of the result list', async () => {
    const { http } = renderPage(
      scriptedHttp({
        search: () => {
          throw new HttpError('capability_error', 'boom', 'internal_error');
        },
      }),
    );
    const banner = await screen.findByTestId('graph-results-error');
    expect(banner.getAttribute('data-error-code')).toBe('internal_error');
    cleanup();
    void http;
    window.location.hash = '#/work/graph?q=nothing-matches';
    renderPage();
    expect(await screen.findByTestId('graph-results-empty')).toBeTruthy();
  });

  it('opens an Object: header card, grouped Facts, freshness and conflict marks, resolved neighbour names', async () => {
    const { http } = await openHost();
    expect(window.location.hash).toBe('#/work/graph?objectId=h-1&type=Host');
    // One state_at with the frozen instant — never a per-render clock.
    const stateAtCalls = http.callsTo('state_at') as { objectId: string; at: string }[];
    expect(stateAtCalls).toHaveLength(1);
    expect(stateAtCalls[0]?.objectId).toBe('h-1');
    expect(Number.isNaN(Date.parse(stateAtCalls[0]?.at ?? ''))).toBe(false);

    const card = screen.getByTestId('graph-object-card');
    expect(card.querySelector('.graph-object-title')?.textContent).toBe('node-a');
    expect(screen.getByTestId('graph-object-freshness').getAttribute('data-freshness')).toBe(
      'fresh',
    );
    // Properties are behind a disclosure and redacted.
    const properties = screen.getByTestId('graph-object-properties');
    expect(properties.textContent).toContain('[redacted]');
    expect(properties.textContent).not.toContain('secret-value');

    expect(screen.getByTestId('graph-fact-count').textContent).toBe('(3)');
    const groups = screen.getAllByTestId('graph-group');
    expect(groups.map((group) => group.getAttribute('data-link-type'))).toEqual([
      'depends_on',
      'runs_on',
    ]);
    expect(groups.map((group) => group.getAttribute('data-direction'))).toEqual(['out', 'in']);

    const rows = screen.getAllByTestId('graph-fact-row');
    const byId = new Map(rows.map((row) => [row.getAttribute('data-fact-id'), row]));
    expect(byId.get('f-1')?.getAttribute('data-freshness')).toBe('fresh');
    expect(byId.get('f-2')?.getAttribute('data-freshness')).toBe('conflict');
    // S8 W1-A10: bilingual via t() now; default zh-CN renders '冲突'.
    expect(
      within(byId.get('f-2') as HTMLElement).getByTestId('graph-fact-conflict').textContent,
    ).toBe('冲突 ×1');
    expect(byId.get('f-3')?.getAttribute('data-freshness')).toBe('unobserved');
    expect(within(byId.get('f-3') as HTMLElement).getByText('asserted')).toBeTruthy();
    expect(within(byId.get('f-1') as HTMLElement).getByText('置信 0.95')).toBeTruthy();

    // Neighbour names: the Containers were not in the Host-only search, so they resolve through
    // get_object (deduplicated: c-1 appears in two Facts but is fetched once).
    await waitFor(() => {
      const neighbour = within(byId.get('f-1') as HTMLElement).getByTestId('graph-fact-neighbour');
      expect(neighbour.textContent).toContain('web');
    });
    const resolved = (http.callsTo('get_object') as { objectId: string }[]).map((p) => p.objectId);
    expect(resolved.filter((id) => id === 'c-1')).toHaveLength(1);
    expect(resolved).toContain('c-2');
    // The picture lists the two distinct neighbours as focusable nodes.
    expect(screen.getAllByTestId('graph-node')).toHaveLength(2);
  });

  it('expands a neighbour (trail grows), goes back (cache hit), and opens the provenance drawer', async () => {
    const { http } = await openHost();
    const rows = screen.getAllByTestId('graph-fact-row');
    const f1 = rows.find((row) => row.getAttribute('data-fact-id') === 'f-1') as HTMLElement;
    fireEvent.click(within(f1).getByTestId('graph-fact-expand'));
    await waitFor(() => expect(window.location.hash).toBe('#/work/graph?objectId=c-1&type=Host'));
    await waitFor(() =>
      expect(screen.getByTestId('graph-object-card').getAttribute('data-object-id')).toBe('c-1'),
    );
    expect(screen.getByTestId('graph-trail-current').textContent).toContain('web');
    expect(screen.getAllByTestId('graph-trail-link')).toHaveLength(1);
    expect(screen.getByTestId('graph-fact-count').textContent).toBe('(2)');
    // Both state_at calls used the same frozen instant.
    const stateAtCalls = http.callsTo('state_at') as { objectId: string; at: string }[];
    expect(new Set(stateAtCalls.map((call) => call.at)).size).toBe(1);

    fireEvent.click(screen.getByTestId('graph-back'));
    await waitFor(() =>
      expect(screen.getByTestId('graph-object-card').getAttribute('data-object-id')).toBe('h-1'),
    );
    expect(screen.queryAllByTestId('graph-trail-link')).toHaveLength(0);
    // Back renders from the useCapability cache at once (the card is already there) and then
    // revalidates in the background — a third state_at, still at the same frozen instant.
    const afterBack = http.callsTo('state_at') as { objectId: string; at: string }[];
    expect(afterBack).toHaveLength(3);
    expect(afterBack[2]?.objectId).toBe('h-1');
    expect(new Set(afterBack.map((call) => call.at)).size).toBe(1);

    const rowsAgain = screen.getAllByTestId('graph-fact-row');
    const f1Again = rowsAgain.find(
      (row) => row.getAttribute('data-fact-id') === 'f-1',
    ) as HTMLElement;
    fireEvent.click(within(f1Again).getByTestId('graph-fact-provenance'));
    const drawer = await screen.findByTestId('graph-provenance-drawer');
    expect(http.callsTo('explain')).toEqual([{ nodeId: 'f-1' }]);
    await within(drawer).findByTestId('graph-provenance-chain');
    expect(within(drawer).getByTestId('prov-fact').getAttribute('data-present')).toBe('true');
    expect(within(drawer).getByTestId('prov-activity').textContent).toContain('collector_run');
    expect(within(drawer).getByTestId('prov-source').textContent).toContain(
      'collector://host-inventory',
    );
    expect(
      within(drawer).getByTestId('graph-provenance-freshness').getAttribute('data-freshness'),
    ).toBe('fresh');
    expect(screen.getByTestId('graph-open-in-audit').getAttribute('href')).toBe(
      '#/govern/audit?nodeId=f-1',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('graph-provenance-drawer')).toBeNull());
  });

  it('has a keyboard path for every row action: Enter on a result row, Enter on a picture node', async () => {
    window.location.hash = '#/work/graph?type=Host';
    renderPage();
    const [row] = await screen.findAllByTestId('graph-result-row');
    (row as HTMLElement).focus();
    fireEvent.keyDown(row as HTMLElement, { key: 'Enter' });
    await screen.findByTestId('graph-object-card');
    const nodes = screen.getAllByTestId('graph-node');
    const webNode = nodes.find((node) => node.getAttribute('data-object-id') === 'c-1') as Element;
    expect(webNode.getAttribute('tabindex')).toBe('0');
    expect(webNode.getAttribute('role')).toBe('button');
    fireEvent.keyDown(webNode, { key: ' ' });
    await waitFor(() =>
      expect(screen.getByTestId('graph-object-card').getAttribute('data-object-id')).toBe('c-1'),
    );
    // The row actions are real buttons.
    for (const button of screen.getAllByTestId('graph-fact-provenance')) {
      expect(button.tagName).toBe('BUTTON');
    }
  });

  it('time-travels with 截至', async () => {
    const { http } = await openHost();
    fireEvent.change(screen.getByTestId('graph-as-of-input'), {
      target: { value: '2026-01-02T03:04' },
    });
    fireEvent.submit(screen.getByTestId('graph-as-of-form'));
    await screen.findByTestId('graph-as-of-notice');
    const expectedAt = new Date('2026-01-02T03:04').toISOString();
    await waitFor(() =>
      expect(http.callsTo('state_at').at(-1)).toEqual({ objectId: 'h-1', at: expectedAt }),
    );
    expect(window.location.hash).toContain(`at=${encodeURIComponent(expectedAt)}`);
    fireEvent.click(screen.getByTestId('graph-as-of-now'));
    await waitFor(() => expect(screen.queryByTestId('graph-as-of-notice')).toBeNull());
    expect(window.location.hash).toBe('#/work/graph?objectId=h-1&type=Host');
  });

  it('renders the missing-object and error states of the object pane', async () => {
    window.location.hash = '#/work/graph?objectId=nope';
    renderPage();
    expect(await screen.findByTestId('graph-object-missing')).toBeTruthy();
    cleanup();
    window.location.hash = '#/work/graph?objectId=h-1';
    renderPage(
      scriptedHttp({
        state_at: () => {
          throw new HttpError('capability_error', 'no', 'forbidden');
        },
      }),
    );
    const banner = await screen.findByTestId('graph-object-error');
    expect(banner.getAttribute('data-error-code')).toBe('forbidden');
  });

  it('deep-links: ?objectId= opens the Object directly with a one-crumb trail', async () => {
    window.location.hash = `#/work/graph?objectId=${WEB.id}`;
    renderPage();
    const card = await screen.findByTestId('graph-object-card');
    expect(card.getAttribute('data-object-id')).toBe(WEB.id);
    expect(screen.getByTestId('graph-back').textContent).toContain('返回搜索');
    // The Host neighbour (both Facts point at it) resolves by get_object and its chip links to
    // a deep link too.
    await waitFor(() =>
      expect(screen.getAllByTestId('graph-fact-neighbour')[0]?.textContent).toContain('node-a'),
    );
    expect(
      screen.getAllByTestId('graph-fact-neighbour')[0]?.querySelector('a')?.getAttribute('href'),
    ).toBe(`#/work/graph?objectId=${HOST.id}`);
  });
});

describe('GraphPage without list_types / list_conflicts', () => {
  it('degrades the type filter to a text input and shows no conflict marks', async () => {
    window.location.hash = '#/work/graph?objectId=h-1';
    renderPage(
      scriptedHttp({
        list_types: () => {
          throw new HttpError('capability_error', 'no', 'forbidden');
        },
        list_conflicts: () => {
          throw new HttpError('capability_error', 'no', 'forbidden');
        },
      }),
    );
    await screen.findByTestId('graph-object-card');
    expect(screen.getByTestId('graph-type-input')).toBeTruthy();
    expect(screen.queryByTestId('graph-fact-conflict')).toBeNull();
    // Without the ontology's identity keys the name still comes from the stored identity.
    expect(
      screen.getByTestId('graph-object-card').querySelector('.graph-object-title')?.textContent,
    ).toBe('node-a');
    await act(async () => undefined);
  });
});
