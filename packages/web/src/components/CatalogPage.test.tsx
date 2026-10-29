// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import type { CatalogTab } from '../lib/router.js';
import { CatalogPage } from './CatalogPage.js';
import { governanceFields } from './connect/governance-fixtures.test-helpers.js';
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

const HELD_DRAFT = {
  gatekeeperId: 'gk-1',
  name: 'stock.reserve',
  status: 'draft',
  mode: 'execute',
  blastRadius: 'medium',
  autoApprovable: false,
  draftDigest: 'sha256:held-draft',
};

const LINKED_INSTANCE = {
  gateId: 'gate-1',
  connector: 'openapi',
  displayName: 'Stock',
  transportKind: 'http',
  target: 'https://stock.example',
  status: 'enabled',
  trust: 'vetted',
  health: 'ok',
  operationCount: 2,
  gatekeeperId: 'gk-1',
};

/** The align's preview of the linked gate: the held draft, rewritable or not. */
function heldPreview(rewritable: boolean) {
  return {
    gateId: 'gate-1',
    wouldLink: null,
    ambiguousCandidates: [],
    operationsToImport: [
      {
        name: 'stock.reserve',
        mode: 'execute',
        blastRadius: 'medium',
        autoApprovable: false,
        ...(rewritable
          ? {}
          : { gateOwnedParams: [{ param: 'Authorization', location: 'header' }] }),
        pendingDraft: { rewritable, fromGate: true },
      },
    ],
    operationsAlreadyPresent: [],
    manifestDigest: 'digest-1',
    awaitingPlatformAdoption: null,
  };
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
    // Worker as English proper nouns — 流程, 能力包 and 安装历史 are zh terms).
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

  it('S11 「门确认不存在」 A: an observe Operation’s detail says which target answers mean the thing is not there; one with no declaration says nothing', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'record.get',
            status: 'published',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
            absentAnswers: { statuses: [404, 410] },
          },
          {
            gatekeeperId: 'gk-1',
            name: 'unit.show',
            status: 'draft',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
            absentAnswers: { exitCodes: [4] },
            draftDigest: 'sha256:unit-show',
          },
          {
            gatekeeperId: 'gk-1',
            name: 'stock.list',
            status: 'published',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http);
    const rowNamed = async (name: string) => {
      const row = (await screen.findAllByTestId('catalog-row')).find((candidate) =>
        candidate.textContent?.includes(name),
      );
      if (!row) throw new Error(`${name} row missing`);
      return row;
    };
    let detail = await selectRow(await rowNamed('record.get'));
    expect(within(detail).getByTestId('catalog-detail-absent-answers').textContent).toBe(
      '目标回答 404 或 410 时，表示要查的东西不存在：这次观察记为“不存在”，不算调用失败。',
    );
    expect(detail.textContent).toContain('表示不存在的回答');
    detail = await selectRow(await rowNamed('unit.show'));
    expect(within(detail).getByTestId('catalog-detail-absent-answers').textContent).toContain(
      '命令以退出码 4 结束时',
    );
    detail = await selectRow(await rowNamed('stock.list'));
    expect(within(detail).queryByTestId('catalog-detail-absent-answers')).toBeNull();
    expect(detail.textContent).not.toContain('表示不存在的回答');
  });

  it('legacy 349: the first version of a write or high-impact Operation is confirmed before it is published; a low-impact observe draft stays one click', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'docker.restart',
            status: 'draft',
            mode: 'execute',
            blastRadius: 'high',
            autoApprovable: false,
          },
          {
            gatekeeperId: 'gk-1',
            name: 'docker.ps',
            status: 'draft',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: () => ({}),
    });
    renderPage(http);
    const rows = await screen.findAllByTestId('catalog-row');
    const restart = rows.find((row) => row.textContent?.includes('docker.restart'));
    if (!restart) throw new Error('docker.restart row missing');
    let detail = await selectRow(restart);
    fireEvent.click(
      within(detail).getByTestId('operation-publish-first-confirm-gk-1::docker.restart-trigger'),
    );
    expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(false);
    const confirm = await screen.findByTestId(
      'operation-publish-first-confirm-gk-1::docker.restart',
    );
    expect(confirm.textContent).toContain('第一次发布');
    expect(confirm.textContent).toContain('每次都要人工审批');
    // The name shows once, in the target (UX acceptance of #645: long names pushed the buttons
    // out of the popover when the title and the impact line repeated it).
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('docker.restart');
    expect(confirm.textContent?.split('docker.restart')).toHaveLength(2);
    expect(confirm.textContent).toContain('它会写入系统');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'publish_operation')).toHaveLength(1),
    );

    const ps = (await screen.findAllByTestId('catalog-row')).find((row) =>
      row.textContent?.includes('docker.ps'),
    );
    if (!ps) throw new Error('docker.ps row missing');
    detail = await selectRow(ps);
    expect(within(detail).queryByTestId(/operation-publish-first-confirm/)).toBeNull();
    fireEvent.click(within(detail).getByRole('button', { name: /发布/ }));
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'publish_operation')).toHaveLength(2),
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
    expect(toast.textContent).toContain('无法发布');
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
              before: governanceFields({
                mode: 'execute',
                blastRadius: 'high',
                autoApprovable: true,
              }),
              after: governanceFields({
                mode: 'execute',
                blastRadius: 'low',
                autoApprovable: true,
              }),
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
    // The target names the operation once; the consequences and the change list don't repeat it,
    // and the change is shown once, as the old → new list (legacy 400).
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('docker.restart');
    expect(confirm.textContent?.split('docker.restart')).toHaveLength(2);
    expect(within(confirm).queryByTestId('confirm-impact')).toBeNull();
    expect(within(confirm).getByTestId('governance-diff-list').textContent).toContain(
      '治理字段的变化',
    );
    expect(confirm.textContent).toContain('它不再是高影响');
    expect(within(confirm).getByTestId('confirm-button').className).toContain('text-danger');
    const loosens = within(confirm).getByTestId(
      'operation-publish-confirm-gk-1::docker.restart@draft-loosens',
    );
    expect(loosens.textContent).toContain('不再是高影响');
    // Legacy 404: the change being confirmed comes before what loosening it means.
    expect(
      within(confirm).getByTestId('governance-diff-list').compareDocumentPosition(loosens) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Legacy 405: a loosening confirm opens on 取消.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(confirm).getByTestId('confirm-cancel')),
    );
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
              before: governanceFields({
                mode: 'execute',
                blastRadius: 'medium',
                autoApprovable: false,
              }),
              after: governanceFields({
                mode: 'execute',
                blastRadius: 'high',
                autoApprovable: false,
              }),
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
              before: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
              after: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
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

  it('console G4 (legacy 219): a draft held back for a gate-owned param says why before anyone clicks Publish; once the gate’s manifest is fixed the rewrite is one click, and says what it did', async () => {
    let rewritten = false;
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            ...HELD_DRAFT,
            ...(rewritten
              ? {}
              : { gateOwnedParams: [{ param: 'Authorization', location: 'header' }] }),
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [LINKED_INSTANCE] }),
      preview_gate_instance_enable: () => heldPreview(true),
      refresh_operation_governance: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          operationNames: ['stock.reserve'],
          manifestDigest: 'digest-1',
        });
        rewritten = true;
        return {
          gatekeeperId: 'gk-1',
          refreshed: [],
          revisionDrafts: [{ name: 'stock.reserve', version: 1 }],
          unchanged: [],
        };
      },
    });
    // The same key the bulk publish's held-drafts notice links to.
    renderPage(http, 'operations', 'gk-1::stock.reserve');
    const detail = await screen.findByTestId('catalog-detail');
    const notice = await within(detail).findByTestId('operation-gate-owned-params');
    expect(notice.textContent).toContain('发布不了');
    expect(notice.textContent).toContain('Authorization（请求头）');
    // Publishing could only end in 400 gate_owned_params: no button that leads there.
    expect(within(detail).queryByRole('button', { name: '发布' })).toBeNull();
    const rewrite = await within(notice).findByTestId('operation-gate-owned-rewrite');
    expect(rewrite.textContent).toBe('按门的最新清单重写');
    expect((rewrite as HTMLButtonElement).disabled).toBe(false);
    // UX acceptance of #567 P3: the button is right here — not "go to Systems & access".
    expect(notice.textContent).toContain('点下面的「按门的最新清单重写」');
    expect(notice.textContent).not.toContain('与门公告对齐');

    fireEvent.click(rewrite);
    const confirm = await screen.findByTestId('operation-gate-owned-rewrite-confirm');
    // Legacy 280: the confirm reuses the preview that decided the button — one read, not two.
    expect(http.calls.filter((call) => call.name === 'preview_gate_instance_enable')).toHaveLength(
      1,
    );
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const receipt = await screen.findByTestId('operation-rewritten');
    expect(receipt.textContent).toContain('已按门的最新清单重写这份草稿');
    expect(receipt.textContent).toContain('Authorization（请求头）');
    expect(screen.queryByTestId('operation-gate-owned-params')).toBeNull();
    expect(
      within(screen.getByTestId('catalog-detail')).getByRole('button', { name: '发布' }),
    ).toBeTruthy();
  });

  it('UX acceptance of #567 P2: while the gate’s manifest still declares the param, the rewrite is greyed out and says what it waits for', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { ...HELD_DRAFT, gateOwnedParams: [{ param: 'Authorization', location: 'header' }] },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [LINKED_INSTANCE] }),
      preview_gate_instance_enable: () => heldPreview(false),
    });
    renderPage(http, 'operations', 'gk-1::stock.reserve');
    const waiting = await screen.findByTestId('operation-gate-owned-rewrite-waiting');
    expect(waiting.textContent).toContain('门的清单仍声明这些参数');
    const rewrite = screen.getByTestId('operation-gate-owned-rewrite') as HTMLButtonElement;
    expect(rewrite.disabled).toBe(true);
    expect(rewrite.getAttribute('aria-describedby')).toBe(waiting.id);
    fireEvent.click(rewrite);
    expect(http.calls.some((call) => call.name === 'refresh_operation_governance')).toBe(false);
  });

  it('UX acceptance of #567 P3: two gates declaring the same Operation name are told apart by gate in the list', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { gatekeeperId: 'gk-1', name: 'orders.lookup', status: 'draft' },
          { gatekeeperId: 'gk-2', name: 'orders.lookup', status: 'draft' },
          { gatekeeperId: 'gk-1', name: 'stock.get', status: 'published' },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findAllByTestId('catalog-row');
    expect(screen.getByTestId('catalog-row-gate-gk-1::orders.lookup').textContent).toContain(
      '门：',
    );
    expect(screen.getByTestId('catalog-row-gate-gk-2::orders.lookup')).toBeTruthy();
    expect(screen.queryByTestId('catalog-row-gate-gk-1::stock.get')).toBeNull();
  });

  it('review #501 on #571 ①: a held draft someone proposed is never rewritten by the gate, so the rewrite is not offered and the text says who has to fix it', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { ...HELD_DRAFT, gateOwnedParams: [{ param: 'Authorization', location: 'header' }] },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [LINKED_INSTANCE] }),
      preview_gate_instance_enable: () => ({
        ...heldPreview(true),
        operationsToImport: [
          {
            name: 'stock.reserve',
            mode: 'execute',
            blastRadius: 'medium',
            autoApprovable: false,
            pendingDraft: { rewritable: false, fromGate: false },
          },
        ],
      }),
    });
    renderPage(http, 'operations', 'gk-1::stock.reserve');
    const notice = await screen.findByTestId('operation-gate-owned-params');
    await waitFor(() => expect(notice.textContent).toContain('提议者去掉这些参数后重新提议'));
    expect(notice.textContent).not.toContain('门的清单还没改');
    expect(screen.queryByTestId('operation-gate-owned-rewrite')).toBeNull();
    expect(screen.queryByTestId('operation-gate-owned-rewrite-waiting')).toBeNull();
  });

  it('review #501 on #571 ①: when the gate no longer announces the Operation, nothing can be rewritten and the text says so', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { ...HELD_DRAFT, gateOwnedParams: [{ param: 'Authorization', location: 'header' }] },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [LINKED_INSTANCE] }),
      preview_gate_instance_enable: () => ({ ...heldPreview(false), operationsToImport: [] }),
    });
    renderPage(http, 'operations', 'gk-1::stock.reserve');
    const notice = await screen.findByTestId('operation-gate-owned-params');
    await waitFor(() => expect(notice.textContent).toContain('门的当前清单里已经没有这个'));
    expect(notice.textContent).not.toContain('门的清单还没改');
    expect(screen.queryByTestId('operation-gate-owned-rewrite')).toBeNull();
  });

  it('legacy 278: a held draft the gate no longer announces points at Discard, and Discard takes it out of the catalog — kept, not deleted', async () => {
    let listed = 0;
    const http = scriptedHttp({
      list_operations: () => {
        listed += 1;
        return {
          items:
            listed === 1
              ? [
                  {
                    ...HELD_DRAFT,
                    version: 2,
                    gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
                  },
                ]
              : [],
        };
      },
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [LINKED_INSTANCE] }),
      preview_gate_instance_enable: () => ({ ...heldPreview(false), operationsToImport: [] }),
      discard_operation_draft: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          name: 'stock.reserve',
          version: 2,
          draftDigest: 'sha256:held-draft',
          reason: 'The gate dropped it.',
        });
        return { gatekeeperId: 'gk-1', name: 'stock.reserve', version: 2, status: 'discarded' };
      },
    });
    renderPage(http, 'operations', 'gk-1::stock.reserve');
    const notice = await screen.findByTestId('operation-gate-owned-params');
    await waitFor(() =>
      expect(notice.textContent).toContain(
        '草稿不会被调用。不再需要的话，可以用下面的「丢弃」把它移出目录。',
      ),
    );
    expect(notice.textContent).not.toContain('可以不管它');

    fireEvent.click(
      await screen.findByTestId('operation-discard-confirm-gk-1::stock.reserve-trigger'),
    );
    expect(http.calls.some((c) => c.name === 'discard_operation_draft')).toBe(false);
    const confirm = await screen.findByTestId('operation-discard-confirm-gk-1::stock.reserve');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('stock.reserve v2');
    // Not the other registries' "deleted for good": an Operation draft is kept and marked.
    expect(confirm.textContent).toContain('它不会被删除');
    expect(confirm.textContent).not.toContain('无法恢复');
    fireEvent.change(within(confirm).getByRole('textbox'), {
      target: { value: 'The gate dropped it.' },
    });
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'discard_operation_draft')).toBe(true),
    );
    await waitFor(() => expect(listed).toBe(2));
  });

  it.each([
    ['the owner, on a gate-imported draft', 'owner', 'p-owner', true],
    ['a builder, on a draft they proposed', 'builder', 'p-me', true],
    ['a builder, on the owner’s imported draft', 'builder', 'p-owner', false],
    ['a member', 'member', 'p-me', false],
  ] as const)(
    'legacy 278: Discard on an Operation draft for %s → offered: %s',
    async (_label, role, proposedBy, offered) => {
      const http = scriptedHttp({
        get_workspace: () => ({
          id: 'ws-1',
          name: 'Acme',
          createdAt: '2026-01-01T00:00:00Z',
          principalCount: 3,
          gatekeeperCount: 1,
          caller: { id: 'p-me', role, displayName: 'Me', kind: 'human' },
        }),
        list_operations: () => ({
          items: [{ ...HELD_DRAFT, version: 1, proposedBy }],
        }),
        get_operation_stats: () => ({ items: [] }),
      });
      renderPage(http);
      const row = await screen.findByTestId('catalog-row');
      await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
      const detail = await selectRow(row);
      await waitFor(() =>
        expect(
          within(detail).queryByTestId('operation-discard-confirm-gk-1::stock.reserve-trigger') !==
            null,
        ).toBe(offered),
      );
    },
  );

  it('review #493 on #583: a draft revised since it was listed is not discarded — the toast says nothing was written and the catalog reloads it', async () => {
    let listed = 0;
    const http = scriptedHttp({
      list_operations: () => {
        listed += 1;
        return { items: [{ ...HELD_DRAFT, version: 1, proposedBy: 'p-owner' }] };
      },
      get_operation_stats: () => ({ items: [] }),
      discard_operation_draft: () =>
        Promise.reject(
          new HttpError('capability_error', 'changed after it was read', 'draft_changed'),
        ),
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    fireEvent.click(
      await within(detail).findByTestId('operation-discard-confirm-gk-1::stock.reserve-trigger'),
    );
    const confirm = await screen.findByTestId('operation-discard-confirm-gk-1::stock.reserve');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toContain('这份草稿在你查看之后被修改过，本次没有写入任何内容');
    await waitFor(() => expect(listed).toBe(2));
  });

  it('review #493 on #583: Publish sends the draftDigest of the draft shown', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'docker.restart',
            status: 'draft',
            version: 1,
            draftDigest: 'sha256:shown',
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: () => ({}),
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    fireEvent.click(within(detail).getByRole('button', { name: /发布/ }));
    await waitFor(() =>
      expect(http.calls.find((c) => c.name === 'publish_operation')?.params).toEqual({
        gatekeeperId: 'gk-1',
        name: 'docker.restart',
        draftDigest: 'sha256:shown',
      }),
    );
  });

  it('UX acceptance of #583 (P3-2): a held draft of an Operation the gate dropped (not yet adopted) reads as gone — no rewrite offered', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { ...HELD_DRAFT, gateOwnedParams: [{ param: 'Authorization', location: 'header' }] },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [LINKED_INSTANCE] }),
      preview_gate_instance_enable: () => ({
        ...heldPreview(false),
        awaitingPlatformAdoption: {
          announcedAt: '2026-10-16T00:00:00Z',
          operations: ['stock.reserve'],
          dropped: ['stock.reserve'],
        },
      }),
    });
    renderPage(http, 'operations', 'gk-1::stock.reserve');
    const notice = await screen.findByTestId('operation-gate-owned-params');
    await waitFor(() => expect(notice.textContent).toContain('门的当前清单里已经没有这个'));
    expect(notice.textContent).not.toContain('门的清单还没改');
    expect(screen.queryByTestId('operation-gate-owned-rewrite')).toBeNull();
  });

  it('legacy 278: a published Operation is never offered Discard (it is deprecated instead)', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published', version: 1 }],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    expect(within(detail).getByRole('button', { name: /弃用/ })).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: /丢弃/ })).toBeNull();
  });

  it('review #501 on #573: a rewrite that would change other fields but keep the gate-owned param stays greyed out', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { ...HELD_DRAFT, gateOwnedParams: [{ param: 'Authorization', location: 'header' }] },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [LINKED_INSTANCE] }),
      preview_gate_instance_enable: () => {
        const preview = heldPreview(false);
        return {
          ...preview,
          operationsToImport: preview.operationsToImport.map((row) => ({
            ...row,
            blastRadius: 'high',
            pendingDraft: { rewritable: true, fromGate: true },
          })),
        };
      },
    });
    renderPage(http, 'operations', 'gk-1::stock.reserve');
    await screen.findByTestId('operation-gate-owned-rewrite-waiting');
    const rewrite = screen.getByTestId('operation-gate-owned-rewrite') as HTMLButtonElement;
    expect(rewrite.disabled).toBe(true);
  });

  it('UX acceptance of #573 P3-1: a proposed name the gate never announced is a proposal, not one the gate stopped announcing', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'refunds.lookup',
            status: 'draft',
            origin: 'human',
            gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [LINKED_INSTANCE] }),
      preview_gate_instance_enable: () => ({ ...heldPreview(false), operationsToImport: [] }),
    });
    renderPage(http, 'operations', 'gk-1::refunds.lookup');
    const notice = await screen.findByTestId('operation-gate-owned-params');
    await waitFor(() => expect(notice.textContent).toContain('提议者去掉这些参数后重新提议'));
    expect(notice.textContent).not.toContain('门的当前清单里已经没有这个');
    expect(screen.queryByTestId('operation-gate-owned-rewrite')).toBeNull();
  });

  it('UX acceptance of #571 P3-2: rows of one Operation listed more than once say their version; a single row does not', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { gatekeeperId: 'gk-1', name: 'stock.get', status: 'published', version: 3 },
          { gatekeeperId: 'gk-1', name: 'stock.get', status: 'deprecated', version: 2 },
          { gatekeeperId: 'gk-1', name: 'stock.get', status: 'deprecated', version: 1 },
          { gatekeeperId: 'gk-1', name: 'orders.list', status: 'published', version: 1 },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findAllByTestId('catalog-row');
    expect(screen.getByTestId('catalog-row-version-gk-1::stock.get').textContent).toBe('v3');
    expect(screen.getByTestId('catalog-row-version-gk-1::stock.get@v2').textContent).toBe('v2');
    expect(screen.getByTestId('catalog-row-version-gk-1::stock.get@v1').textContent).toBe('v1');
    expect(screen.queryByTestId('catalog-row-version-gk-1::orders.list')).toBeNull();
  });

  it('review #501 on #571 ②: two gates with the same display name are told apart in the list’s gate label', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { gatekeeperId: 'gk-1', name: 'orders.lookup', status: 'draft' },
          { gatekeeperId: 'gk-2', name: 'orders.lookup', status: 'draft' },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_gatekeepers: () => ({
        items: [
          { id: 'gk-1', name: 'orders' },
          { id: 'gk-2', name: 'orders' },
        ],
      }),
    });
    renderPage(http);
    await waitFor(() =>
      expect(
        within(screen.getByTestId('catalog-row-gate-gk-1::orders.lookup')).queryByTestId(
          'same-name-id',
        ),
      ).not.toBeNull(),
    );
    const first = screen.getByTestId('catalog-row-gate-gk-1::orders.lookup');
    const second = screen.getByTestId('catalog-row-gate-gk-2::orders.lookup');
    expect(first.textContent).toContain('orders');
    expect(within(second).getByTestId('same-name-id')).toBeTruthy();
    expect(first.textContent).not.toBe(second.textContent);
  });

  it('legacy 214: on a gate the workspace connected itself, the held draft is rewritten from what the gate describes now', async () => {
    const refreshes: Record<string, unknown>[] = [];
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'stock.reserve',
            status: 'draft',
            origin: 'import',
            gateOwnedParams: [{ param: 'access_token', location: 'query' }],
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [] }),
      preview_gatekeeper_resync: () => ({
        gatekeeperId: 'gk-1',
        manifestDigest: 'digest-1',
        operationsToImport: [
          {
            name: 'stock.reserve',
            mode: 'execute',
            blastRadius: 'medium',
            autoApprovable: false,
            pendingDraft: { rewritable: true, fromGate: true },
          },
        ],
        operationsAlreadyPresent: [],
        notDescribed: [],
      }),
      refresh_operation_governance: (params) => {
        refreshes.push(params as Record<string, unknown>);
        return {
          gatekeeperId: 'gk-1',
          refreshed: [],
          revisionDrafts: [{ name: 'stock.reserve', version: 1 }],
          unchanged: [],
        };
      },
    });
    // The same key the bulk publish's held-drafts notice links to.
    renderPage(http, 'operations', 'gk-1::stock.reserve');
    const notice = await screen.findByTestId('operation-gate-owned-params');
    await waitFor(() => expect(notice.textContent).toContain('重启门'));
    expect(notice.textContent).not.toContain('重新接入');
    expect(notice.textContent).not.toContain('与门公告对齐');
    fireEvent.click(await screen.findByTestId('operation-gate-owned-resync'));
    const confirm = await screen.findByTestId('operation-gate-owned-resync-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(refreshes).toHaveLength(1));
    expect(refreshes[0]).toEqual({
      gatekeeperId: 'gk-1',
      operationNames: ['stock.reserve'],
      manifestDigest: 'digest-1',
    });
  });

  it('legacy 214: a proposal on a self-connected gate is never offered the re-read', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'stock.reserve',
            status: 'draft',
            origin: 'agent',
            gateOwnedParams: [{ param: 'access_token', location: 'query' }],
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      list_available_gate_instances: () => ({ items: [] }),
    });
    renderPage(http, 'operations', 'gk-1::stock.reserve');
    const notice = await screen.findByTestId('operation-gate-owned-params');
    await waitFor(() => expect(notice.textContent).toContain('agent 或成员提议的'));
    expect(screen.queryByTestId('operation-gate-owned-resync')).toBeNull();
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
              before: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
              after: governanceFields({
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
              }),
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
                  before: governanceFields({
                    mode: 'observe',
                    blastRadius: 'low',
                    autoApprovable: true,
                  }),
                  after: governanceFields({
                    mode: 'observe',
                    blastRadius: 'low',
                    autoApprovable: true,
                  }),
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

  it('Workers tab: names the gates a Worker acts on, linked to each gate (legacy 441)', async () => {
    const http = scriptedHttp({
      list_worker_definitions: () => ({
        items: [
          {
            id: 'wd-1',
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Fixer', gates: ['gk-1', 'gk-gone'] },
          },
          {
            id: 'wd-2',
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Idle' },
          },
        ],
      }),
      list_gatekeepers: () => ({ items: [{ id: 'gk-1', name: 'prod-docker' }] }),
    });
    renderPage(http, 'workers');
    const [fixer, idle] = await screen.findAllByTestId('catalog-row');
    const detail = await selectRow(fixer as HTMLElement);
    const gates = await within(detail).findByTestId('worker-detail-gates');
    await waitFor(() => expect(gates.textContent).toContain('prod-docker'));
    const link = within(gates).getByRole('link', { name: /prod-docker/ });
    expect(link.getAttribute('href')).toBe('#/govern/systems/gk-1');
    // A gate the directory does not know still shows, unlinked, by its id.
    expect(gates.querySelectorAll('a')).toHaveLength(1);
    expect(gates.textContent).toContain('gk-gone');
    const none = await selectRow(idle as HTMLElement);
    expect(within(none).getByTestId('worker-detail-gates-none').textContent).toMatch(
      /不能对任何系统动手/,
    );
  });

  it('Workers tab: an entry definition reads field by field, not only as JSON (legacy 472)', async () => {
    const http = scriptedHttp({
      list_worker_definitions: () => ({
        items: [
          {
            id: 'wd-entry',
            version: 2,
            kind: 'entry',
            status: 'published',
            definition: {
              systemPrompt: 'You are the entry agent.\nAnswer briefly.',
              capabilities: ['propose_goal', 'own_tool'],
              egressDeny: ['internal.example'],
            },
          },
        ],
      }),
    });
    renderPage(http, 'workers');
    const [entry] = await screen.findAllByTestId('catalog-row');
    const detail = await selectRow(entry as HTMLElement);
    expect(within(detail).getByTestId('worker-detail-prompt').textContent).toMatch(
      /^2 行，点开查看You are the entry agent\./,
    );
    expect(within(detail).getByTestId('worker-detail-model-default').textContent).toBe(
      '没有指定，使用工作区默认模型',
    );
    const capabilities = within(detail).getByTestId('worker-detail-capabilities');
    expect(capabilities.querySelector('[data-capability="propose_goal"]')?.textContent).toMatch(
      /^提议目标 propose_goal$/,
    );
    // A name the console has no words for shows as itself, once.
    expect(capabilities.querySelector('[data-capability="own_tool"]')?.textContent).toBe(
      'own_tool',
    );
    expect(detail.textContent).toContain('能做的事（2）');
    expect(within(detail).getByTestId('worker-detail-egress').textContent).toBe('internal.example');
  });

  it("Workers tab: the entry version in use and a Worker's newest version read apart (legacy 481)", async () => {
    const entry = (version: number, publishedAt: string) => ({
      id: 'wd-entry',
      version,
      kind: 'entry',
      status: 'published',
      publishedAt,
      definition: { systemPrompt: `v${version}` },
    });
    const worker = (id: string, version: number) => ({
      id,
      version,
      kind: 'worker',
      status: 'published',
      publishedAt: '2026-10-01T00:00:00.000Z',
      definition: { name: id },
    });
    const http = scriptedHttp({
      list_worker_definitions: () => ({
        items: [
          entry(1, '2026-10-01T00:00:00.000Z'),
          entry(3, '2026-10-03T00:00:00.000Z'),
          entry(2, '2026-10-02T00:00:00.000Z'),
          worker('wd-w', 1),
          worker('wd-w', 2),
          worker('wd-x', 1),
        ],
      }),
    });
    renderPage(http, 'workers');
    const entryList = await screen.findByTestId('workers-entry-list');
    const entryRows = within(entryList).getAllByTestId('catalog-row');
    const byVersion = (version: number) =>
      entryRows.find((row) => row.textContent?.includes(`v${version}`)) as HTMLElement;
    // Only the most recently published entry version is in use.
    expect(within(byVersion(3)).getByTestId('worker-in-use').textContent).toBe('生效中');
    expect(within(entryList).getAllByTestId('worker-in-use')).toHaveLength(1);
    for (const version of [1, 2]) {
      expect(within(byVersion(version)).getByTestId('worker-not-in-use').textContent).toBe(
        ' · 未生效',
      );
    }
    const old = await selectRow(byVersion(1));
    expect(within(old).getByTestId('worker-detail-not-in-use').textContent).toMatch(
      /入口 agent 用的是最近发布的 v3/,
    );
    fireEvent.click(within(old).getByTestId('worker-detail-open-in-use'));
    const inUse = await screen.findByTestId('worker-detail-in-use');
    const opened = inUse.closest('[data-worker-key]') as HTMLElement;
    expect(opened.getAttribute('data-worker-key')).toBe('wd-entry@3');
    // UX acceptance of #763 (P2-1): focus on the opened version's title, not the page.
    await waitFor(() =>
      expect(document.activeElement).toBe(opened.querySelector('.catalog-detail-title')),
    );

    const workerList = screen.getByTestId('catalog-list');
    const marks = within(workerList)
      .getAllByTestId('catalog-row')
      .map((row) => [
        row.textContent?.match(/wd-[wx]/)?.[0],
        row.querySelector('[data-testid="worker-family-version"]')?.textContent ?? null,
      ]);
    expect(marks).toEqual([
      ['wd-w', ' · 较早版本'],
      ['wd-w', ' · 最新版'],
      ['wd-x', null],
    ]);
    const earlier = await selectRow(
      within(workerList).getAllByTestId('catalog-row')[0] as HTMLElement,
    );
    expect(within(earlier).getByTestId('worker-detail-earlier-version').textContent).toMatch(
      /更新的已发布版本 v2/,
    );
    fireEvent.click(within(earlier).getByTestId('worker-detail-open-latest'));
    await waitFor(() => {
      const title = document.activeElement as HTMLElement;
      expect(title.classList.contains('catalog-detail-title')).toBe(true);
      expect(title.closest('[data-worker-key]')?.getAttribute('data-worker-key')).toBe('wd-w@2');
    });
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

  // Legacy 420: the kernel reads a description out masked; the detail says what `[redacted]` is,
  // and the edit box, which opens on that masked text, says the original is not filled back in.
  it('Operations: a masked description is explained in the detail and in the edit dialog', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'docker.restart',
            status: 'published',
            description: 'restarts it; call with Authorization: [redacted]',
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    expect(within(detail).getByTestId('catalog-detail-description-redacted').textContent).toContain(
      '[redacted] 处的内容看起来像密码',
    );
    fireEvent.click(within(detail).getByTestId('operation-edit-description-gk-1::docker.restart'));
    const dialog = await screen.findByTestId('operation-description-dialog');
    expect(within(dialog).getByTestId('operation-description-redacted').textContent).toContain(
      '原文不会填回来',
    );
  });

  it('Operations: a description refused for a credential says so on the field', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [{ gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published' }],
      }),
      get_operation_stats: () => ({ items: [] }),
      update_operation_description: () => {
        throw new HttpError(
          'capability_error',
          'description carries 1 credential',
          'credentials_in_text',
        );
      },
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByTestId('operation-edit-description-gk-1::docker.restart'));
    const dialog = await screen.findByTestId('operation-description-dialog');
    fireEvent.change(within(dialog).getByTestId('operation-description-textarea'), {
      target: { value: 'call it with TOKEN=abcdefghijklmnopqrstuvwxyz0123' },
    });
    fireEvent.click(within(dialog).getByTestId('operation-description-save'));
    await waitFor(() => expect(within(dialog).getByText(/描述里看起来带了凭据/)).toBeTruthy());
  });

  it('Operations: a description sent back with [redacted] in it is refused on the field (legacy 420)', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'docker.restart',
            status: 'published',
            description: 'restarts it; call with PGPASSWORD=[redacted]',
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      update_operation_description: () => {
        throw new HttpError(
          'capability_error',
          'description: the text still holds [redacted]',
          'redacted_text_submitted',
        );
      },
    });
    renderPage(http);
    const row = await screen.findByTestId('catalog-row');
    const detail = await selectRow(row);
    fireEvent.click(within(detail).getByTestId('operation-edit-description-gk-1::docker.restart'));
    const dialog = await screen.findByTestId('operation-description-dialog');
    // Prefilled with the description as read: the person rewrites only the masked part.
    expect(
      (within(dialog).getByTestId('operation-description-textarea') as HTMLTextAreaElement).value,
    ).toBe('restarts it; call with PGPASSWORD=[redacted]');
    fireEvent.click(within(dialog).getByTestId('operation-description-save'));
    await waitFor(() =>
      expect(
        within(dialog).getByText(
          /没有保存：描述里还留着 \[redacted\]。把这一段重新写成不带凭据的说明再保存。/,
        ),
      ).toBeTruthy(),
    );
    // UX P3 on #691: focus goes back to the box the error is about, not to the page.
    expect(document.activeElement).toBe(
      within(dialog).getByTestId('operation-description-textarea'),
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
    await within(dialog).findByText(/这一步只能由提议人或工作区所有者来做/);
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
  // raw UUID; legacy 472: it reads as 「入口 agent」, not 「未命名 · <short id>」.
  it('Workers tab: an unnamed entry definition reads as the entry agent, never the raw UUID (legacy 472)', async () => {
    const uuid = 'f96d762e-6111-4a10-a699-66b8ae46c622';
    const http = scriptedHttp({
      list_worker_definitions: () => ({
        items: [{ id: uuid, version: 1, kind: 'entry', status: 'published', definition: {} }],
      }),
    });
    renderPage(http, 'workers');
    const entrySection = await screen.findByTestId('workers-entry-section');
    const row = within(entrySection).getByTestId('catalog-row');
    expect(row.textContent).toMatch(/入口 agent/);
    expect(row.textContent).not.toMatch(/未命名/);
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
        version: 1,
      }),
    );
  });

  it('legacy 300: Publish names the Skill version shown; a newer one since is not published — the toast says so and the list reloads', async () => {
    let listed = 0;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_skills: () => {
        listed += 1;
        return {
          items: [{ id: 'sk-9', version: 2, status: 'draft', name: 'rotate', description: 'd' }],
        };
      },
      get_skill: () => null,
      publish_skill: () =>
        Promise.reject(
          new HttpError('capability_error', 'is at v3 now, not the v2', 'version_changed'),
        ),
    });
    renderPage(http, 'skills');
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toContain('在你查看之后它有了新版本，本次没有写入任何内容');
    expect(http.calls.find((c) => c.name === 'publish_skill')?.params).toEqual({
      skillId: 'sk-9',
      version: 2,
    });
    await waitFor(() => expect(listed).toBe(2));
  });

  it('legacy 300: Publish names the Procedure version shown', async () => {
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_procedures: () => ({
        items: [{ id: 'pr-9', version: 4, status: 'draft', name: 'deploy', description: 'd' }],
      }),
      get_procedure: () => null,
      publish_procedure: () => ({ id: 'pr-9', version: 4, status: 'published' }),
    });
    renderPage(http, 'procedures');
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    await waitFor(() =>
      expect(http.calls.find((c) => c.name === 'publish_procedure')?.params).toEqual({
        procedureId: 'pr-9',
        version: 4,
      }),
    );
  });

  it('UX acceptance of #722 (P2-1): a publish refused because the plan it makes does not pass lists why next to Publish, focused', async () => {
    let attempts = 0;
    const http = scriptedHttp({
      get_workspace: () => OWNER_WORKSPACE,
      list_procedures: () => ({
        items: [
          {
            id: 'pr-9',
            version: 2,
            status: 'draft',
            name: 'stock-check',
            description: 'd',
            steps: [],
          },
        ],
      }),
      publish_procedure: () => {
        attempts += 1;
        throw new HttpError('capability_error', 'invalid params', 'invalid_params', {
          problems: [
            'step "scan": bindings[2]: path "zone": the parameters schema does not declare "zone" in the parameters',
            'the plan it makes: step "apply": bindings[0]: takes from step "missing", which this step does not depend on — add it to dependsOn',
            'something the console does not know',
          ],
        });
      },
    });
    renderPage(http, 'procedures');
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    const problems = await within(detail).findByTestId('procedure-publish-problems');
    expect(problems.getAttribute('role')).toBe('alert');
    await waitFor(() => expect(document.activeElement).toBe(problems));
    expect(problems.textContent).toMatch(/生成不了目标的计划，所以没有发布/);
    expect(
      within(problems)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringMatching(
        /^步骤 scan 的第 3 个绑定：路径 zone 取不到值：启动参数里没有声明 zone$/,
      ),
      expect.stringMatching(/^步骤 apply 的第 1 个绑定：取自步骤 missing/),
      'something the console does not know',
    ]);
    // Said here, not as a failure toast.
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(attempts).toBe(1);
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
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'docker.restart',
            status: 'draft',
            draftDigest: 'sha256:d1',
          },
        ],
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
      { gatekeeperId: 'gk-1', name: 'docker.restart', draftDigest: 'sha256:d1' },
      {
        gatekeeperId: 'gk-1',
        name: 'docker.restart',
        credentialsReviewed: true,
        draftDigest: 'sha256:d1',
      },
    ]);
  });

  it('legacy 174: a gate re-import that rewrites the draft drops the tick given for the old one', async () => {
    const seen: unknown[] = [];
    let digest = 'sha256:d1';
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { gatekeeperId: 'gk-1', name: 'docker.restart', status: 'draft', draftDigest: digest },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: (params) => {
        seen.push(params);
        if (seen.length === 1) return Promise.reject(refusal('operation', 1));
        if (seen.length === 2) {
          // The draft was rewritten in place between the question and the retry.
          digest = 'sha256:d2';
          return Promise.reject(
            new HttpError('capability_error', 'changed after it was read', 'draft_changed'),
          );
        }
        return {};
      },
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    const publish = () => fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    publish();
    await within(detail).findByTestId('credential-review');
    fireEvent.click(within(detail).getByTestId('credential-review-confirm'));
    publish();
    // The list reloads with the new draft: the question about the old one, and its tick, are gone.
    await waitFor(() => expect(within(detail).queryByTestId('credential-review')).toBeNull());
    publish();
    await waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[1]).toMatchObject({ credentialsReviewed: true, draftDigest: 'sha256:d1' });
    expect(seen[2]).toEqual({
      gatekeeperId: 'gk-1',
      name: 'docker.restart',
      draftDigest: 'sha256:d2',
    });
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
      expect(seen).toEqual([
        { skillId: 'sk-9', version: 2 },
        { skillId: 'sk-9', version: 2, credentialsReviewed: true },
      ]),
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

// S11 「门确认不存在」 B-a: an observe draft that declares answers meaning "does not exist" publishes
// only with the person's confirmation that the gate's credentials can see what it looks up. The
// row says the draft declares some, so the question is in front of Publish before the first click.
describe('CatalogPage — confirming the answers that mean “not there” on Publish', () => {
  const declaringDraft = (digest: string) => ({
    gatekeeperId: 'gk-1',
    name: 'record.get',
    status: 'draft',
    mode: 'observe',
    blastRadius: 'low',
    autoApprovable: true,
    absentAnswers: { statuses: [404] },
    draftDigest: digest,
  });

  it('asks before the click, keeps Publish disabled until it is ticked, and sends absentAnswersReviewed', async () => {
    const seen: unknown[] = [];
    const http = scriptedHttp({
      list_operations: () => ({ items: [declaringDraft('sha256:r1')] }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: (params) => {
        seen.push(params);
        return {};
      },
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    const review = within(detail).getByTestId('operation-absent-review');
    expect(review.textContent).toContain('发布前确认：目标回答 404 时，记为“要查的东西不存在”。');
    expect(review.textContent).toContain('没有权限、地址或代理配错');
    const publish = within(detail).getByRole('button', { name: /^发布$/ }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    // Nothing is recorded on a draft: the confirmation belongs to the published version.
    expect(within(detail).queryByTestId('catalog-detail-absent-reviewed')).toBeNull();
    expect(within(detail).queryByTestId('catalog-detail-absent-unreviewed')).toBeNull();

    fireEvent.click(within(detail).getByTestId('operation-absent-review-confirm'));
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({
      gatekeeperId: 'gk-1',
      name: 'record.get',
      absentAnswersReviewed: true,
      draftDigest: 'sha256:r1',
    });
  });

  it('a refusal the row did not predict (an older read) opens the same question, and the retry carries the tick', async () => {
    const seen: unknown[] = [];
    const http = scriptedHttp({
      // The row read before the gate added the declaration: it says nothing about one.
      list_operations: () => ({
        items: [
          { gatekeeperId: 'gk-1', name: 'record.get', status: 'draft', draftDigest: 'sha256:r1' },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: (params) => {
        seen.push(params);
        if (seen.length === 1) {
          return Promise.reject(
            new HttpError(
              'capability_error',
              'confirm the answers that mean "does not exist"',
              'absent_answers_review_required',
              { absentAnswers: { exitCodes: [4] } },
            ),
          );
        }
        return {};
      },
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    expect(within(detail).queryByTestId('operation-absent-review')).toBeNull();
    fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    const review = await within(detail).findByTestId('operation-absent-review');
    expect(review.textContent).toContain('命令以退出码 4 结束时，记为“要查的东西不存在”');
    expect(screen.queryByTestId('toast')).toBeNull();
    const publish = within(detail).getByRole('button', { name: /^发布$/ }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    fireEvent.click(within(detail).getByTestId('operation-absent-review-confirm'));
    fireEvent.click(publish);
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      { gatekeeperId: 'gk-1', name: 'record.get', draftDigest: 'sha256:r1' },
      {
        gatekeeperId: 'gk-1',
        name: 'record.get',
        absentAnswersReviewed: true,
        draftDigest: 'sha256:r1',
      },
    ]);
  });

  it('a gate re-import that rewrites the draft drops the tick given for the old one', async () => {
    let digest = 'sha256:r1';
    const http = scriptedHttp({
      list_operations: () => ({ items: [declaringDraft(digest)] }),
      get_operation_stats: () => ({ items: [] }),
      publish_operation: () => {
        digest = 'sha256:r2';
        return Promise.reject(
          new HttpError('capability_error', 'changed after it was read', 'draft_changed'),
        );
      },
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    const confirm = () =>
      within(detail).getByTestId('operation-absent-review-confirm') as HTMLInputElement;
    fireEvent.click(confirm());
    expect(confirm().checked).toBe(true);
    fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'list_operations')).toHaveLength(2),
    );
    await waitFor(() => expect(confirm().checked).toBe(false));
    expect(
      (within(detail).getByRole('button', { name: /^发布$/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('a published version says who confirmed its answers and when, or that nobody did', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          {
            gatekeeperId: 'gk-1',
            name: 'record.get',
            status: 'published',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
            absentAnswers: { statuses: [404] },
            absentAnswersReview: { reviewedBy: 'p-owner', reviewedAt: '2026-10-24T01:00:00Z' },
          },
          {
            gatekeeperId: 'gk-1',
            name: 'unit.show',
            status: 'published',
            mode: 'observe',
            blastRadius: 'low',
            autoApprovable: true,
            absentAnswers: { exitCodes: [4] },
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      resolve_refs: () => ({ items: [{ id: 'p-owner', kind: 'principal', name: 'Owner' }] }),
    });
    renderPage(http);
    const rowNamed = async (name: string) => {
      const row = (await screen.findAllByTestId('catalog-row')).find((candidate) =>
        candidate.textContent?.includes(name),
      );
      if (!row) throw new Error(`${name} row missing`);
      return row;
    };
    let detail = await selectRow(await rowNamed('record.get'));
    const reviewed = within(detail).getByTestId('catalog-detail-absent-reviewed');
    await waitFor(() => expect(reviewed.textContent).toContain('Owner'));
    expect(reviewed.textContent).toContain('发布时确认');
    expect(reviewed.textContent).toContain('门用的凭据看得到要查的东西');
    expect(within(detail).queryByTestId('operation-absent-review')).toBeNull();

    detail = await selectRow(await rowNamed('unit.show'));
    expect(within(detail).getByTestId('catalog-detail-absent-unreviewed').textContent).toContain(
      '发布于需要确认之前',
    );
    expect(within(detail).queryByTestId('catalog-detail-absent-reviewed')).toBeNull();
  });
});

// D-24 (kernel governance/capability/publish-authority.ts): publish_* / deprecate_* on a row
// another principal proposed is refused 403 not_proposer unless the caller is the owner — the
// catalog does not offer it to a builder there, and says why in its place.
describe('CatalogPage — proposer-only Publish / Deprecate (D-24)', () => {
  function workspaceAs(role: string, callerId = 'p-me') {
    return () => ({
      id: 'ws-1',
      name: 'Acme',
      createdAt: '2026-01-01T00:00:00Z',
      principalCount: 3,
      gatekeeperCount: 1,
      caller: { id: callerId, role, displayName: 'Me', kind: 'human' },
    });
  }
  const refs = () => ({ items: [] });

  it.each([
    ['the owner, on a draft someone else proposed', 'owner', 'draft', 'p-other', true],
    ['a builder, on their own draft', 'builder', 'draft', 'p-me', true],
    ['a builder, on another principal’s draft', 'builder', 'draft', 'p-other', false],
    ['the owner, on a published row someone else proposed', 'owner', 'published', 'p-other', true],
    ['a builder, on their own published row', 'builder', 'published', 'p-me', true],
    ['a builder, on another principal’s published row', 'builder', 'published', 'p-other', false],
  ] as const)(
    'Operations: Publish / Deprecate for %s → offered: %s',
    async (_label, role, status, proposedBy, offered) => {
      const http = scriptedHttp({
        get_workspace: workspaceAs(role),
        list_operations: () => ({
          items: [{ gatekeeperId: 'gk-1', name: 'docker.restart', status, proposedBy }],
        }),
        get_operation_stats: () => ({ items: [] }),
        resolve_refs: refs,
      });
      renderPage(http);
      const row = await screen.findByTestId('catalog-row');
      await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
      const detail = await selectRow(row);
      const action = status === 'draft' ? /^发布$/ : /^弃用/;
      await waitFor(() =>
        expect(within(detail).queryByRole('button', { name: action }) !== null).toBe(offered),
      );
      const hint = within(detail).queryByTestId('catalog-proposer-only');
      expect(hint !== null).toBe(!offered);
      if (hint) {
        expect(hint.textContent).toMatch(status === 'draft' ? /提议人.*发布/ : /提议人.*弃用/);
      }
    },
  );

  it('Operations: with the role still unknown, Publish stays offered (the kernel decides)', async () => {
    const http = scriptedHttp({
      list_operations: () => ({
        items: [
          { gatekeeperId: 'gk-1', name: 'docker.restart', status: 'draft', proposedBy: 'p-x' },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      resolve_refs: refs,
    });
    renderPage(http);
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    expect(within(detail).getByRole('button', { name: /^发布$/ })).toBeTruthy();
    expect(within(detail).queryByTestId('catalog-proposer-only')).toBeNull();
  });

  it('Operations: a builder’s own revision draft over a live version someone else proposed is not offered Publish', async () => {
    const http = scriptedHttp({
      get_workspace: workspaceAs('builder'),
      list_operations: () => ({
        items: [
          { gatekeeperId: 'gk-1', name: 'docker.restart', status: 'published', proposedBy: 'p-o' },
          {
            gatekeeperId: 'gk-1',
            name: 'docker.restart',
            status: 'draft',
            version: 2,
            proposedBy: 'p-me',
            governanceChange: {
              before: governanceFields({
                mode: 'execute',
                blastRadius: 'low',
                autoApprovable: false,
              }),
              after: governanceFields({
                mode: 'execute',
                blastRadius: 'low',
                autoApprovable: false,
              }),
              direction: 'neutral',
            },
          },
        ],
      }),
      get_operation_stats: () => ({ items: [] }),
      resolve_refs: refs,
    });
    renderPage(http, 'operations', 'gk-1::docker.restart@draft');
    const detail = await screen.findByTestId('catalog-detail');
    await waitFor(() => expect(within(detail).getByTestId('catalog-proposer-only')).toBeTruthy());
    expect(within(detail).getByTestId('catalog-proposer-only').textContent).toMatch(/替换/);
    expect(within(detail).queryByRole('button', { name: /发布/ })).toBeNull();
  });

  it('Skills: a builder reviewing another principal’s draft gets the reason, not Publish', async () => {
    const http = scriptedHttp({
      get_workspace: workspaceAs('builder'),
      list_skills: () => ({
        items: [
          {
            id: 'sk-1',
            version: 1,
            status: 'draft',
            name: 'n',
            description: 'd',
            proposedBy: 'p-o',
          },
        ],
      }),
      get_skill: () => null,
      resolve_refs: refs,
    });
    renderPage(http, 'skills');
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    await waitFor(() =>
      expect(within(detail).getByTestId('catalog-proposer-only').textContent).toMatch(/发布/),
    );
    expect(within(detail).queryByRole('button', { name: /^发布$/ })).toBeNull();
  });

  it('Procedures: a builder on another principal’s published Procedure gets the reason, not Deprecate', async () => {
    const http = scriptedHttp({
      get_workspace: workspaceAs('builder'),
      list_procedures: () => ({
        items: [
          {
            id: 'pr-1',
            version: 1,
            status: 'published',
            name: 'n',
            description: 'd',
            steps: [],
            proposedBy: 'p-o',
          },
        ],
      }),
      resolve_refs: refs,
    });
    renderPage(http, 'procedures');
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    await waitFor(() =>
      expect(within(detail).getByTestId('catalog-proposer-only').textContent).toMatch(/弃用/),
    );
    expect(within(detail).queryByRole('button', { name: /弃用/ })).toBeNull();
  });

  it('Workers: a builder on another principal’s published definition gets the reason, not Deprecate', async () => {
    const http = scriptedHttp({
      get_workspace: workspaceAs('builder'),
      list_worker_definitions: () => ({
        items: [
          {
            id: 'wd-1',
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Fixer' },
            proposedBy: 'p-o',
          },
        ],
      }),
    });
    renderPage(http, 'workers');
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    const detail = await selectRow(await screen.findByTestId('catalog-row'));
    await waitFor(() =>
      expect(within(detail).getByTestId('catalog-proposer-only').textContent).toMatch(/弃用/),
    );
    expect(within(detail).queryByRole('button', { name: /弃用/ })).toBeNull();
  });

  it.each([
    ['a builder, over a published version someone else proposed', 'builder', 'p-o', false],
    ['a builder, over their own published version', 'builder', 'p-me', true],
    ['the owner, over a published version someone else proposed', 'owner', 'p-o', true],
  ] as const)(
    'Workers: Publish on a new version of a family for %s → offered: %s (legacy 315)',
    async (_label, role, liveProposedBy, offered) => {
      const published = {
        id: 'wd-1',
        version: 1,
        kind: 'worker',
        status: 'published',
        definition: { name: 'Fixer' },
        proposedBy: liveProposedBy,
      };
      const draft = { ...published, version: 2, status: 'draft', proposedBy: 'p-me' };
      const http = scriptedHttp({
        get_workspace: workspaceAs(role),
        list_worker_definitions: (params) => ({
          items: (params as { includeOwnDrafts?: boolean } | undefined)?.includeOwnDrafts
            ? [published, draft]
            : [published],
        }),
      });
      renderPage(http, 'workers', 'wd-1@2');
      await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
      const detail = await screen.findByTestId('catalog-detail');
      await waitFor(() =>
        expect(within(detail).queryByRole('button', { name: /^发布/ }) !== null).toBe(offered),
      );
      const hint = within(detail).queryByTestId('catalog-proposer-only');
      expect(hint !== null).toBe(!offered);
      if (hint) expect(hint.textContent).toMatch(/替换/);
    },
  );

  it('a not_proposer refusal on Publish does not close Publish for the session', async () => {
    const http = scriptedHttp({
      list_skills: () => ({
        items: [
          { id: 'sk-1', version: 1, status: 'draft', name: 'a', description: 'd' },
          { id: 'sk-2', version: 1, status: 'draft', name: 'b', description: 'd' },
        ],
      }),
      get_skill: () => null,
      publish_skill: () =>
        Promise.reject(new HttpError('capability_error', 'proposed by another', 'not_proposer')),
    });
    renderPage(http, 'skills');
    const rows = await screen.findAllByTestId('catalog-row');
    const detail = await selectRow(rows[0] as HTMLElement);
    fireEvent.click(within(detail).getByRole('button', { name: /^发布$/ }));
    await screen.findByTestId('toast');
    const other = await selectRow(screen.getAllByTestId('catalog-row')[1] as HTMLElement);
    await waitFor(() => expect(within(other).getByRole('button', { name: /^发布$/ })).toBeTruthy());
  });
});
