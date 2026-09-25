// @vitest-environment jsdom
import type { ExplainResultWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { AuditRecordRow } from '../lib/audit.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { AuditPage } from './AuditPage.js';
import { ToastProvider } from './ui/Toast.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

interface Call {
  readonly name: string;
  readonly params: unknown;
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: Call[] } {
  const calls: Call[] = [];
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

const principal = { id: 'p-1', kind: 'human', role: 'owner', displayName: 'Alice' };
const source = {
  id: 'src-1',
  kind: 'http',
  uri: 'https://example.invalid/api',
  visibility: 'workspace',
  ownerPrincipal: null,
};

function factExplain(): ExplainResultWire {
  return {
    nodeType: 'fact',
    fact: {
      id: 'fact-1',
      linkType: 'runs_on',
      epistemicStatus: 'observed',
      assertedByPrincipal: principal,
      verifiedByPrincipal: null,
      observationId: 'obs-1',
      invalidatedAt: null,
      invalidationReason: null,
      lastObservation: { id: 'obs-1', createdAt: '2026-09-03T00:00:00.000Z', source },
    },
    activity: {
      id: 'act-1',
      kind: 'worker_result',
      status: 'completed',
      createdAt: '2026-09-03T00:00:00.000Z',
      endedAt: '2026-09-03T00:01:00.000Z',
      startedByPrincipal: principal,
      observations: [],
      metadata: { taskId: 'task-1', workerRunId: 'run-1' },
      onBehalfOfPrincipal: null,
    },
  };
}

function auditRow(overrides: Partial<AuditRecordRow> = {}): AuditRecordRow {
  return {
    id: 'audit-1',
    actorPrincipalId: 'p-1',
    action: 'action_request.approve',
    resourceType: 'action_request',
    resourceId: 'ar-1',
    payload: { reason: 'ok', apiKey: 'sk-1' },
    createdAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

const principalsPage = () => ({
  items: [
    { ...principal, createdAt: '2026-09-01T00:00:00.000Z', hasApiKey: true, disabledAt: null },
  ],
});

function renderPage(http: CapabilityCaller, entry?: Parameters<typeof AuditPage>[0]['entry']) {
  return render(
    <PermissionsProvider>
      <ToastProvider>
        <AuditPage http={http} entry={entry} />
      </ToastProvider>
    </PermissionsProvider>,
  );
}

function stubDownload() {
  const create = vi.fn(() => 'blob:nexttime/1');
  const url = URL as unknown as Record<string, unknown>;
  url.createObjectURL = create;
  url.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return create;
}

beforeEach(() => {
  window.location.hash = '';
});

/** AuditPage.test.tsx (C22; S6-A A4 / C27, console-completion-plan §5.5). */
describe('AuditPage entry points', () => {
  it('?nodeId= auto-runs explain and renders the Fact → Activity → Source chain with the WorkerRun links; Export calls export_prov{nodeId}', async () => {
    const create = stubDownload();
    const http = scriptedHttp({
      explain: () => factExplain(),
      export_prov: () => ({ format: 'prov-json', document: { prefix: {} } }),
      audit_query: () => ({ items: [] }),
      list_principals: principalsPage,
      list_gatekeepers: () => ({ items: [] }),
    });
    renderPage(http, { nodeId: 'fact-1' });
    const result = await screen.findByTestId('explain-result');
    expect(http.calls.find((c) => c.name === 'explain')?.params).toEqual({ nodeId: 'fact-1' });
    expect(result.getAttribute('data-node-type')).toBe('fact');
    for (const segment of ['prov-fact', 'prov-activity', 'prov-source']) {
      expect(within(result).getByTestId(segment).getAttribute('data-present')).toBe('true');
    }
    expect(within(result).getByTestId('explain-link-task').getAttribute('data-ref-id')).toBe(
      'task-1',
    );
    expect(
      within(result).getByTestId('explain-link-task').querySelector('a')?.getAttribute('href'),
    ).toBe('#/work/tasks/task-1');
    expect(within(result).getByTestId('explain-link-worker-run').getAttribute('data-ref-id')).toBe(
      'run-1',
    );
    expect(within(result).getByTestId('prov-raw')).toBeTruthy();

    fireEvent.click(screen.getByTestId('explain-export'));
    await waitFor(() =>
      expect(http.calls.find((c) => c.name === 'export_prov')?.params).toEqual({
        nodeId: 'fact-1',
      }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it('?resourceType=&resourceId= pre-fills and runs the audit_query filter; rows show named actors and linked resources; Load more follows the cursor; Export serializes the loaded rows', async () => {
    const create = stubDownload();
    const queries: unknown[] = [];
    const http = scriptedHttp({
      audit_query: (params) => {
        queries.push(params);
        const cursor = (params as { cursor?: string }).cursor;
        return cursor === undefined
          ? { items: [auditRow()], nextCursor: 'c-1' }
          : { items: [auditRow({ id: 'audit-2', action: 'action_request.complete' })] };
      },
      list_principals: principalsPage,
      list_gatekeepers: () => ({ items: [] }),
    });
    renderPage(http, { resourceType: 'action_request', resourceId: 'ar-1' });
    const row = await screen.findByTestId('audit-row');
    expect(queries[0]).toEqual({
      filter: { resourceType: 'action_request', resourceId: 'ar-1' },
      limit: 50,
    });
    await waitFor(() => expect(row.textContent).toContain('Alice'));
    expect(row.querySelector('[data-ref-kind="object"] a')?.getAttribute('href')).toBe(
      '#/work/approvals/ar-1',
    );
    expect(row.textContent).toContain('[redacted]');
    expect(row.textContent).not.toContain('sk-1');
    expect((screen.getByLabelText(/资源 id/) as HTMLInputElement).value).toBe('ar-1');
    expect((screen.getByTestId('audit-actor-select') as HTMLSelectElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await waitFor(() => expect(screen.getAllByTestId('audit-row')).toHaveLength(2));
    expect(queries[1]).toMatchObject({ cursor: 'c-1' });

    fireEvent.click(screen.getByTestId('audit-export'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(http.calls.filter((c) => c.name === 'export_prov')).toHaveLength(0);

    // Applying a new filter from the form re-queries with only the non-blank keys.
    fireEvent.change(screen.getByTestId('audit-actor-select'), { target: { value: 'p-1' } });
    fireEvent.click(screen.getByTestId('audit-apply'));
    await waitFor(() =>
      expect(queries[queries.length - 1]).toEqual({
        filter: { actorPrincipalId: 'p-1', resourceType: 'action_request', resourceId: 'ar-1' },
        limit: 50,
      }),
    );
  });

  it('?actionRequestId= shows the approval context, explains its decision node and filters the audit log on the request', async () => {
    const http = scriptedHttp({
      get_action: () => ({
        id: 'ar-1',
        status: 'executed',
        gatekeeperId: 'gk-1',
        actionKindTag: 'docker.container_restart',
        resourceScope: 'web-1',
        blastRadius: 'high',
        awaitDecision: true,
        params: {},
        onBehalfOf: 'p-1',
        actorRuntime: 'worker',
        requestedAt: '2026-09-03T00:00:00.000Z',
        executedAt: '2026-09-03T00:02:00.000Z',
        parentWorkerRunId: 'run-1',
        approvalDecisionId: 'dec-1',
        decidedBy: 'p-1',
        decidedAt: '2026-09-03T00:01:00.000Z',
        decisionReason: 'change window',
      }),
      explain: () => ({
        nodeType: 'decision',
        decision: {
          id: 'dec-1',
          status: 'approved',
          summary: 'approve action_request ar-1',
          decidedByPrincipal: principal,
          source: null,
        },
        activity: {
          id: 'act-9',
          kind: 'governance.approval_decision',
          status: 'completed',
          createdAt: '2026-09-03T00:01:00.000Z',
          endedAt: '2026-09-03T00:01:00.000Z',
          startedByPrincipal: principal,
          observations: [],
          metadata: { actionRequestId: 'ar-1', event: 'approve' },
          onBehalfOfPrincipal: null,
        },
      }),
      audit_query: () => ({ items: [auditRow()] }),
      list_principals: principalsPage,
      list_gatekeepers: () => ({
        items: [{ id: 'gk-1', name: 'docker-prod', kind: 'http', status: 'active' }],
      }),
    });
    renderPage(http, { actionRequestId: 'ar-1' });
    const card = await screen.findByTestId('approval-context-card');
    expect(card.getAttribute('data-blast-radius')).toBe('high');
    expect(within(card).queryByTestId('approval-approve')).toBeNull();
    await waitFor(() => expect(card.textContent).toContain('docker-prod'));
    expect(within(card).getByTestId('approval-context-decided-by').textContent).toContain('Alice');
    expect(card.textContent).toContain('change window');
    expect(within(card).getByTestId('approval-open-page').getAttribute('href')).toBe(
      '#/work/approvals/ar-1',
    );

    const result = await screen.findByTestId('explain-result');
    expect(http.calls.find((c) => c.name === 'explain')?.params).toEqual({ nodeId: 'dec-1' });
    expect(within(result).getByTestId('explain-decision').textContent).toContain('approved');
    expect(
      within(result).getByTestId('explain-link-action-request').getAttribute('data-ref-id'),
    ).toBe('ar-1');
    expect(http.calls.find((c) => c.name === 'audit_query')?.params).toEqual({
      filter: { resourceType: 'action_request', resourceId: 'ar-1' },
      limit: 50,
    });
    await screen.findByTestId('audit-row');
  });

  it('S11 fix (CI #288/#290): when every loaded row is a read, the empty state (not a blank page) shows and "Show reads" reveals them', async () => {
    const http = scriptedHttp({
      audit_query: () => ({ items: [auditRow({ id: 'audit-read', action: 'list_grants' })] }),
      list_principals: principalsPage,
      list_gatekeepers: () => ({ items: [] }),
    });
    renderPage(http);

    // Neither a bare "no rows at all" empty state nor the list — `audit-empty` is reused for
    // "rows exist, all filtered" too, so the page is never blank.
    const empty = await screen.findByTestId('audit-empty');
    expect(empty.textContent).toContain('1');
    expect(screen.queryByTestId('audit-list')).toBeNull();
    expect(screen.queryByTestId('audit-row')).toBeNull();

    fireEvent.click(within(empty).getByRole('button', { name: /显示读操作|Show reads/ }));
    await waitFor(() => expect(screen.getAllByTestId('audit-row')).toHaveLength(1));
    expect(screen.queryByTestId('audit-empty')).toBeNull();
  });

  it('reads the entry from the hash when the route table does not pass one', async () => {
    window.location.hash = '#/govern/audit?nodeId=fact-1';
    const http = scriptedHttp({
      explain: () => factExplain(),
      audit_query: () => ({ items: [] }),
      list_principals: principalsPage,
      list_gatekeepers: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('explain-result');
    expect(http.calls.find((c) => c.name === 'explain')?.params).toEqual({ nodeId: 'fact-1' });
  });
});

describe('AuditPage degraded states', () => {
  it('audit_query 403 → auditor-role explanation; explain error → banner with the code; principals 403 → the actor filter is a text input', async () => {
    const http = scriptedHttp({
      audit_query: () =>
        Promise.reject(new HttpError('capability_error', 'role "member"', 'forbidden')),
      explain: () => Promise.reject(new HttpError('capability_error', 'no such node', 'not_found')),
      list_principals: () =>
        Promise.reject(new HttpError('capability_error', 'role "member"', 'forbidden')),
      list_gatekeepers: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('audit-query-forbidden');
    await screen.findByTestId('audit-actor-input');
    expect(screen.queryByTestId('audit-actor-select')).toBeNull();

    fireEvent.change(screen.getByLabelText(/节点 id/), { target: { value: 'nope' } });
    fireEvent.submit(screen.getByTestId('explain-form'));
    const banner = await screen.findByTestId('explain-error');
    expect(banner.getAttribute('data-error-code')).toBe('not_found');
  });

  it('export_prov 403 explains the auditor requirement instead of failing silently', async () => {
    const http = scriptedHttp({
      explain: () => factExplain(),
      export_prov: () =>
        Promise.reject(new HttpError('capability_error', 'role "member"', 'forbidden')),
      audit_query: () => ({ items: [] }),
      list_principals: principalsPage,
      list_gatekeepers: () => ({ items: [] }),
    });
    renderPage(http, { nodeId: 'fact-1' });
    await screen.findByTestId('explain-result');
    fireEvent.click(screen.getByTestId('explain-export'));
    await screen.findByTestId('explain-export-forbidden');
  });
});
