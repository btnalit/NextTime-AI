// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import type { CatalogTab } from '../lib/router.js';
import { CatalogPage } from './CatalogPage.js';

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function Harness({
  http,
  initialTab = 'operations',
}: {
  readonly http: CapabilityCaller;
  readonly initialTab?: CatalogTab;
}) {
  const [tab, setTab] = useState(initialTab);
  return <CatalogPage http={http} tab={tab} onTabChange={setTab} />;
}

function renderPage(http: CapabilityCaller, initialTab?: CatalogTab) {
  return render(
    <PermissionsProvider>
      <Harness http={http} initialTab={initialTab} />
    </PermissionsProvider>,
  );
}

describe('CatalogPage', () => {
  it('defaults to the Operations tab and switches on click, loading each tab’s own capability', async () => {
    const http = scriptedHttp({
      list_operations: () => ({ items: [] }),
      get_operation_stats: () => ({ items: [] }),
      list_skills: () => ({ items: [] }),
    });
    renderPage(http);
    await waitFor(() => expect(http.calls.some((c) => c.name === 'list_operations')).toBe(true));
    expect(screen.getByRole('tab', { name: 'Operations' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'list_skills')).toBe(true));
    expect(screen.getByRole('tab', { name: 'Skills' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows "该能力尚未上线" for a tab whose capability is not deployed yet (404 not_found)', async () => {
    const http = scriptedHttp({
      list_operations: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    });
    renderPage(http);
    await screen.findByTestId('catalog-unavailable');
  });

  it('Operations: Publish and Deprecate call the right capability and refresh the list', async () => {
    let callCount = 0;
    const http = scriptedHttp({
      list_operations: () => {
        callCount += 1;
        return {
          items:
            callCount === 1
              ? [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'draft' }]
              : [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published' }],
        };
      },
      get_operation_stats: () => ({ items: [] }),
      publish_operation: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1', name: 'docker.restart' });
        return {};
      },
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    fireEvent.click(within(row).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(true));
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'list_operations')).toHaveLength(2),
    );
  });

  it('Operations: renders usage counters from get_operation_stats, degrading to "—" for a row with no matching stats', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published' },
          { gatekeeperId: 'gk-1', name: 'docker.no_stats', status: 'published' },
        ],
      }),
      get_operation_stats: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            operationName: 'docker.restart',
            calls: 12,
            approved: 3,
            rejected: 1,
            autoApproved: 8,
            failed: 0,
            lastCalledAt: new Date().toISOString(),
          },
        ],
      }),
    });
    renderPage(http);
    const rows = await screen.findAllByTestId('catalog-row');
    expect(rows).toHaveLength(2);
    const usageSpans = rows.map((row) => within(row).getByTestId('catalog-row-usage').textContent);
    expect(usageSpans.some((text) => text?.includes('12') && text?.includes('3'))).toBe(true);
    expect(usageSpans).toContain('—');
  });

  it('Operations: a get_operation_stats failure degrades the usage column to "—" without blocking the list', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published' }],
      }),
      get_operation_stats: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    expect(within(row).getByTestId('catalog-row-usage').textContent).toBe('—');
  });

  it('Workers tab: only offers Deprecate (list_worker_definitions never returns drafts)', async () => {
    const http = scriptedHttp({
      list_worker_definitions: () => ({
        items: [
          {
            id: 'wd-1',
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Fixer' },
          },
        ],
      }),
    });
    renderPage(http, 'workers');
    const row = await screen.findByTestId('catalog-row');
    expect(within(row).queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Deprecate' })).toBeTruthy();
  });
});
