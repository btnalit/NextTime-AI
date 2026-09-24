// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import type { TaskSummary } from '../lib/tasks.js';
import { TaskDetail } from './TaskDetail.js';

afterEach(cleanup);

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'task-1',
    status: 'running',
    onBehalfOf: 'p-1',
    workerDefinitionId: 'wd-1',
    workerDefinitionVersion: 2,
    input: { need: 'restart web' },
    result: null,
    tokenBudget: 1000,
    tokensUsed: 900,
    durationLimitSec: 60,
    failureReason: null,
    createdAt: '2026-09-03T00:00:00.000Z',
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    workerRuns: [
      {
        id: 'run-1',
        status: 'running',
        containerId: null,
        depth: 0,
        attempt: 1,
        startedAt: '2026-09-03T00:00:00.000Z',
        terminatedAt: null,
      },
    ],
    ...overrides,
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller {
  return {
    call: vi.fn(async (name: string, params?: unknown) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function renderDetail(
  overrides: Partial<TaskSummary> = {},
  http: CapabilityCaller = scriptedHttp({ list_action_requests: () => ({ items: [] }) }),
  onCancel = vi.fn(async () => undefined),
) {
  const onOpenApproval = vi.fn();
  render(
    <PermissionsProvider>
      <TaskDetail
        task={task(overrides)}
        definitionName="Restarter"
        http={http}
        pushes={SILENT_PUSH_SOURCE}
        principalNames={new Map([['p-1', 'Alice']])}
        onOpenApproval={onOpenApproval}
        onCancel={onCancel}
      />
    </PermissionsProvider>,
  );
  return { onCancel, onOpenApproval };
}

/** TaskDetail.test.tsx (C22, console-completion-plan §2b; S6-A B3 / B4 / C28 / §5.5). */
describe('TaskDetail', () => {
  it('renders the definition and on-behalf-of as named chips, the budget bar, and the provenance links', () => {
    renderDetail();
    const definition = screen.getByTestId('task-definition');
    expect(definition.textContent).toContain('Restarter v2');
    expect(definition.getAttribute('data-ref-id')).toBe('wd-1');
    expect(screen.getByTestId('task-on-behalf-of').textContent).toContain('Alice');
    expect(document.querySelector('.quota-bar-warn')).toBeTruthy();
    expect(screen.getByTestId('task-provenance-link').getAttribute('href')).toBe(
      '#/govern/audit?resourceType=task&resourceId=task-1',
    );
    expect(screen.getByTestId('worker-run-provenance-link').getAttribute('href')).toBe(
      '#/govern/audit?resourceType=worker_run&resourceId=run-1',
    );
    expect(screen.getByText('restart web')).toBeTruthy();
  });

  it('offers Cancel only while the transition table allows it; Cancel opens a confirm anchored to itself (S8 W1-A7), which calls onCancel with the task', async () => {
    const { onCancel } = renderDetail();
    fireEvent.click(screen.getByTestId('task-cancel'));
    const confirm = await screen.findByTestId('task-cancel-confirm');
    expect(onCancel).not.toHaveBeenCalled();
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('Restarter');
    expect(within(confirm).getByTestId('confirm-impact').textContent).toContain('Running runs: 1');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' })),
    );
    cleanup();
    renderDetail({ status: 'completed', completedAt: '2026-09-03T00:02:00.000Z' });
    expect(screen.queryByTestId('task-cancel')).toBeNull();
    expect(screen.getByText(/Finished/)).toBeTruthy();
  });

  it('renders the S2.9 result contract summary and counts, raw JSON otherwise', () => {
    renderDetail({
      status: 'completed',
      result: {
        summary: 'Restarted web-1.',
        findings: ['it was slow'],
        factsToAssert: [{ a: 1 }],
        evidence: [],
        artifacts: [],
      },
    });
    expect(screen.getByText('Restarted web-1.')).toBeTruthy();
    expect(screen.getByText('it was slow')).toBeTruthy();
    expect(screen.getByText(/1 条事实 facts written/)).toBeTruthy();
    cleanup();
    renderDetail({ status: 'completed', result: { raw: true } });
    expect(document.querySelector('.code-block')?.textContent).toContain('"raw": true');
  });

  it('lists linked approvals from list_action_requests{taskId}, opening one via onOpenApproval; shows the failure reason', async () => {
    const http = scriptedHttp({
      list_action_requests: (params) => {
        expect(params).toEqual({ taskId: 'task-1', limit: 20 });
        return {
          items: [
            {
              id: 'ar-1',
              status: 'rejected',
              gatekeeperId: 'gk-1',
              actionKindTag: 'docker.container_restart',
              resourceScope: 'web-1',
              blastRadius: 'high',
              awaitDecision: true,
              params: {},
              requestedAt: '2026-09-03T00:00:00.000Z',
              decidedBy: 'p-1',
              decisionReason: 'not now',
            },
          ],
        };
      },
    });
    const { onOpenApproval } = renderDetail({ failureReason: 'worker refused' }, http);
    const row = await screen.findByTestId('linked-approval-row');
    expect(row.textContent).toContain('docker container restart');
    expect(row.textContent).toContain('not now');
    expect(within(row).getByText('Alice')).toBeTruthy();
    fireEvent.click(row);
    expect(onOpenApproval).toHaveBeenCalledWith('ar-1');
    expect(screen.getByText('worker refused')).toBeTruthy();
  });

  it('a thrown onCancel keeps the confirm open with its own inline error (data-error-code)', async () => {
    const onCancel = vi.fn(async () => {
      throw new HttpError('capability_error', 'already finished', 'illegal_transition');
    });
    renderDetail({}, scriptedHttp({ list_action_requests: () => ({ items: [] }) }), onCancel);
    fireEvent.click(screen.getByTestId('task-cancel'));
    const confirm = await screen.findByTestId('task-cancel-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const error = await within(confirm).findByTestId('confirm-error');
    expect(error.getAttribute('data-error-code')).toBe('illegal_transition');
    expect(screen.getByTestId('task-cancel-confirm')).toBeTruthy();
  });

  it('no definition name renders the grey bare-id fallback chip, never a blank', () => {
    render(
      <PermissionsProvider>
        <TaskDetail
          task={task()}
          definitionName={undefined}
          http={scriptedHttp({ list_action_requests: () => ({ items: [] }) })}
          pushes={SILENT_PUSH_SOURCE}
          onOpenApproval={vi.fn()}
          onCancel={vi.fn(async () => undefined)}
        />
      </PermissionsProvider>,
    );
    expect(screen.getByTestId('task-definition').className).toContain('ref-chip-bare');
  });
});
