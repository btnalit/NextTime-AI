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
      <ToastProvider>
        <Harness http={http} initialTab={initialTab} />
      </ToastProvider>
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
    fireEvent.click(within(row).getByRole('button', { name: /发布/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'publish_operation')).toBe(true));
    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'list_operations')).toHaveLength(2),
    );
  });

  it('C14: a failed Publish toasts the kernel message, not only the generic title', async () => {
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
    fireEvent.click(within(row).getByRole('button', { name: /发布/ }));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toContain('Could not update docker.restart');
    expect(toast.textContent).toContain('operation docker.restart is not a draft');
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
    expect(within(row).queryByRole('button', { name: /发布/ })).toBeNull();
    expect(within(row).getByRole('button', { name: /弃用/ })).toBeTruthy();
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
    fireEvent.click(within(row).getByRole('button', { name: /弃用/ }));

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
    fireEvent.click(within(row).getByRole('button', { name: /弃用/ }));

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
    expect(within(entryRow).queryByRole('button', { name: /弃用/ })).toBeNull();
    expect(within(entryRow).getByRole('button', { name: /编辑（新版本草稿）/ })).toBeTruthy();

    const workerSection = screen.getByTestId('workers-worker-section');
    const workerRow = within(workerSection).getByTestId('catalog-row');
    expect(within(workerRow).getByRole('button', { name: /弃用/ })).toBeTruthy();
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
      expect(within(rows[0]).getByText('Patcher')).toBeTruthy();
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
      fireEvent.click(within(section).getByTestId('worker-draft-publish'));

      await waitFor(() =>
        expect(http.calls.some((c) => c.name === 'publish_worker_definition')).toBe(true),
      );
      await waitFor(() => expect(screen.queryByTestId('workers-my-drafts-section')).toBeNull());
      const workerSection = screen.getByTestId('workers-worker-section');
      expect(within(workerSection).getByText('Patcher')).toBeTruthy();
    });
  });

  // S8 W2 U2 (audit J7/CW1): "从模板创建（ops-runner）" opens the editor prefilled rather than
  // inventing new template content — the button only exposes the checked-in ops-runner template
  // through the existing propose/publish path (F1).
  it('Workers tab: "从模板创建（ops-runner）" opens the editor prefilled (name ops-runner, kind worker)', async () => {
    const http = scriptedHttp({
      list_worker_definitions: () => ({ items: [] }),
      list_models: () => ({ items: [] }),
      list_capability_names: () => ({ items: [] }),
      list_gatekeepers: () => ({ items: [] }),
      list_skills: () => ({ items: [] }),
      propose_worker_definition: (params) => {
        expect(params).toEqual({
          kind: 'worker',
          definition: {
            systemPrompt: expect.stringContaining('ops-runner'),
            name: 'ops-runner',
          },
        });
        return { id: 'wd-tmpl', version: 1, status: 'draft' };
      },
    });
    renderPage(http, 'workers');
    await screen.findByTestId('workers-worker-section');
    fireEvent.click(screen.getByTestId('workers-template-button'));
    const drawer = await screen.findByTestId('worker-editor-drawer');
    expect((within(drawer).getByLabelText(/^名称/) as HTMLInputElement).value).toBe('ops-runner');
    const kindSelect = within(drawer).getByTestId('wd-kind') as HTMLSelectElement;
    expect(kindSelect.value).toBe('worker');
    expect(kindSelect.disabled).toBe(true);
    fireEvent.click(within(drawer).getByTestId('worker-submit'));
    await within(drawer).findByTestId('draft-proposed');
    expect(http.calls.some((c) => c.name === 'propose_worker_definition')).toBe(true);
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

  it('Skills: "Edit as new draft" pre-fills the row (body excluded) and says the result is a new Skill', async () => {
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
    });
    renderPage(http, 'skills');
    const row = await screen.findByTestId('catalog-row');
    fireEvent.click(within(row).getByTestId('catalog-edit-as-draft'));
    const drawer = await screen.findByTestId('skill-editor-drawer');
    expect(within(drawer).getByTestId('skill-copy-notice').textContent).toContain('新的');
    expect((within(drawer).getByLabelText(/^名称/) as HTMLInputElement).value).toBe('restart-web');
    expect((within(drawer).getByLabelText(/适用的门类型/) as HTMLInputElement).value).toBe('http');
    expect((within(drawer).getByLabelText(/SKILL.md 正文/) as HTMLTextAreaElement).value).toBe('');
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
    fireEvent.click(within(row).getByTestId('catalog-edit-as-draft'));
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
