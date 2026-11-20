// @vitest-environment jsdom
import type { TaskToolCallsWire, WorkerToolCallWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { LangProvider } from '../lib/i18n.js';
import type { WorkerRunSummary } from '../lib/tasks.js';
import { TaskToolCalls } from './TaskToolCalls.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.removeItem('nexttime.lang');
});

function run(id: string, attempt = 1): WorkerRunSummary {
  return {
    id,
    status: 'terminated',
    containerId: null,
    depth: 0,
    attempt,
    startedAt: '2026-11-19T00:00:00.000Z',
    terminatedAt: '2026-11-19T00:05:00.000Z',
  };
}

function call(
  workerRunId: string,
  sequence: number,
  overrides: Record<string, unknown> = {},
): WorkerToolCallWire {
  const name = String(overrides.name ?? 'read');
  return {
    workerRunId,
    sequence,
    reportedAt: '2026-11-19T00:01:00.000Z',
    content: {
      kind: 'tool_call',
      text: name,
      toolCallId: `${workerRunId}-call-${sequence}`,
      name,
      outcome: 'done',
      args: { text: '{"path":"notes.md"}', totalChars: 19, truncated: false },
      result: { text: 'hello', totalChars: 5, truncated: false },
      redactedValues: 0,
      startedAt: '2026-11-19T00:00:10.000Z',
      endedAt: '2026-11-19T00:00:11.000Z',
      ...overrides,
    } as WorkerToolCallWire['content'],
  };
}

function httpAnswering(answer: (params: Record<string, unknown>) => unknown | Promise<unknown>) {
  const calls: { name: string; params: unknown }[] = [];
  const http: CapabilityCaller = {
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      if (name !== 'get_task_tool_calls') throw new Error(`unscripted capability ${name}`);
      return answer((params ?? {}) as Record<string, unknown>);
    }) as CapabilityCaller['call'],
  };
  return { http, calls };
}

function renderCalls(
  http: CapabilityCaller,
  {
    runs = [run('run-a')],
    running = false,
    lang = 'zh-CN',
  }: {
    runs?: readonly WorkerRunSummary[];
    running?: boolean;
    lang?: 'zh-CN' | 'en';
  } = {},
) {
  localStorage.setItem('nexttime.lang', lang);
  return render(
    <LangProvider>
      <PermissionsProvider>
        <TaskToolCalls http={http} taskId="task-1" runs={runs} running={running} />
      </PermissionsProvider>
    </LangProvider>,
  );
}

/** Legacy 155, console half: the tool calls a Task's Worker reported, under its runs. */
describe('TaskToolCalls', () => {
  it('reads get_task_tool_calls{taskId} and lists one run’s calls in order, without a run title', async () => {
    const page: TaskToolCallsWire = {
      taskId: 'task-1',
      items: [
        call('run-a', 1),
        call('run-a', 2, {
          name: 'bash',
          outcome: 'failed',
          result: { text: 'exit 1', totalChars: 6, truncated: false },
          redactedValues: 1,
        }),
      ],
    };
    const { http, calls } = httpAnswering(() => page);
    renderCalls(http);
    const list = await screen.findByTestId('task-tool-calls-list');
    expect(calls).toEqual([{ name: 'get_task_tool_calls', params: { taskId: 'task-1' } }]);
    const rows = within(list).getAllByTestId('tool-call-record');
    expect(rows.map((row) => row.getAttribute('data-tool-call-id'))).toEqual([
      'run-a-call-1',
      'run-a-call-2',
    ]);
    expect(screen.getByTestId('task-tool-calls-count').textContent).toContain('共 2 个');
    expect(screen.getByTestId('task-tool-calls-count').textContent).toContain(
      '这是 Worker 自己报告的调用',
    );
    expect(screen.queryByTestId('task-tool-calls-run-title')).toBeNull();
    expect(screen.queryByTestId('task-tool-calls-refresh')).toBeNull();
    expect(screen.queryByTestId('task-tool-calls-load-more')).toBeNull();
  });

  it('groups the calls under each run, with its attempt, when the Task has more than one run', async () => {
    const { http } = httpAnswering(() => ({
      taskId: 'task-1',
      items: [call('run-a', 1), call('run-b', 1), call('run-b', 2)],
    }));
    renderCalls(http, { runs: [run('run-a', 1), run('run-b', 2)] });
    const groups = await screen.findAllByTestId('task-tool-calls-run');
    expect(groups.map((group) => group.getAttribute('data-worker-run-id'))).toEqual([
      'run-a',
      'run-b',
    ]);
    const titles = screen.getAllByTestId('task-tool-calls-run-title').map((el) => el.textContent);
    expect(titles[0]).toContain('第 1 次尝试');
    expect(titles[0]).toContain('1 个');
    expect(titles[1]).toContain('第 2 次尝试');
    expect(titles[1]).toContain('2 个');
  });

  it('follows nextCursor with 加载更多 and keeps a run split across pages as one group', async () => {
    const { http, calls } = httpAnswering((params) =>
      params.cursor === undefined
        ? { taskId: 'task-1', items: [call('run-a', 1), call('run-b', 1)], nextCursor: 'c1' }
        : { taskId: 'task-1', items: [call('run-b', 2)] },
    );
    renderCalls(http, { runs: [run('run-a'), run('run-b', 2)] });
    expect((await screen.findByTestId('task-tool-calls-count')).textContent).toContain(
      '已显示 2 个，还有更多',
    );
    fireEvent.click(screen.getByTestId('task-tool-calls-load-more'));
    await waitFor(() => expect(screen.queryByTestId('task-tool-calls-load-more')).toBeNull());
    expect(calls[1]).toEqual({
      name: 'get_task_tool_calls',
      params: { taskId: 'task-1', cursor: 'c1' },
    });
    const groups = screen.getAllByTestId('task-tool-calls-run');
    expect(groups).toHaveLength(2);
    expect(within(groups[1] as HTMLElement).getAllByTestId('tool-call-record')).toHaveLength(2);
    expect(screen.getByTestId('task-tool-calls-count').textContent).toContain('共 3 个');
  });

  it('says a run that holds the kernel’s cap kept no later calls', async () => {
    const items = Array.from({ length: 200 }, (_, index) => call('run-a', index + 1));
    const { http } = httpAnswering(() => ({ taskId: 'task-1', items }));
    renderCalls(http);
    expect((await screen.findByTestId('task-tool-calls-run-full')).textContent).toContain(
      '记到了 200 个的上限',
    );
  });

  it('says what an empty list means: a finished Task, then a running one with 刷新', async () => {
    let items: WorkerToolCallWire[] = [];
    const { http, calls } = httpAnswering(() => ({ taskId: 'task-1', items }));
    renderCalls(http);
    expect((await screen.findByTestId('task-tool-calls-empty')).textContent).toContain(
      '平台升级前开始的运行、评测运行',
    );
    cleanup();
    renderCalls(http, { running: true });
    expect((await screen.findByTestId('task-tool-calls-empty')).textContent).toContain(
      'Worker 还没有报告工具调用',
    );
    items = [call('run-a', 1)];
    fireEvent.click(screen.getByTestId('task-tool-calls-refresh'));
    await screen.findByTestId('task-tool-calls-list');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByTestId('task-tool-calls-count').textContent).toContain('任务还在运行');
    expect(screen.getByTestId('task-tool-calls-refresh')).toBeTruthy();
  });

  it('counts a call this console cannot read instead of showing it or calling the list empty', async () => {
    const { http } = httpAnswering(() => ({
      taskId: 'task-1',
      items: [call('run-a', 1), call('run-a', 2, { outcome: 'paused' })],
    }));
    renderCalls(http);
    await screen.findByTestId('task-tool-calls-list');
    expect(screen.getAllByTestId('tool-call-record')).toHaveLength(1);
    expect(screen.getByTestId('task-tool-calls-unreadable').textContent).toContain('另有 1 个');
  });

  it('renders nothing for a role that may not read it, and no retry for a Task it cannot read', async () => {
    const forbidden = httpAnswering(() =>
      Promise.reject(new HttpError('capability_error', 'nope', 'forbidden')),
    );
    const { container } = renderCalls(forbidden.http);
    await waitFor(() => expect(forbidden.calls).toHaveLength(1));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="task-tool-calls"]')).toBeNull(),
    );
    cleanup();
    const missing = httpAnswering(() =>
      Promise.reject(new HttpError('capability_error', 'no such task', 'not_found')),
    );
    renderCalls(missing.http);
    const banner = await screen.findByTestId('task-tool-calls-error');
    expect(banner.textContent).toContain('读不到这个任务');
    expect(within(banner).queryByRole('button', { name: /重试/ })).toBeNull();
  });

  it('reads in English', async () => {
    const { http } = httpAnswering(() => ({ taskId: 'task-1', items: [call('run-a', 1)] }));
    renderCalls(http, { lang: 'en', running: true });
    const count = await screen.findByTestId('task-tool-calls-count');
    expect(count.textContent).toContain('1 call(s).');
    expect(count.textContent).toContain('Reported by the Worker');
    expect(screen.getByText('Tool calls the Worker reported')).toBeTruthy();
    expect(screen.getByTestId('task-tool-calls-refresh').textContent).toBe('Refresh');
  });
});
