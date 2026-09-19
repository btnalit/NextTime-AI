// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { ActionRequestRowLike } from '../lib/action-card.js';
import { type CapabilityCaller, type PushSource, SILENT_PUSH_SOURCE } from '../lib/clients.js';
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

function approval(overrides: Partial<ActionRequestRowLike> = {}): ActionRequestRowLike {
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
 * TasksPage.test.tsx (C7, console-completion-plan §2b): every push reconciles one row — a
 * `task.updated` is one `get_task`, an `action.pending` one `get_action`, an `action.updated`
 * no request at all (the push carries the status) — never a second full-list reload on top.
 */
describe('TasksPage push reconciliation (C7)', () => {
  it('action.updated drops the linked approval locally without any request; action.pending fetches just that row', async () => {
    const pushes = pushSource();
    const http = scriptedHttp({
      list_tasks: () => ({ items: [task()] }),
      list_worker_definitions: () => ({ items: [] }),
      list_pending: () => ({ items: [approval()] }),
      get_action: (params) => {
        expect(params).toEqual({ actionRequestId: 'ar-2' });
        return approval({ id: 'ar-2', actionKindTag: 'docker.container_stop' });
      },
    });
    renderPage(http, pushes, 'task-1');
    const detail = await screen.findByTestId('task-detail');
    await within(detail).findByRole('button', { name: /container restart/i });
    const listPendingCalls = () => http.calls.filter((name) => name === 'list_pending').length;
    expect(listPendingCalls()).toBe(1);

    act(() => pushes.emitUpdated({ id: 'ar-1', status: 'approved' }));
    await waitFor(() =>
      expect(within(detail).queryByRole('button', { name: /container restart/i })).toBeNull(),
    );
    expect(listPendingCalls()).toBe(1);
    expect(http.calls.filter((name) => name === 'get_action')).toHaveLength(0);

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
    await within(detail).findByRole('button', { name: /container stop/i });
    expect(http.calls.filter((name) => name === 'get_action')).toHaveLength(1);
    expect(listPendingCalls()).toBe(1);
  });

  it('task.updated re-reads only that Task (get_task), never the whole list', async () => {
    const pushes = pushSource();
    const http = scriptedHttp({
      list_tasks: () => ({ items: [task()] }),
      list_worker_definitions: () => ({ items: [] }),
      list_pending: () => ({ items: [] }),
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
