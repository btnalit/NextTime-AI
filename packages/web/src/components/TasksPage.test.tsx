// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import { type CapabilityCaller, type PushSource, SILENT_PUSH_SOURCE } from '../lib/clients.js';
import type { ActionRequestRow } from '../lib/governance.js';
import { HttpError } from '../lib/http-client.js';
import type { TaskSummary } from '../lib/tasks.js';
import type { ActionPendingPush, ActionUpdatedPush, TaskUpdatedPush } from '../lib/ws-client.js';
import { TasksPage } from './TasksPage.js';
import { ToastProvider } from './ui/Toast.js';

afterEach(cleanup);

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'task-1',
    status: 'running',
    onBehalfOf: 'p-1',
    workerDefinitionId: 'wd-1',
    workerDefinitionVersion: 1,
    input: { goal: 'restart web' },
    result: null,
    tokenBudget: null,
    tokensUsed: 0,
    durationLimitSec: null,
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

function approval(overrides: Partial<ActionRequestRow> = {}): ActionRequestRow {
  return {
    id: 'ar-1',
    status: 'pending_approval',
    gatekeeperId: 'gk-1',
    actionKindTag: 'docker.container_restart',
    resourceScope: null,
    parentWorkerRunId: 'run-1',
    blastRadius: 'medium',
    awaitDecision: true,
    params: {},
    requestedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push(name);
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function pushSource(): PushSource & {
  emitPending: (event: ActionPendingPush) => void;
  emitUpdated: (event: ActionUpdatedPush) => void;
  emitTask: (event: TaskUpdatedPush) => void;
} {
  const pending = new Set<(event: ActionPendingPush) => void>();
  const updated = new Set<(event: ActionUpdatedPush) => void>();
  const tasks = new Set<(event: TaskUpdatedPush) => void>();
  return {
    ...SILENT_PUSH_SOURCE,
    onActionPending: (handler) => {
      pending.add(handler);
      return () => pending.delete(handler);
    },
    onActionUpdated: (handler) => {
      updated.add(handler);
      return () => updated.delete(handler);
    },
    onTaskUpdated: (handler) => {
      tasks.add(handler);
      return () => tasks.delete(handler);
    },
    emitPending: (event) => {
      for (const fn of pending) fn(event);
    },
    emitUpdated: (event) => {
      for (const fn of updated) fn(event);
    },
    emitTask: (event) => {
      for (const fn of tasks) fn(event);
    },
  };
}

function renderPage(http: CapabilityCaller, pushes: PushSource, selectedId?: string) {
  return render(
    <PermissionsProvider>
      <ToastProvider>
        <TasksPage
          http={http}
          pushes={pushes}
          selectedId={selectedId}
          onSelect={vi.fn()}
          onOpenApproval={vi.fn()}
        />
      </ToastProvider>
    </PermissionsProvider>,
  );
}

/**
 * TasksPage.test.tsx (C7 / C28, console-completion-plan §2b, §5.5): a `task.updated` push is one
 * `get_task`, never a list reload; the open Task's linked approvals come from
 * `list_action_requests{taskId}` (decided rows included) and an approval push re-reads that one
 * Task's list — no `list_pending` mirror, no per-row `get_action` on the page any more.
 */
describe('TasksPage linked approvals (C28) and push reconciliation (C7)', () => {
  it('selecting a task lists its ActionRequests via list_action_requests{taskId}, decided ones included; an approval push refetches only that list', async () => {
    const pushes = pushSource();
    const linkedParams: unknown[] = [];
    const http = scriptedHttp({
      list_tasks: () => ({ items: [task()] }),
      list_worker_definitions: () => ({ items: [] }),
      list_action_requests: (params) => {
        linkedParams.push(params);
        return {
          items: [
            approval(),
            approval({
              id: 'ar-0',
              status: 'approved',
              actionKindTag: 'docker.container_stop',
              decidedBy: 'p-op',
              decisionReason: 'fine',
            }),
          ],
        };
      },
    });
    renderPage(http, pushes, 'task-1');
    const detail = await screen.findByTestId('task-detail');
    const rows = await within(detail).findAllByTestId('linked-approval-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain('docker container stop');
    expect(rows[1]?.textContent).toContain('fine');
    expect(linkedParams).toEqual([{ taskId: 'task-1', limit: 20 }]);
    expect(http.calls.filter((name) => name === 'list_pending')).toHaveLength(0);

    act(() => pushes.emitUpdated({ id: 'ar-1', status: 'approved' }));
    await waitFor(() => expect(linkedParams).toHaveLength(2));
    expect(http.calls.filter((name) => name === 'get_action')).toHaveLength(0);
    expect(http.calls.filter((name) => name === 'list_tasks')).toHaveLength(1);

    act(() =>
      pushes.emitPending({
        actionRequestId: 'ar-2',
        gatekeeperId: 'gk-1',
        title: 'stop web',
        description: 'stop web',
        actionKind: { tag: 'docker.container_stop', label: 'stop' },
        awaitDecision: true,
      }),
    );
    await waitFor(() => expect(linkedParams).toHaveLength(3));
  });

  it('a member session (list_action_requests 403) sees the operator-role notice instead of an error', async () => {
    const http = scriptedHttp({
      list_tasks: () => ({ items: [task()] }),
      list_worker_definitions: () => ({ items: [] }),
      list_action_requests: () =>
        Promise.reject(new HttpError('capability_error', 'role "member"', 'forbidden')),
    });
    renderPage(http, SILENT_PUSH_SOURCE, 'task-1');
    await screen.findByTestId('linked-approvals-forbidden');
    expect(screen.queryByTestId('linked-approvals-error')).toBeNull();
  });

  it('task.updated re-reads only that Task (get_task), never the whole list', async () => {
    const pushes = pushSource();
    const http = scriptedHttp({
      list_tasks: () => ({ items: [task()] }),
      list_worker_definitions: () => ({ items: [] }),
      get_task: () => task({ status: 'completed', completedAt: '2026-09-03T00:01:00.000Z' }),
    });
    renderPage(http, pushes);
    const row = await screen.findByTestId('task-row');
    expect(row.querySelector('[data-status]')?.getAttribute('data-status')).toBe('running');

    act(() => pushes.emitTask({ id: 'task-1', status: 'completed' }));
    await waitFor(() =>
      expect(
        screen.getByTestId('task-row').querySelector('[data-status]')?.getAttribute('data-status'),
      ).toBe('completed'),
    );
    expect(http.calls.filter((name) => name === 'get_task')).toHaveLength(1);
    expect(http.calls.filter((name) => name === 'list_tasks')).toHaveLength(1);
  });
});

/** S6-A B2 (§5.8 "确认态"), S8 W1-A7: Cancel task confirms through a `kit/confirm` `medium`
 *  popover anchored to the Cancel button, owned by `TaskDetail` — Escape inside it closes only
 *  the confirmation, never the detail drawer it is nested inside. */
describe('TasksPage cancel confirmation (S6-A B2)', () => {
  it('Cancel opens the confirmation with the impact list; confirming calls cancel_task; Escape closes only the confirmation', async () => {
    const cancel = vi.fn(async () => ({ id: 'task-1', status: 'cancelled' }));
    const http = scriptedHttp({
      list_tasks: () => ({ items: [task({ tokensUsed: 1234 })] }),
      list_worker_definitions: () => ({
        items: [
          {
            id: 'wd-1',
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Restarter' },
          },
        ],
      }),
      list_action_requests: () => ({ items: [] }),
      cancel_task: cancel,
      get_task: () => task({ status: 'cancelled', cancelledAt: '2026-09-03T00:01:00.000Z' }),
    });
    const onSelect = vi.fn();
    render(
      <PermissionsProvider>
        <ToastProvider>
          <TasksPage
            http={http}
            pushes={SILENT_PUSH_SOURCE}
            selectedId="task-1"
            onSelect={onSelect}
            onOpenApproval={vi.fn()}
          />
        </ToastProvider>
      </PermissionsProvider>,
    );
    const detail = await screen.findByTestId('task-detail');
    fireEvent.click(await within(detail).findByTestId('task-cancel'));
    const confirm = await screen.findByTestId('task-cancel-confirm');
    expect(confirm.getAttribute('role')).toBe('dialog');
    expect(screen.getByTestId('confirm-target').textContent).toBe('Restarter');
    expect(screen.getByTestId('confirm-impact').textContent).toContain('Running runs: 1');
    expect(cancel).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('task-cancel-confirm')).toBeNull());
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId('task-drawer')).toBeTruthy();

    fireEvent.click(within(detail).getByTestId('task-cancel'));
    await screen.findByTestId('task-cancel-confirm');
    fireEvent.click(screen.getByTestId('confirm-button'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ taskId: 'task-1' }));
    await waitFor(() => expect(screen.queryByTestId('task-cancel-confirm')).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByTestId('task-row').querySelector('[data-status]')?.getAttribute('data-status'),
      ).toBe('cancelled'),
    );
  });
});
