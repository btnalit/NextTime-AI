// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import type { CatalogTab } from '../lib/router.js';
import { CatalogPage } from './CatalogPage.js';
import { ToastProvider } from './ui/Toast.js';

afterEach(cleanup);

const EDITOR_SUGGESTION_READS: Record<string, unknown> = {
  list_available_gate_instances: { items: [] },
  list_types: { items: [] },
};

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      // The editors' own suggestion reads (egress hosts, object types) answer empty unless a
      // test scripts them, and stay out of `calls` so the assertions below are about the page.
      if (!handlers[name] && name in EDITOR_SUGGESTION_READS) return EDITOR_SUGGESTION_READS[name];
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
  initialItemId,
}: {
  readonly http: CapabilityCaller;
  readonly initialTab?: CatalogTab;
  readonly initialItemId?: string;
}) {
  const [tab, setTab] = useState(initialTab);
  const [itemId, setItemId] = useState<string | undefined>(initialItemId);
  return (
    <CatalogPage
      http={http}
      tab={tab}
      onTabChange={(next) => {
        setTab(next);
        setItemId(undefined);
      }}
      itemId={itemId}
      onSelectItem={(id) => setItemId(id ?? undefined)}
    />
  );
}

function renderPage(http: CapabilityCaller, initialTab?: CatalogTab, initialItemId?: string) {
  return render(
    <PermissionsProvider>
      <ToastProvider>
        <Harness http={http} initialTab={initialTab} initialItemId={initialItemId} />
      </ToastProvider>
    </PermissionsProvider>,
  );
}

/** console redesign P3-5: every row's own actions (Publish / Deprecate / Edit description / Edit
 *  as new draft / Discard) moved from the row itself into the detail pane — a test drives them by
 *  selecting the row first (a plain click; `kit/list-row` is one `<button>`, no nested control to
 *  dodge) and then finding the action inside `catalog-detail`. */
async function selectRow(row: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(row);
  return screen.findByTestId('catalog-detail');
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
    // S8 W1-A10: the tab label is bilingual now (default zh-CN keeps Operation/Skill/Procedure/
    // Worker as English proper nouns — only Modules has an established zh term, '模块').
    expect(screen.getByRole('tab', { name: 'Operation' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Skill' }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'list_skills')).toBe(true));
    expect(screen.getByRole('tab', { name: 'Skill' }).getAttribute('aria-selected')).toBe('true');
  });

  it('renders a not_found from a tab capability as an ordinary error banner (B6: the "not live yet" branch is gone)', async () => {
    const http = scriptedHttp({
      list_operations: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    });
    renderPage(http);
    await screen.findByTestId('catalog-error');
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
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByRole('button', { name: /发布/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(true));
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'list_operations')).toHaveLength(2),
    );
  });

  it('C14: a failed Publish toasts what happened and what to do, not only the generic title', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'draft' }],
      }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: () =>
        Promise.reject(
          new HttpError('capability_error', 'operation docker.restart is not a draft', 'conflict'),
        ),
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByRole('button', { name: /发布/ }));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toContain('无法更新');
    expect(toast.textContent).toContain('docker.restart');
    // P1-1: the readable next step for the code, the code itself in brackets for a report.
    expect(toast.textContent).toContain('刷新后再试');
    expect(toast.textContent).toContain('(conflict)');
  });

  it('R-19 (D-17): publishing a draft that loosens the published classification asks first, old → new, danger-styled', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'docker.restart',
            status: 'published',
            mode: 'execute',
            blastRadius: 'high',
            autoApprovable: true,
          },
          {
            gatekeeperId: 'gk-1',
            name: 'docker.restart',
            status: 'draft',
            mode: 'execute',
            blastRadius: 'low',
            autoApprovable: true,
            governanceChange: {
              before: { mode: 'execute', blastRadius: 'high', autoApprovable: true },
              after: { mode: 'execute', blastRadius: 'low', autoApprovable: true },
              direction: 'loosened',
            },
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1', name: 'docker.restart' });
        return {};
      },
    });
    renderPage(http);
    const rows = await screen.findAllByTestId('catalog-row');
    expect(rows).toHaveLength(2);
    // The revision draft is selectable on its own (its key differs from the published row's).
    const detail = await selectRow(rows[1] as HTMLElement);
    fireEvent.click(
      within(detail).getByTestId('operation-publish-confirm-gk-1::docker.restart@draft-trigger'),
    );
    const confirm = await screen.findByTestId(
      'operation-publish-confirm-gk-1::docker.restart@draft',
    );
    expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(false);
    expect(confirm.textContent).toContain('docker.restart: 影响级');
    expect(within(confirm).getByTestId('confirm-button').className).toContain('text-danger');
    expect(
      within(confirm).getByTestId('operation-publish-confirm-gk-1::docker.restart@draft-loosens')
        .textContent,
    ).toContain('不再是高影响');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(true));
  });

  it('R-19: a tightening draft still shows old → new before it publishes, without danger styling', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'docker.stop',
            status: 'draft',
            mode: 'execute',
            blastRadius: 'high',
            autoApprovable: false,
            governanceChange: {
              before: { mode: 'execute', blastRadius: 'medium', autoApprovable: false },
              after: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
              direction: 'tightened',
            },
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    fireEvent.click(
      within(detail).getByTestId('operation-publish-confirm-gk-1::docker.stop@draft-trigger'),
    );
    const confirm = await screen.findByTestId('operation-publish-confirm-gk-1::docker.stop@draft');
    expect(within(confirm).getByTestId('confirm-button').className).not.toContain('text-danger');
    expect(
      within(confirm).queryByTestId('operation-publish-confirm-gk-1::docker.stop@draft-loosens'),
    ).toBeNull();
    expect(within(confirm).getByTestId('governance-diff-list-item').dataset.direction).toBe(
      'tightened',
    );
  });

  it('legacy K (UX acceptance of #538): a revision draft shows what it changes against the published version before Publish', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'stock.get',
            status: 'published',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
            version: 1,
          },
          {
            gatekeeperId: 'gk-1',
            name: 'stock.get',
            status: 'draft',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
            version: 2,
            governanceChange: {
              before: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              after: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              direction: 'neutral',
            },
            definitionChange: {
              changedFields: ['binding', 'params_schema'],
              paramsAdded: [{ name: 'warehouse', in: 'query', required: false }],
              paramsRemoved: [{ name: 'unit', required: true }],
              paramsChanged: [{ name: 'sku', in: 'header', required: true }],
            },
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http, 'operations', 'gk-1::stock.get@draft');
    const detail = await screen.findByTestId('catalog-detail');
    const diff = await within(detail).findByTestId('operation-revision-diff');
    expect(diff.textContent).toContain('和已发布版本相比');
    expect(
      within(diff)
        .getAllByTestId('operation-revision-diff-line')
        .map((line) => line.textContent),
    ).toEqual([
      '参数：+warehouse（query，可选）',
      '参数：−unit（必填）',
      '参数：~sku（header，必填）',
      // params_schema is spelled out param by param above; the binding only by name.
      '调用目标变了',
    ]);
    // The published row has no diff of its own.
    const rows = screen.getAllByTestId('catalog-row');
    await selectRow(rows[0] as HTMLElement);
    expect(screen.queryByTestId('operation-revision-diff')).toBeNull();
  });

  it('legacy K: a revision draft whose definition and classification match says so', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'stock.get',
            status: 'draft',
            version: 2,
            governanceChange: {
              before: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              after: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
              direction: 'neutral',
            },
            definitionChange: {
              changedFields: [],
              paramsAdded: [],
              paramsRemoved: [],
              paramsChanged: [],
            },
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http, 'operations', 'gk-1::stock.get@draft');
    const diff = await screen.findByTestId('operation-revision-diff');
    expect(diff.textContent).toContain('和已发布版本没有差异');
  });

  it('legacy K (UX acceptance of #538): publishing a revision draft follows it to the version now in effect and says which version', async () => {
    let published = false;
    const http = scriptedHttp({
      list_operations: () => ({
        items: published
          ? [
              {
                gatekeeperId: 'gk-1',
                name: 'stock.get',
                status: 'published',
                version: 2,
              },
              {
                gatekeeperId: 'gk-1',
                name: 'stock.get',
                status: 'deprecated',
                version: 1,
              },
            ]
          : [
              { gatekeeperId: 'gk-1', name: 'stock.get', status: 'published', version: 1 },
              {
                gatekeeperId: 'gk-1',
                name: 'stock.get',
                status: 'draft',
                version: 2,
                governanceChange: {
                  before: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
                  after: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
                  direction: 'neutral',
                },
              },
            ],
      }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: () => {
        published = true;
        return {};
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderPage(http, 'operations', 'gk-1::stock.get@draft');
      const detail = await screen.findByTestId('catalog-detail');
      fireEvent.click(await within(detail).findByRole('button', { name: /发布/ }));
      const toast = await screen.findByTestId('toast');
      expect(toast.textContent).toMatch(/stock\.get 已发布 v2/);
      // The detail now shows the published version, never 「未找到」.
      await waitFor(() =>
        expect(screen.getByTestId('operation-detail').getAttribute('data-operation-key')).toBe(
          'gk-1::stock.get',
        ),
      );
      expect(screen.getByTestId('operation-detail').textContent).not.toContain('未找到');
      // The retired version and the one in effect are listed with keys of their own.
      await waitFor(() => expect(screen.getAllByTestId('catalog-row')).toHaveLength(2));
      expect(consoleError.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(
        false,
      );
    } finally {
      consoleError.mockRestore();
    }
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
    // console redesign P3-5: usage moved from the row into the detail pane (rows show only name +
    // description now) — select each row in turn and read it there.
    const detail1 = await selectRow(rows[0] as HTMLElement);
    expect(within(detail1).getByTestId('catalog-row-usage').textContent).toContain('12');
    expect(within(detail1).getByTestId('catalog-row-usage').textContent).toContain('3');
    const detail2 = await selectRow(rows[1] as HTMLElement);
    expect(within(detail2).getByTestId('catalog-row-usage').textContent).toBe('—');
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
    const detail = await selectRow(row);
    expect(within(detail).getByTestId('catalog-row-usage').textContent).toBe('—');
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
    const detail = await selectRow(row);
    expect(within(detail).queryByRole('button', { name: /发布/ })).toBeNull();
    expect(within(detail).getByRole('button', { name: /弃用/ })).toBeTruthy();
  });

  // S8 W1-A7 (audit S13): 弃用 Deprecate used to be a plain button with no confirmation at all —
  // now a medium `kit/confirm` anchored to itself; the capability fires only once confirmed.
  it('Operations: Deprecate opens a medium confirm next to the button; deprecate_operation fires only on confirm', async () => {
    let callCount = 0;
    const http = scriptedHttp({
      list_operations: () => {
        callCount += 1;
        return {
          items: [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published' }],
        };
      },
      get_operation_stats: () => ({ items: [] }),
      deprecate_operation: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1', name: 'docker.restart' });
        return {};
      },
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByRole('button', { name: /弃用/ }));

    expect(http.calls.some((c) => c.name === 'deprecate_operation')).toBe(false);
    const confirm = await screen.findByTestId('operation-deprecate-confirm-gk-1::docker.restart');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('docker.restart');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'deprecate_operation')).toBe(true),
    );
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'list_operations')).toHaveLength(2),
    );
  });

  it('Operations: a blank description shows "未填写描述"; a non-blank one is shown verbatim', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published' },
          {
            gatekeeperId: 'gk-1',
            name: 'docker.stop',
            status: 'published',
            description: 'Stops a container.',
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http);
    const rows = await screen.findAllByTestId('catalog-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('catalog-row-description-gk-1::docker.restart').textContent).toBe(
      '未填写描述',
    );
    expect(screen.getByTestId('catalog-row-description-gk-1::docker.stop').textContent).toBe(
      'Stops a container.',
    );
  });

  it('Operations: 编辑描述 opens a dialog prefilled with the current description; saving calls update_operation_description and refreshes the row', async () => {
    let callCount = 0;
    const http = scriptedHttp({
      list_operations: () => {
        callCount += 1;
        return {
          items: [
            {
              gatekeeperId: 'gk-1',
              name: 'docker.restart',
              status: 'published',
              description: callCount === 1 ? 'old description' : 'new description',
            },
          ],
        };
      },
      get_operation_stats: () => ({ items: [] }),
      update_operation_description: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          name: 'docker.restart',
          description: 'new description',
        });
        return { gatekeeperId: 'gk-1', name: 'docker.restart', description: 'new description' };
      },
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByTestId('operation-edit-description-gk-1::docker.restart'));

    const dialog = await screen.findByTestId('operation-description-dialog');
    const textarea = within(dialog).getByTestId(
      'operation-description-textarea',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('old description');

    fireEvent.change(textarea, { target: { value: 'new description' } });
    fireEvent.click(within(dialog).getByTestId('operation-description-save'));

    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'update_operation_description')).toBe(true),
    );
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'list_operations')).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.getByTestId('catalog-row-description-gk-1::docker.restart').textContent).toBe(
        'new description',
      ),
    );
  });

  it('Operations: the Save button is disabled while the draft is blank', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published' }],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByTestId('operation-edit-description-gk-1::docker.restart'));
    const dialog = await screen.findByTestId('operation-description-dialog');
    const saveButton = within(dialog).getByTestId(
      'operation-description-save',
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(within(dialog).getByTestId('operation-description-textarea'), {
      target: { value: '   ' },
    });
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(within(dialog).getByTestId('operation-description-textarea'), {
      target: { value: 'a real description' },
    });
    expect(saveButton.disabled).toBe(false);
  });

  // STATUS leftover 123 (D-24): update_operation_description is builder-floor, proposer-or-owner —
  // the description reaches every agent's tool list. The edit control is offered only where the
  // call can succeed.
  it.each([
    ['the owner, on a gate-imported Operation', 'owner', 'p-me', 'p-owner', true],
    ['a builder, on an Operation they proposed', 'builder', 'p-me', 'p-me', true],
    ['a builder, on the owner’s imported Operation', 'builder', 'p-me', 'p-owner', false],
    ['a member', 'member', 'p-me', 'p-me', false],
    ['an operator', 'operator', 'p-me', 'p-owner', false],
  ] as const)(
    'Operations: Edit description for %s → offered: %s',
    async (_label, role, callerId, proposedBy, offered) => {
      const http = scriptedHttp({
        get_workspace: () => ({
          id: 'ws-1',
          name: 'Acme',
          createdAt: '2026-01-01T00:00:00Z',
          principalCount: 3,
          gatekeeperCount: 1,
          caller: { id: callerId, role, displayName: 'Me', kind: 'human' },
        }),
        list_operations: () => ({
          items: [
            { gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published', proposedBy },
          ],
        }),
        get_operation_stats: () => ({ items: [] }),
      });
      renderPage(http);
      const row = await screen.findByTestId('catalog-row');
      await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
      const detail = await selectRow(row);
      await waitFor(() =>
        expect(
          within(detail).queryByTestId('operation-edit-description-gk-1::docker.restart') !== null,
        ).toBe(offered),
      );
    },
  );

  it('Operations: a not_proposer refusal stays on that row — the dialog shows it and the control stays elsewhere', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published' }],
      }),
      get_operation_stats: () => ({ items: [] }),
      update_operation_description: () =>
        Promise.reject(
          new HttpError('capability_error', 'not the proposer of this Operation', 'not_proposer'),
        ),
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByTestId('operation-edit-description-gk-1::docker.restart'));
    const dialog = await screen.findByTestId('operation-description-dialog');
    fireEvent.change(within(dialog).getByTestId('operation-description-textarea'), {
      target: { value: 'new description' },
    });
    fireEvent.click(within(dialog).getByTestId('operation-description-save'));
    await within(dialog).findByText(/只有它的提议人或工作区所有者能做这一步/);
    // Not a `forbidden`: the capability is not marked denied for the session.
    expect(
      within(detail).queryByTestId('operation-edit-description-gk-1::docker.restart'),
    ).not.toBeNull();
  });

  it('Workers tab: Deprecate opens a medium confirm listing the definition name; deprecate_worker_definition fires only on confirm', async () => {
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
      deprecate_worker_definition: (params) => {
        expect(params).toEqual({ definitionId: 'wd-1', version: 1 });
        return {};
      },
    });
    renderPage(http, 'workers');
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByRole('button', { name: /弃用/ }));

    const confirm = await screen.findByTestId('worker-deprecate-confirm-wd-1@1');
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('Fixer');
    expect(http.calls.some((c) => c.name === 'deprecate_worker_definition')).toBe(false);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'deprecate_worker_definition')).toBe(true),
    );
  });

  // S8 W2 U2 (audit CW1): the entry definition renders in its own section with no Deprecate
  // action at all (deprecating it would break this workspace's entry agent) — a Worker row still
  // gets one.
  it('Workers tab: the entry definition has no Deprecate action; Worker rows still get one (CW1)', async () => {
    const http = scriptedHttp({
      list_worker_definitions: () => ({
        items: [
          {
            id: 'wd-entry',
            version: 1,
            kind: 'entry',
            status: 'published',
            definition: { name: 'Entry agent' },
          },
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
    const entrySection = await screen.findByTestId('workers-entry-section');
    const entryRow = within(entrySection).getByTestId('catalog-row');
    const entryDetail = await selectRow(entryRow);
    expect(within(entryDetail).queryByRole('button', { name: /弃用/ })).toBeNull();
    expect(within(entryDetail).getByRole('button', { name: /编辑（新版本草稿）/ })).toBeTruthy();

    const workerSection = screen.getByTestId('workers-worker-section');
    const workerRow = within(workerSection).getByTestId('catalog-row');
    const workerDetail = await selectRow(workerRow);
    expect(within(workerDetail).getByRole('button', { name: /弃用/ })).toBeTruthy();
  });

  // P3-5 copy-guard regression: an entry definition with no name used to title its row with the
  // raw UUID; it now reads 「未命名 · <short id>」.
  it('Workers tab: an unnamed definition is labelled with a short id, never the raw UUID', async () => {
    const uuid = 'f96d762e-6111-4a10-a699-66b8ae46c622';
    const http = scriptedHttp({
      list_worker_definitions: () => ({
        items: [{ id: uuid, version: 1, kind: 'entry', status: 'published', definition: {} }],
      }),
    });
    renderPage(http, 'workers');
    const entrySection = await screen.findByTestId('workers-entry-section');
    const row = within(entrySection).getByTestId('catalog-row');
    expect(row.textContent).toMatch(/未命名/);
    expect(row.textContent).not.toContain(uuid);
  });

  // S8 W2-U2b (audit R6 "保存草稿后找不回它"): the Workers tab makes a second
  // `list_worker_definitions{includeOwnDrafts: true}` call for "我的草稿" — these three tests
  // script that second call by branching on `params.includeOwnDrafts` the same way the kernel's
  // own handler does (additive: published rows come back from it too, only `status === 'draft'`
  // rows belong in the section).
  describe('Workers tab: "我的草稿" (R6)', () => {
    it('renders no section at all when the caller has no draft rows', async () => {
      const http = scriptedHttp({
        // Same items regardless of `includeOwnDrafts` — no draft either way, matching the kernel's
        // own additive semantics (published rows come back whether or not the flag is set).
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
      await screen.findByTestId('catalog-row');
      await waitFor(() =>
        expect(http.calls.some((c) => c.name === 'list_worker_definitions')).toBe(true),
      );
      expect(screen.queryByTestId('workers-my-drafts-section')).toBeNull();
    });

    it('lists only the caller’s own draft rows, never the published ones the same call also returns', async () => {
      const http = scriptedHttp({
        list_worker_definitions: (params) => {
          const { includeOwnDrafts } = (params ?? {}) as { includeOwnDrafts?: boolean };
          const published = {
            id: 'wd-1',
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Fixer' },
          };
          const draft = {
            id: 'wd-2',
            version: 1,
            kind: 'worker',
            status: 'draft',
            definition: { name: 'Patcher' },
          };
          return { items: includeOwnDrafts ? [published, draft] : [published] };
        },
      });
      renderPage(http, 'workers');
      const section = await screen.findByTestId('workers-my-drafts-section');
      const rows = within(section).getAllByTestId('workers-my-draft-row');
      expect(rows).toHaveLength(1);
      expect(within(rows[0] as HTMLElement).getByText('Patcher')).toBeTruthy();
      expect(within(section).queryByText('Fixer')).toBeNull();
    });

    it('Publish calls publish_worker_definition, and the row moves to the published Worker section on refresh', async () => {
      let published = false;
      const http = scriptedHttp({
        list_worker_definitions: (params) => {
          const { includeOwnDrafts } = (params ?? {}) as { includeOwnDrafts?: boolean };
          const row = {
            id: 'wd-2',
            version: 1,
            kind: 'worker',
            status: published ? 'published' : 'draft',
            definition: { name: 'Patcher' },
          };
          if (includeOwnDrafts) return { items: [row] };
          return { items: published ? [row] : [] };
        },
        publish_worker_definition: (params) => {
          expect(params).toEqual({ definitionId: 'wd-2', version: 1 });
          published = true;
          return { id: 'wd-2', version: 1, status: 'published' };
        },
      });
      renderPage(http, 'workers');
      const section = await screen.findByTestId('workers-my-drafts-section');
      const row = within(section).getByTestId('workers-my-draft-row');
      const detail = await selectRow(row);
      fireEvent.click(within(detail).getByTestId('worker-draft-publish'));

      await waitFor(() =>
        expect(http.calls.some((c) => c.name === 'publish_worker_definition')).toBe(true),
      );
      await waitFor(() => expect(screen.queryByTestId('workers-my-drafts-section')).toBeNull());
      const workerSection = screen.getByTestId('workers-worker-section');
      expect(within(workerSection).getByText('Patcher')).toBeTruthy();
    });

    // S8 W3 K2 (leftover 82): "丢弃" opens a medium confirm; discard_draft fires only on confirm,
    // and the row disappears from "我的草稿" once discarded.
    it('Discard opens a medium confirm listing the definition name; discard_draft fires only on confirm and removes the draft', async () => {
      let discarded = false;
      const http = scriptedHttp({
        list_worker_definitions: (params) => {
          const { includeOwnDrafts } = (params ?? {}) as { includeOwnDrafts?: boolean };
          if (discarded) return { items: [] };
          const row = {
            id: 'wd-3',
            version: 1,
            kind: 'worker',
            status: 'draft',
            definition: { name: 'Throwaway' },
          };
          return { items: includeOwnDrafts ? [row] : [] };
        },
        discard_draft: (params) => {
          expect(params).toEqual({ kind: 'worker_definition', id: 'wd-3', version: 1 });
          discarded = true;
          return { kind: 'worker_definition', id: 'wd-3', version: 1 };
        },
      });
      renderPage(http, 'workers');
      const section = await screen.findByTestId('workers-my-drafts-section');
      const row = within(section).getByTestId('workers-my-draft-row');
      const detail = await selectRow(row);
      fireEvent.click(within(detail).getByRole('button', { name: /丢弃/ }));

      const confirm = await screen.findByTestId('worker-draft-discard-wd-3@1');
      expect(confirm.getAttribute('data-tier')).toBe('medium');
      expect(within(confirm).getByTestId('confirm-target').textContent).toBe('Throwaway');
      expect(http.calls.some((c) => c.name === 'discard_draft')).toBe(false);
      fireEvent.click(within(confirm).getByTestId('confirm-button'));

      await waitFor(() => expect(http.calls.some((c) => c.name === 'discard_draft')).toBe(true));
      await waitFor(() => expect(screen.queryByTestId('workers-my-drafts-section')).toBeNull());
    });

    it('shows the auto-cleanup note next to the drafts list', async () => {
      const http = scriptedHttp({
        list_worker_definitions: (params) => {
          const { includeOwnDrafts } = (params ?? {}) as { includeOwnDrafts?: boolean };
          const row = {
            id: 'wd-4',
            version: 1,
            kind: 'worker',
            status: 'draft',
            definition: { name: 'Noted' },
          };
          return { items: includeOwnDrafts ? [row] : [] };
        },
      });
      renderPage(http, 'workers');
      const note = await screen.findByTestId('workers-my-drafts-expiry-note');
      expect(note.textContent).toMatch(/30/);
    });
  });

  // S8 W2 U2 (audit J7/CW1): "从模板创建（ops-runner）" opens the editor prefilled rather than
  // inventing new template content — the button only exposes the checked-in ops-runner template
  // through the existing propose/publish path (F1).
  //
  // S8 W3 K2 (leftover 84): the button stays disabled until `list_capability_names` has loaded
  // (so an incomplete list is never submitted), and the prefilled `capabilities` is every
  // non-execute-class name from that directory plus `request_action` — never omitted
  // (the kernel default for omitted `capabilities` silently drops `request_action`) and never
  // `['request_action']` alone (that would drop every observe capability).
  it('Workers tab: "从模板创建（ops-runner）" is disabled until list_capability_names loads, then opens the editor prefilled with the full non-execute set plus request_action', async () => {
    let resolveCapabilityNames: (() => void) | undefined;
    const capabilityNamesGate = new Promise<void>((resolve) => {
      resolveCapabilityNames = resolve;
    });
    const http = scriptedHttp({
      list_worker_definitions: () => ({ items: [] }),
      list_models: () => ({ items: [] }),
      list_capability_names: async () => {
        await capabilityNamesGate;
        return {
          items: [
            { name: 'assert_fact', mode: 'write' },
            { name: 'find_workers', mode: 'observe' },
            { name: 'get_object', mode: 'observe' },
            { name: 'propose_skill', mode: 'propose' },
            { name: 'request_action', mode: 'execute' },
          ],
        };
      },
      list_gatekeepers: () => ({ items: [] }),
      list_skills: () => ({ items: [] }),
      propose_worker_definition: (params) => {
        expect(params).toEqual({
          kind: 'worker',
          definition: {
            systemPrompt: expect.stringContaining('ops-runner'),
            name: 'ops-runner',
            capabilities: [
              'assert_fact',
              'find_workers',
              'get_object',
              'propose_skill',
              'request_action',
            ],
          },
        });
        return { id: 'wd-tmpl', version: 1, status: 'draft' };
      },
    });
    renderPage(http, 'workers');
    await screen.findByTestId('workers-worker-section');

    const templateButton = screen.getByTestId('workers-template-button') as HTMLButtonElement;
    expect(templateButton.disabled).toBe(true);

    resolveCapabilityNames?.();
    await waitFor(() => expect(templateButton.disabled).toBe(false));

    fireEvent.click(templateButton);
    const drawer = await screen.findByTestId('worker-editor-drawer');
    expect((within(drawer).getByLabelText(/^名称/) as HTMLInputElement).value).toBe('ops-runner');
    const kindSelect = within(drawer).getByTestId('wd-kind') as HTMLSelectElement;
    expect(kindSelect.value).toBe('worker');
    expect(kindSelect.disabled).toBe(true);
    const capabilitiesField = within(drawer).getByTestId('wd-capabilities');
    // Every non-execute name is checked, plus request_action — nothing execute-class besides it.
    for (const name of [
      'assert_fact',
      'find_workers',
      'get_object',
      'propose_skill',
      'request_action',
    ]) {
      // Audit P1-8: the checkbox reads "<label> <name>", so match the name at the end.
      const box = within(capabilitiesField).getByLabelText(new RegExp(`(^|\\s)${name}$`));
      expect((box as HTMLInputElement).checked).toBe(true);
    }
    fireEvent.click(within(drawer).getByTestId('worker-submit'));
    await within(drawer).findByTestId('draft-proposed');
    expect(http.calls.some((c) => c.name === 'propose_worker_definition')).toBe(true);
  });

  // S8 W3 K2 (leftover 82): the Skills/Procedures tabs get the same "丢弃" action inline on a
  // draft row (Workers' own "我的草稿" version is covered above) — one representative test each,
  // the underlying wiring (`discardSkillDraft`/`discardProcedureDraft`) mirrors `act` exactly.
  it('Skills tab: a draft row offers "丢弃"; discard_draft{kind:skill} fires only on confirm and removes the row', async () => {
    let discarded = false;
    const http = scriptedHttp({
      list_skills: () => ({
        items: discarded
          ? []
          : [{ id: 'sk-1', version: 1, status: 'draft', name: 'diagnose-net', description: 'd' }],
      }),
      discard_draft: (params) => {
        expect(params).toEqual({ kind: 'skill', id: 'sk-1', version: 1 });
        discarded = true;
        return { kind: 'skill', id: 'sk-1', version: 1 };
      },
    });
    renderPage(http, 'skills');
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByRole('button', { name: /丢弃/ }));

    const confirm = await screen.findByTestId('skill-discard-confirm-sk-1');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    expect(http.calls.some((c) => c.name === 'discard_draft')).toBe(false);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() => expect(http.calls.some((c) => c.name === 'discard_draft')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('catalog-row')).toBeNull());
  });

  it('Procedures tab: a draft row offers "丢弃"; discard_draft{kind:procedure} fires only on confirm', async () => {
    const http = scriptedHttp({
      list_procedures: () => ({
        items: [
          { id: 'pr-1', version: 1, status: 'draft', name: 'restart-verify', description: 'd' },
        ],
      }),
      discard_draft: (params) => {
        expect(params).toEqual({ kind: 'procedure', id: 'pr-1', version: 1 });
        return { kind: 'procedure', id: 'pr-1', version: 1 };
      },
    });
    renderPage(http, 'procedures');
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByRole('button', { name: /丢弃/ }));

    const confirm = await screen.findByTestId('procedure-discard-confirm-pr-1');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() => expect(http.calls.some((c) => c.name === 'discard_draft')).toBe(true));
  });

  // Wave 5: the owner and builders see every Skill / Procedure draft (D-26 rule) — a member's
  // Worker-proposed Skill is reviewed here. The detail names the proposer and offers Publish;
  // Discard stays the proposer's own act, so it is not offered on someone else's draft.
  const OWNER_WORKSPACE = {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 3,
    gatekeeperCount: 0,
    caller: { id: 'p-owner', role: 'owner', displayName: 'Owner', kind: 'human' },
  };

  it('Skills tab: the owner reviews a member’s draft — proposer named, Publish offered, no Discard', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_skills: () => ({
        items: [
          {
            id: 'sk-9',
            version: 1,
            status: 'draft',
            name: 'worker-found-trick',
            description: 'd',
            proposedBy: 'p-member',
          },
        ],
      }),
      get_skill: () => null,
      resolve_refs: () => ({ items: [{ id: 'p-member', kind: 'principal', name: 'Mia' }] }),
      publish_skill: () => ({ id: 'sk-9', version: 1, status: 'published' }),
    });
    renderPage(http, 'skills');
    const detail = await selectRow(await screen.findByTestId('catalog-row'));

    const proposer = within(detail).getByTestId('skill-detail-proposer');
    expect(proposer.getAttribute('data-ref-id')).toBe('p-member');
    await waitFor(() => expect(proposer.textContent).toContain('Mia'));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    await waitFor(() => expect(within(detail).queryByRole('button', { name: /丢弃/ })).toBeNull());

    fireEvent.click(within(detail).getByRole('button', { name: /发布/ }));
    await waitFor(() =>
      expect(http.calls.find((c) => c.name === 'publish_skill')?.params).toEqual({
        skillId: 'sk-9',
      }),
    );
  });

  it('Skills tab: the proposer’s own draft still offers Discard', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_skills: () => ({
        items: [
          {
            id: 'sk-10',
            version: 1,
            status: 'draft',
            name: 'my-trick',
            description: 'd',
            proposedBy: 'p-owner',
          },
        ],
      }),
      get_skill: () => null,
      resolve_refs: () => ({ items: [{ id: 'p-owner', kind: 'principal', name: 'Owner' }] }),
    });
    renderPage(http, 'skills');
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    expect(within(detail).getByRole('button', { name: /丢弃/ })).toBeTruthy();
  });

  it('Procedures tab: the owner sees whose draft it is and can publish it', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_procedures: () => ({
        items: [
          {
            id: 'pr-9',
            version: 1,
            status: 'draft',
            name: 'approve-then-verify',
            description: 'd',
            steps: [],
            proposedBy: 'p-builder',
          },
        ],
      }),
      resolve_refs: () => ({ items: [{ id: 'p-builder', kind: 'principal', name: 'Bo' }] }),
      publish_procedure: () => ({ id: 'pr-9', version: 1, status: 'published' }),
    });
    renderPage(http, 'procedures');
    const detail = await selectRow(await screen.findByTestId('catalog-row'));

    const proposer = within(detail).getByTestId('procedure-detail-proposer');
    await waitFor(() => expect(proposer.textContent).toContain('Bo'));
    await waitFor(() => expect(within(detail).queryByRole('button', { name: /丢弃/ })).toBeNull());
    fireEvent.click(within(detail).getByRole('button', { name: /发布/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'publish_procedure')).toBe(true));
  });
});

describe('CatalogPage master-detail (console redesign P3-5)', () => {
  it('selecting a Skill row reports its own id (routes.tsx encodes that into #/govern/catalog/skills/<id>)', async () => {
    const http = scriptedHttp({
      list_skills: () => ({
        items: [
          { id: 'sk-1', version: 1, status: 'published', name: 'restart-web', description: 'd' },
        ],
      }),
    });
    const onSelectItem = vi.fn();
    render(
      <PermissionsProvider>
        <ToastProvider>
          <CatalogPage
            http={http}
            tab="skills"
            onTabChange={() => {}}
            onSelectItem={onSelectItem}
          />
        </ToastProvider>
      </PermissionsProvider>,
    );
    const row = await screen.findByTestId('catalog-row');
    fireEvent.click(row);
    expect(onSelectItem).toHaveBeenCalledWith('sk-1');
  });

  it('wide layout, nothing selected: the detail pane names the object instead of a blank pane (V9)', async () => {
    const http = scriptedHttp({
      list_skills: () => ({
        items: [
          { id: 'sk-1', version: 1, status: 'published', name: 'restart-web', description: 'd' },
        ],
      }),
    });
    renderPage(http, 'skills');
    await screen.findByTestId('catalog-row');
    const detail = screen.getByTestId('catalog-detail');
    // A regex, not a plain `toContain` string: `i18n-pairs.mjs`'s detector (b) pattern-matches any
    // quoted "<中文><space><English word>" literal, including a test assertion that merely quotes
    // a fragment of already-`t()`-split UI copy — `/…/ ` sidesteps that scanner entirely (it only
    // scans quoted string literals) without weakening what this assertion actually checks.
    expect(within(detail).getByTestId('catalog-detail-empty').textContent).toMatch(
      /选择左侧一个 Skill/,
    );
  });

  it('empty Skill list collapses to a single pane (no detail pane) and names the object (V9)', async () => {
    const http = scriptedHttp({ list_skills: () => ({ items: [] }) });
    renderPage(http, 'skills');
    await screen.findByTestId('catalog-empty');
    expect(screen.getByTestId('catalog-empty').textContent).toMatch(/还没有 Skill/);
    expect(screen.queryByTestId('catalog-detail')).toBeNull();
  });

  // V2: the old itemized `ExecutionPrerequisiteBar` block is gone from this page — the same
  // quiet `ExecutionReadinessCard` the 对话 page renders (console redesign P3-3) is reused here
  // instead of a second, differently-shaped readiness read.
  it('renders execution readiness through the quiet ExecutionReadinessCard, not the old ExecutionPrerequisiteBar', async () => {
    const http = scriptedHttp({
      execution_readiness: () => ({ ready: true, gates: [], workers: [], missing: [] }),
      list_operations: () => ({ items: [] }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('execution-readiness-body');
    expect(screen.queryByTestId('execution-prerequisite-bar')).toBeNull();
  });
});

/** S6-A A2 (console-completion-plan §5.3): the editors are reachable from each tab and the
 *  page refreshes its list once a draft is done. Submit shapes are covered per editor in
 *  `components/catalog/*.test.tsx`. */
describe('CatalogPage editors (S6-A A2)', () => {
  it('Skills: "New draft" opens the SKILL.md editor; proposing then Done refreshes list_skills', async () => {
    let listCalls = 0;
    const http = scriptedHttp({
      list_skills: () => {
        listCalls += 1;
        return { items: [] };
      },
      propose_skill: () => ({ id: 'sk-1', version: 1, status: 'draft', name: 'restart-web' }),
    });
    renderPage(http, 'skills');
    await screen.findByTestId('catalog-empty');
    fireEvent.click(screen.getByTestId('skills-new-draft'));
    const drawer = await screen.findByTestId('skill-editor-drawer');
    fireEvent.change(within(drawer).getByLabelText(/^名称/), {
      target: { value: 'restart-web' },
    });
    fireEvent.change(within(drawer).getByLabelText(/^描述/), {
      target: { value: 'Restart web' },
    });
    fireEvent.change(within(drawer).getByLabelText(/SKILL.md 正文/), {
      target: { value: '# Steps' },
    });
    fireEvent.click(within(drawer).getByTestId('skill-submit'));
    await within(drawer).findByTestId('draft-proposed');
    expect(http.calls.find((c) => c.name === 'propose_skill')?.params).toEqual({
      skill: { name: 'restart-web', description: 'Restart web', markdown: '# Steps' },
    });
    // One reload when the draft is proposed (the list now holds it), one more on Done.
    await waitFor(() => expect(listCalls).toBe(2));
    fireEvent.click(within(drawer).getByTestId('draft-done'));
    await waitFor(() => expect(listCalls).toBe(3));
    await waitFor(() => expect(screen.queryByTestId('skill-editor-drawer')).toBeNull());
  });

  it('Skills: "Edit as new draft" pre-fills the row and the current version’s body (get_skill), and says the result is a new Skill', async () => {
    const http = scriptedHttp({
      list_skills: () => ({
        items: [
          {
            id: 'sk-1',
            version: 3,
            status: 'published',
            name: 'restart-web',
            description: 'Restart web',
            applicable: { gateKinds: ['http'] },
          },
        ],
      }),
      get_skill: (params) => {
        expect(params).toEqual({ skillId: 'sk-1' });
        return {
          id: 'sk-1',
          version: 3,
          status: 'published',
          name: 'restart-web',
          description: 'Restart web',
          applicable: { gateKinds: ['http'] },
          markdown: '# Steps\n\n1. restart',
          proposedBy: 'p-1',
          publishedBy: 'p-1',
          createdAt: '2026-01-01T00:00:00Z',
          publishedAt: '2026-01-01T00:00:00Z',
        };
      },
    });
    renderPage(http, 'skills');
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByTestId('catalog-edit-as-draft'));
    const drawer = await screen.findByTestId('skill-editor-drawer');
    expect(within(drawer).getByTestId('skill-copy-notice').textContent).toContain('新的');
    expect((within(drawer).getByLabelText(/^名称/) as HTMLInputElement).value).toBe('restart-web');
    expect((within(drawer).getByLabelText('HTTP') as HTMLInputElement).checked).toBe(true);
    expect((within(drawer).getByLabelText('MCP') as HTMLInputElement).checked).toBe(false);
    await waitFor(() =>
      expect((within(drawer).getByLabelText(/SKILL.md 正文/) as HTMLTextAreaElement).value).toBe(
        '# Steps\n\n1. restart',
      ),
    );
  });

  it('Workers: "Edit as new draft version" proposes under the same definitionId with the kind locked', async () => {
    const http = scriptedHttp({
      list_worker_definitions: () => ({
        items: [
          {
            id: 'wd-1',
            version: 2,
            kind: 'entry',
            status: 'published',
            definition: { name: 'Entry', systemPrompt: 'Be helpful.', capabilities: ['search'] },
          },
        ],
      }),
      list_models: () => ({ items: [] }),
      propose_worker_definition: () => ({ id: 'wd-1', version: 3, status: 'draft' }),
    });
    renderPage(http, 'workers');
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByTestId('catalog-edit-as-draft'));
    const drawer = await screen.findByTestId('worker-editor-drawer');
    expect((within(drawer).getByTestId('wd-kind') as HTMLSelectElement).disabled).toBe(true);
    expect((within(drawer).getByTestId('wd-kind') as HTMLSelectElement).value).toBe('entry');
    fireEvent.click(within(drawer).getByTestId('worker-submit'));
    await within(drawer).findByTestId('draft-proposed');
    expect(http.calls.find((c) => c.name === 'propose_worker_definition')?.params).toEqual({
      definitionId: 'wd-1',
      kind: 'entry',
      definition: { systemPrompt: 'Be helpful.', name: 'Entry', capabilities: ['search'] },
    });
  });

  it('hides "New draft" once propose_* has been refused for the session', async () => {
    const http = scriptedHttp({
      list_procedures: () => ({ items: [] }),
      propose_procedure: () =>
        Promise.reject(new HttpError('capability_error', 'builder required', 'forbidden')),
    });
    renderPage(http, 'procedures');
    await screen.findByTestId('catalog-empty');
    fireEvent.click(screen.getByTestId('procedures-new-draft'));
    const drawer = await screen.findByTestId('procedure-editor-drawer');
    fireEvent.change(within(drawer).getByLabelText(/^名称/), { target: { value: 'Deploy' } });
    fireEvent.change(within(drawer).getByLabelText(/^描述/), {
      target: { value: 'Deploy web' },
    });
    fireEvent.click(within(drawer).getByTestId('procedure-submit'));
    const banner = await within(drawer).findByTestId('procedure-editor-error');
    expect(banner.getAttribute('data-error-code')).toBe('forbidden');
    fireEvent.click(within(drawer).getByRole('button', { name: /取消/ }));
    await waitFor(() => expect(screen.queryByTestId('procedures-new-draft')).toBeNull());
  });
});

// Decision 2026-10-09 "二次确认": a draft carrying suspected credentials publishes only with the
// person's confirmation. The catalog learns the count from the kernel's refusal, so the first
// Publish opens the question next to the button, and the second carries `credentialsReviewed`.
describe('CatalogPage — credential confirmation on Publish', () => {
  const refusal = (subject: string, count: number) =>
    new HttpError(
      'capability_error',
      `${subject} carries suspected credentials`,
      'credentials_review_required',
      {
        subject,
        suspectedSecretValues: count,
      },
    );

  it('Operations: the refusal opens the question, Publish waits for the tick, the retry carries it', async () => {
    const seen: unknown[] = [];
    const http = scriptedHttp({
      list_operations: () => ({
        items: [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'draft' }],
      }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: (params) => {
        seen.push(params);
        if (seen.length === 1) return Promise.reject(refusal('operation', 1));
        return {};
      },
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    const review = await within(detail).findByTestId('credential-review');
    expect(review.getAttribute('data-count')).toBe('1');
    expect(screen.queryByTestId('toast')).toBeNull();
    const publish = within(detail).getByRole('button', { name: /^发布$/ }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);

    fireEvent.click(within(detail).getByTestId('credential-review-confirm'));
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      { gatekeeperId: 'gk-1', name: 'docker.restart' },
      { gatekeeperId: 'gk-1', name: 'docker.restart', credentialsReviewed: true },
    ]);
  });

  it('Skills: the same flow on publish_skill', async () => {
    const seen: unknown[] = [];
    const http = scriptedHttp({
      get_workspace: () => ({
        id: 'ws-1',
        name: 'Acme',
        createdAt: '2026-01-01T00:00:00Z',
        principalCount: 1,
        gatekeeperCount: 0,
        caller: { id: 'p-owner', role: 'owner', displayName: 'Owner', kind: 'human' },
      }),
      list_skills: () => ({
        items: [{ id: 'sk-9', version: 2, status: 'draft', name: 'rotate', description: 'd' }],
      }),
      get_skill: () => null,
      publish_skill: (params) => {
        seen.push(params);
        if (seen.length === 1) return Promise.reject(refusal('skill', 2));
        return { id: 'sk-9', version: 2, status: 'published' };
      },
    });
    renderPage(http, 'skills');
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    const review = await within(detail).findByTestId('credential-review');
    expect(review.getAttribute('data-count')).toBe('2');
    fireEvent.click(within(detail).getByTestId('credential-review-confirm'));
    fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    await waitFor(() =>
      expect(seen).toEqual([{ skillId: 'sk-9' }, { skillId: 'sk-9', credentialsReviewed: true }]),
    );
  });

  it('Workers: the same flow on publish_worker_definition', async () => {
    const seen: unknown[] = [];
    const http = scriptedHttp({
      list_worker_definitions: (params) => {
        const { includeOwnDrafts } = (params ?? {}) as { includeOwnDrafts?: boolean };
        const row = {
          id: 'wd-2',
          version: 1,
          kind: 'worker',
          status: 'draft',
          definition: { name: 'Patcher' },
        };
        return { items: includeOwnDrafts ? [row] : [] };
      },
      publish_worker_definition: (params) => {
        seen.push(params);
        if (seen.length === 1) return Promise.reject(refusal('worker_definition', 1));
        return { id: 'wd-2', version: 1, status: 'published' };
      },
    });
    renderPage(http, 'workers');
    const section = await screen.findByTestId('workers-my-drafts-section');
    const detail = await selectRow(within(section).getByTestId('workers-my-draft-row'));
    fireEvent.click(within(detail).getByTestId('worker-draft-publish'));
    await within(detail).findByTestId('credential-review');
    expect((within(detail).getByTestId('worker-draft-publish') as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(within(detail).getByTestId('credential-review-confirm'));
    fireEvent.click(within(detail).getByTestId('worker-draft-publish'));
    await waitFor(() =>
      expect(seen).toEqual([
        { definitionId: 'wd-2', version: 1 },
        { definitionId: 'wd-2', version: 1, credentialsReviewed: true },
      ]),
    );
  });
});
