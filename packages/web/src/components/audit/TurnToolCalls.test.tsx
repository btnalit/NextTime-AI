// @vitest-environment jsdom
import type { ChatMessageWire, TurnToolCallsWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
import { TurnToolCalls } from './TurnToolCalls.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.removeItem('nexttime.lang');
});

function toolRow(
  sequence: number,
  toolCallId: string,
  overrides: Record<string, unknown> = {},
): ChatMessageWire {
  const name = String(overrides.name ?? 'list_facts');
  return {
    id: `m${sequence}`,
    role: 'tool',
    text: name,
    createdAt: '2026-11-19T00:00:00.000Z',
    sequence,
    turnId: 'turn-1',
    kind: 'tool_call',
    content: {
      kind: 'tool_call',
      text: name,
      toolCallId,
      name,
      outcome: 'done',
      args: { text: '{"linkType":"depends_on"}', totalChars: 25, truncated: false },
      result: { text: '{"items":[]}', totalChars: 12, truncated: false },
      redactedValues: 0,
      startedAt: '2026-11-19T00:00:01.000Z',
      endedAt: '2026-11-19T00:00:02.000Z',
      ...overrides,
    },
  };
}

function httpAnswering(answer: () => unknown | Promise<unknown>) {
  const calls: { name: string; params: unknown }[] = [];
  const http: CapabilityCaller = {
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      if (name !== 'get_turn_tool_calls') throw new Error(`unscripted capability ${name}`);
      return answer();
    }) as CapabilityCaller['call'],
  };
  return { http, calls };
}

function renderCalls(http: CapabilityCaller, lang: 'zh-CN' | 'en' = 'zh-CN') {
  localStorage.setItem('nexttime.lang', lang);
  return render(
    <LangProvider>
      <PermissionsProvider>
        <TurnToolCalls http={http} turnId="turn-1" />
      </PermissionsProvider>
    </LangProvider>,
  );
}

/** Legacy 255: the audit page's list of the tool calls one agent Turn made. */
describe('TurnToolCalls', () => {
  it('reads get_turn_tool_calls{turnId} and lists the calls oldest first, with the chat linked', async () => {
    const page: TurnToolCallsWire = {
      chatId: 'chat-1',
      items: [
        toolRow(2, 'call-1'),
        toolRow(3, 'call-2', {
          name: 'bash',
          outcome: 'failed',
          result: { text: 'exit 1', totalChars: 6, truncated: false },
          redactedValues: 2,
        }),
      ],
    };
    const { http, calls } = httpAnswering(() => page);
    renderCalls(http);
    const list = await screen.findByTestId('explain-turn-tool-calls-list');
    expect(calls).toEqual([{ name: 'get_turn_tool_calls', params: { turnId: 'turn-1' } }]);
    const rows = within(list).getAllByTestId('tool-call-record');
    expect(rows.map((row) => row.getAttribute('data-tool-call-id'))).toEqual(['call-1', 'call-2']);
    expect(rows[0]?.querySelector('.tool-call-name')?.textContent).toBe('list_facts');
    expect(rows[1]?.querySelector('[data-tool-outcome]')?.getAttribute('data-tool-outcome')).toBe(
      'failed',
    );
    expect(within(rows[1] as HTMLElement).getByTestId('tool-call-redacted').textContent).toContain(
      '已隐藏 2 处疑似凭据',
    );
    const section = screen.getByTestId('explain-turn-tool-calls');
    expect(within(section).getByTestId('explain-turn-tool-calls-count').textContent).toContain(
      '共 2 个，按调用先后排列',
    );
    expect(within(section).getByTestId('explain-turn-tool-calls-chat').getAttribute('href')).toBe(
      '#/work/chats/chat-1',
    );
    expect(screen.queryByTestId('explain-turn-tool-calls-truncated')).toBeNull();
    expect(screen.queryByTestId('explain-turn-tool-calls-empty')).toBeNull();
  });

  it('a Turn that called no tool says so, not an error', async () => {
    const { http } = httpAnswering(() => ({ chatId: 'chat-1', items: [] }));
    renderCalls(http);
    const empty = await screen.findByTestId('explain-turn-tool-calls-empty');
    expect(empty.textContent).toContain('这一轮没有调用工具。');
    expect(screen.queryByTestId('explain-turn-tool-calls-error')).toBeNull();
    expect(screen.queryByTestId('explain-turn-tool-calls-list')).toBeNull();
  });

  it('truncated: says only the first ones are listed and that the chat has them all', async () => {
    const items = Array.from({ length: 100 }, (_, i) => toolRow(i + 1, `call-${i}`));
    const { http } = httpAnswering(() => ({ chatId: 'chat-1', items, truncated: true }));
    renderCalls(http);
    const notice = await screen.findByTestId('explain-turn-tool-calls-truncated');
    expect(notice.textContent).toContain('超过 100 个，这里只列出前 100 个');
    expect(notice.textContent).toContain('全部调用在对话里');
    expect(screen.getAllByTestId('tool-call-record')).toHaveLength(100);
    // UX review on #1517: the line above the list never reads 100 as the total.
    const count = screen.getByTestId('explain-turn-tool-calls-count').textContent ?? '';
    expect(count).toContain('显示前 100 个，这一轮还有更多');
    expect(count).not.toContain('共 100 个');
  });

  it('truncated, English: "the first N", never "N call(s)" as a total', async () => {
    const items = Array.from({ length: 100 }, (_, i) => toolRow(i + 1, `call-${i}`));
    const { http } = httpAnswering(() => ({ chatId: 'chat-1', items, truncated: true }));
    renderCalls(http, 'en');
    const count = await screen.findByTestId('explain-turn-tool-calls-count');
    expect(count.textContent).toContain('Showing the first 100 call(s); this turn made more.');
    expect(count.textContent).not.toMatch(/^100 call\(s\)/);
  });

  it('a call made on another day shows its date; one made today the clock alone (UX on #1517)', async () => {
    // Noon UTC, so "today" and "two days ago" are the same and another local day in any zone
    // within ±11 h of UTC.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T12:00:00.000Z'));
    try {
      const { http } = httpAnswering(() => ({
        chatId: 'chat-1',
        items: [
          toolRow(2, 'call-old', {
            startedAt: '2026-11-17T12:00:05.000Z',
            endedAt: '2026-11-17T12:00:06.000Z',
          }),
          toolRow(3, 'call-today', {
            startedAt: '2026-11-19T11:59:05.000Z',
            endedAt: '2026-11-19T11:59:06.000Z',
          }),
        ],
      }));
      renderCalls(http);
      const list = await screen.findByTestId('explain-turn-tool-calls-list');
      const times = within(list)
        .getAllByTestId('tool-call-time')
        .map((el) => el.textContent ?? '');
      expect(times[0]).toMatch(/^11-17 \d{2}:\d{2}:05 · 用时/);
      expect(times[1]).toMatch(/^\d{2}:\d{2}:05 · 用时/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turn_not_found: says the Turn’s chat cannot be read, with no retry (the kernel answers it the same every time)', async () => {
    const { http } = httpAnswering(() =>
      Promise.reject(new HttpError('capability_error', 'no such turn', 'turn_not_found')),
    );
    renderCalls(http);
    const banner = await screen.findByTestId('explain-turn-tool-calls-error');
    expect(banner.textContent).toContain('读不到这一轮所在的对话');
    expect(within(banner).queryByRole('button')).toBeNull();
  });

  it('any other failure offers a retry, which reads again', async () => {
    let answers = 0;
    const { http, calls } = httpAnswering(() => {
      answers += 1;
      return answers === 1
        ? Promise.reject(new HttpError('network', 'offline'))
        : { chatId: 'chat-1', items: [toolRow(1, 'call-1')] };
    });
    renderCalls(http);
    const banner = await screen.findByTestId('explain-turn-tool-calls-error');
    fireEvent.click(within(banner).getByRole('button'));
    await screen.findByTestId('explain-turn-tool-calls-list');
    expect(calls).toHaveLength(2);
  });

  it('a role refused the read shows nothing', async () => {
    const { http, calls } = httpAnswering(() =>
      Promise.reject(new HttpError('capability_error', 'nope', 'forbidden')),
    );
    renderCalls(http);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(screen.queryByTestId('explain-turn-tool-calls')).toBeNull());
  });

  it('a row the console cannot read as a tool call is left out; English copy', async () => {
    const odd: ChatMessageWire = { ...toolRow(3, 'call-x'), content: { kind: 'something_else' } };
    const { http } = httpAnswering(() => ({
      chatId: 'chat-1',
      items: [toolRow(2, 'call-1'), odd],
    }));
    renderCalls(http, 'en');
    const list = await screen.findByTestId('explain-turn-tool-calls-list');
    expect(within(list).getAllByTestId('tool-call-record')).toHaveLength(1);
    const section = screen.getByTestId('explain-turn-tool-calls');
    expect(section.textContent).toContain('Tool calls in this turn');
    expect(section.textContent).toContain('1 call(s), in the order they were made');
    expect(screen.getByTestId('explain-turn-tool-calls-unreadable').textContent).toContain(
      '1 more this console cannot read',
    );
    expect(section.textContent).not.toMatch(/[一-鿿]/);
  });

  it('every call unreadable: says how many and where to see them, never that the Turn called none (console review on #1517)', async () => {
    const odd = (sequence: number): ChatMessageWire => ({
      ...toolRow(sequence, `call-${sequence}`),
      content: { kind: 'something_else' },
    });
    const { http } = httpAnswering(() => ({ chatId: 'chat-1', items: [odd(1), odd(2)] }));
    renderCalls(http);
    const empty = await screen.findByTestId('explain-turn-tool-calls-empty');
    expect(empty.textContent).toContain('这一轮有 2 个工具调用，这个控制台读不了');
    expect(empty.textContent).not.toContain('没有调用工具');
    expect(within(empty).getByTestId('explain-turn-tool-calls-chat').getAttribute('href')).toBe(
      '#/work/chats/chat-1',
    );
  });

  it('every call read: no unreadable line', async () => {
    const { http } = httpAnswering(() => ({ chatId: 'chat-1', items: [toolRow(1, 'call-1')] }));
    renderCalls(http);
    await screen.findByTestId('explain-turn-tool-calls-list');
    expect(screen.queryByTestId('explain-turn-tool-calls-unreadable')).toBeNull();
  });
});
