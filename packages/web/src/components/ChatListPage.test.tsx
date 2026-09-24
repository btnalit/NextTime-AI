// @vitest-environment jsdom
import type { ChatWire } from '@nexttime/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatUpdatesProvider } from '../hooks/useChatUpdates.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { ChatListPage } from './ChatListPage.js';
import { ToastProvider } from './ui/Toast.js';

afterEach(cleanup);

/**
 * ChatListPage.test.tsx (S6-A, C22): the 活跃 / 已归档 filter, the archive → undo and restore
 * flows, rename, and that every lifecycle call splices the kernel's returned row into the cache
 * instead of refetching (`list_chats` is called exactly once per mount).
 */

function chat(overrides: Partial<ChatWire> = {}): ChatWire {
  return {
    id: 'chat-1',
    ownerPrincipalId: 'p-1',
    title: 'Ops chat',
    visibility: 'private',
    createdAt: '2026-09-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

const FIXTURE: readonly ChatWire[] = [
  chat({ id: 'c-untitled', title: null, createdAt: '2026-09-03T00:00:00.000Z' }),
  chat({ id: 'c-ops', title: 'Ops chat', createdAt: '2026-09-02T00:00:00.000Z' }),
  chat({
    id: 'c-old',
    title: 'Old incident',
    createdAt: '2026-08-01T00:00:00.000Z',
    archivedAt: '2026-08-15T00:00:00.000Z',
  }),
];

/** Every scripted client here answers `execution_readiness` "ready" by default (unless a test
 *  overrides it) — `ChatListPage` now mounts `ExecutionReadinessCard` (S8 W2 U3a), which reads it
 *  unconditionally on mount. Its own behavior is covered by `readiness/ExecutionReadinessCard.
 *  test.tsx`; this file only needs it to not blow up the existing chat-list assertions. */
function scriptedClient(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const merged: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
    execution_readiness: () => ({
      principalId: 'p-1',
      ready: true,
      missing: [],
      gates: [],
      workers: [],
    }),
    ...handlers,
  };
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = merged[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

/** A separate `http` caller from `client` (`ws`) in every test below — mirrors the real session
 *  (`routes.tsx` passes `session.ws`/`session.http`, two different transports) and keeps each
 *  test's `client.calls` assertion scoped to the `chat`-group calls it already checks, unaffected
 *  by `ExecutionReadinessCard`'s own `execution_readiness` read. */
function renderList(
  client: CapabilityCaller,
  onSelectChat = vi.fn(),
  http: CapabilityCaller = scriptedClient({}),
) {
  return {
    onSelectChat,
    ...render(
      <ToastProvider>
        <ChatListPage client={client} http={http} onSelectChat={onSelectChat} />
      </ToastProvider>,
    ),
  };
}

function rowTitles(): string[] {
  return screen
    .getAllByTestId('chat-row')
    .map((row) => row.querySelector('.data-row-title')?.textContent ?? '');
}

describe('ChatListPage filter (W1)', () => {
  it('loads once with includeArchived and shows only active chats by default, with the new-chat placeholder', async () => {
    const client = scriptedClient({ list_chats: () => ({ items: FIXTURE }) });
    renderList(client);
    await screen.findByTestId('chats-list');
    expect(client.calls).toEqual([{ name: 'list_chats', params: { includeArchived: true } }]);
    expect(rowTitles()).toEqual(['新对话', 'Ops chat']);
    expect(screen.getByTestId('chats-tab-active').textContent).toContain('2');
    expect(screen.getByTestId('chats-tab-archived').textContent).toContain('1');
    expect(screen.queryByTestId('chat-archived-chip')).toBeNull();
  });

  it('the 已归档 tab lists archived chats with a relative archivedAt and a 恢复', async () => {
    const client = scriptedClient({ list_chats: () => ({ items: FIXTURE }) });
    renderList(client);
    await screen.findByTestId('chats-list');
    fireEvent.click(screen.getByTestId('chats-tab-archived'));
    expect(rowTitles()).toEqual(['Old incident']);
    const row = screen.getByTestId('chat-row');
    expect(within(row).getByTestId('chat-archived-chip').textContent).toBe('已归档');
    expect(within(row).getByTestId('chat-archived-at').getAttribute('title')).toBeTruthy();
    expect(within(row).getByTestId('chat-row-restore')).toBeTruthy();
    expect(within(row).queryByTestId('chat-row-archive')).toBeNull();
    expect(within(row).queryByTestId('chat-row-rename')).toBeNull();
    // No second `list_chats` for the tab switch.
    expect(client.calls.filter((call) => call.name === 'list_chats')).toHaveLength(1);
  });

  it('shows the archived empty state when nothing is archived', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: FIXTURE.filter((c) => c.archivedAt === null) }),
    });
    renderList(client);
    await screen.findByTestId('chats-list');
    fireEvent.click(screen.getByTestId('chats-tab-archived'));
    expect(screen.getByTestId('chats-archived-empty')).toBeTruthy();
  });
});

describe('ChatListPage archive / restore (W1, kit/confirm low + undo)', () => {
  it('archives on one click, splices the row out of 活跃, and undo from the toast restores it', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: FIXTURE }),
      archive_chat: (params) =>
        chat({
          ...FIXTURE[1],
          id: (params as { chatId: string }).chatId,
          archivedAt: '2026-09-05T00:00:00.000Z',
        }),
      unarchive_chat: (params) =>
        chat({ ...FIXTURE[1], id: (params as { chatId: string }).chatId, archivedAt: null }),
    });
    renderList(client);
    await screen.findByTestId('chats-list');

    const opsRow = screen.getAllByTestId('chat-row')[1] as HTMLElement;
    fireEvent.click(within(opsRow).getByTestId('chat-row-archive'));
    await waitFor(() => expect(rowTitles()).toEqual(['新对话']));
    expect(client.calls.at(-1)).toEqual({ name: 'archive_chat', params: { chatId: 'c-ops' } });
    expect(screen.getByTestId('chats-tab-archived').textContent).toContain('2');

    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toContain('已归档 ·');
    fireEvent.click(within(toast).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(rowTitles()).toEqual(['新对话', 'Ops chat']));
    expect(client.calls.at(-1)).toEqual({ name: 'unarchive_chat', params: { chatId: 'c-ops' } });
    // Still one `list_chats`: every change was a splice.
    expect(client.calls.filter((call) => call.name === 'list_chats')).toHaveLength(1);
  });

  it('恢复 on the 已归档 tab restores and moves the row back to 活跃', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: FIXTURE }),
      unarchive_chat: () => chat({ ...FIXTURE[2], archivedAt: null }),
    });
    renderList(client);
    await screen.findByTestId('chats-list');
    fireEvent.click(screen.getByTestId('chats-tab-archived'));
    fireEvent.click(screen.getByTestId('chat-row-restore'));
    await screen.findByTestId('chats-archived-empty');
    expect(client.calls.at(-1)).toEqual({ name: 'unarchive_chat', params: { chatId: 'c-old' } });
    fireEvent.click(screen.getByTestId('chats-tab-active'));
    expect(rowTitles()).toEqual(['新对话', 'Ops chat', 'Old incident']);
    expect((await screen.findByTestId('toast')).textContent).toContain('已恢复');
  });

  it('surfaces an archive failure in the toast and keeps the row', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: FIXTURE }),
      archive_chat: () => {
        throw new Error('forbidden');
      },
    });
    renderList(client);
    await screen.findByTestId('chats-list');
    const opsRow = screen.getAllByTestId('chat-row')[1] as HTMLElement;
    fireEvent.click(within(opsRow).getByTestId('chat-row-archive'));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toContain('失败');
    expect(rowTitles()).toEqual(['新对话', 'Ops chat']);
  });
});

describe('ChatListPage archive undo across a remount (遗留 57)', () => {
  /** `ToastProvider` / `ChatUpdatesProvider` stand in for `App.tsx`'s app-root mount, which stays
   *  up across `routes.tsx` swapping the page under it — exactly what `showList: false` then
   *  `true` simulates (navigate away from the list, then back to a *fresh* instance of it). */
  function Harness({ client, showList }: { client: CapabilityCaller; showList: boolean }) {
    return (
      <ToastProvider>
        <ChatUpdatesProvider>
          {showList ? (
            <ChatListPage client={client} http={client} onSelectChat={vi.fn()} />
          ) : (
            <div data-testid="elsewhere" />
          )}
        </ChatUpdatesProvider>
      </ToastProvider>
    );
  }

  it('an Undo fired after the archiving list instance unmounted still updates a freshly remounted list', async () => {
    // A *stateful* fake — unlike `scriptedClient`'s usual static fixtures, `list_chats` here must
    // reflect what `archive_chat`/`unarchive_chat` actually did, the same way the real kernel
    // would, so a remount's own fresh fetch is a meaningful "true server state at that moment"
    // rather than always resetting to the pristine fixture.
    const rows = new Map(FIXTURE.map((row) => [row.id, row]));
    const client = scriptedClient({
      list_chats: () => ({ items: [...rows.values()] }),
      archive_chat: (params) => {
        const id = (params as { chatId: string }).chatId;
        const updated = chat({ ...rows.get(id), archivedAt: '2026-09-05T00:00:00.000Z' });
        rows.set(id, updated);
        return updated;
      },
      unarchive_chat: (params) => {
        const id = (params as { chatId: string }).chatId;
        const updated = chat({ ...rows.get(id), archivedAt: null });
        rows.set(id, updated);
        return updated;
      },
    });
    const { rerender } = render(<Harness client={client} showList={true} />);
    await screen.findByTestId('chats-list');

    const opsRow = screen.getAllByTestId('chat-row')[1] as HTMLElement;
    fireEvent.click(within(opsRow).getByTestId('chat-row-archive'));
    await waitFor(() => expect(rowTitles()).toEqual(['新对话']));
    const toast = await screen.findByTestId('toast');

    // Navigate away (unmount this ChatListPage instance — its own `onChanged` closure, and the
    // `ChatArchiveConfirm` that captured it, are now dead) and back (a brand-new instance, its own
    // fresh `list_chats` call — still showing the archive, the true server state at that moment).
    rerender(<Harness client={client} showList={false} />);
    expect(screen.queryByTestId('chats-list')).toBeNull();
    rerender(<Harness client={client} showList={true} />);
    await screen.findByTestId('chats-list');
    expect(rowTitles()).toEqual(['新对话']);

    // The toast (owned by the app-root ToastProvider, never unmounted) survived both transitions.
    // Its Undo still targets the *original*, now-doubly-unmounted ChatListPage's `onChanged` — but
    // the broadcast (hooks/useChatUpdates.tsx) reaches the *current* mount's own listener too, so
    // the already-rendered fresh list updates live, no further remount or `list_chats` call needed.
    const listChatsCallsBeforeUndo = client.calls.filter((c) => c.name === 'list_chats').length;
    fireEvent.click(within(toast).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(rowTitles()).toEqual(['新对话', 'Ops chat']));
    expect(client.calls.filter((c) => c.name === 'list_chats')).toHaveLength(
      listChatsCallsBeforeUndo,
    );
  });
});

describe('ChatListPage rename (W1)', () => {
  it('改名', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: FIXTURE }),
      rename_chat: (params) => chat({ ...FIXTURE[1], title: (params as { title: string }).title }),
    });
    const { onSelectChat } = renderList(client);
    await screen.findByTestId('chats-list');
    const opsRow = screen.getAllByTestId('chat-row')[1] as HTMLElement;
    fireEvent.click(within(opsRow).getByTestId('chat-row-rename'));
    const input = within(opsRow).getByTestId('chat-rename-input') as HTMLInputElement;
    expect(input.value).toBe('Ops chat');
    fireEvent.change(input, { target: { value: '  Ops   chat — web-1  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(rowTitles()).toEqual(['新对话', 'Ops chat — web-1']));
    expect(client.calls.at(-1)).toEqual({
      name: 'rename_chat',
      params: { chatId: 'c-ops', title: 'Ops chat — web-1' },
    });
    expect(screen.queryByTestId('chat-rename-form')).toBeNull();
    // Typing in the editor never opened the chat.
    expect(onSelectChat).not.toHaveBeenCalled();
  });

  it('refuses a blank title without calling the kernel; Escape cancels', async () => {
    const client = scriptedClient({ list_chats: () => ({ items: FIXTURE }) });
    renderList(client);
    await screen.findByTestId('chats-list');
    const opsRow = screen.getAllByTestId('chat-row')[1] as HTMLElement;
    fireEvent.click(within(opsRow).getByTestId('chat-row-rename'));
    const input = within(opsRow).getByTestId('chat-rename-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(within(opsRow).getByTestId('chat-rename-save'));
    expect((await within(opsRow).findByRole('alert')).textContent).toContain('标题不能为空');
    expect(client.calls.some((call) => call.name === 'rename_chat')).toBe(false);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('chat-rename-form')).toBeNull();
    expect(rowTitles()).toEqual(['新对话', 'Ops chat']);
  });

  it('shows the kernel error inline when rename is refused', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: FIXTURE }),
      rename_chat: () => {
        throw new Error('chat belongs to another principal');
      },
    });
    renderList(client);
    await screen.findByTestId('chats-list');
    const opsRow = screen.getAllByTestId('chat-row')[1] as HTMLElement;
    fireEvent.click(within(opsRow).getByTestId('chat-row-rename'));
    const input = within(opsRow).getByTestId('chat-rename-input');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await within(opsRow).findByRole('alert')).textContent).toContain(
      'belongs to another principal',
    );
    expect(within(opsRow).getByTestId('chat-rename-form')).toBeTruthy();
  });
});

describe('ChatListPage new chat', () => {
  it('creates a chat and opens it', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: [] }),
      new_chat: () => chat({ id: 'c-new', title: null }),
    });
    const { onSelectChat } = renderList(client);
    await screen.findByTestId('chats-empty');
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /新对话/ })[0] as HTMLElement);
    });
    await waitFor(() => expect(onSelectChat).toHaveBeenCalledWith('c-new'));
    expect(client.calls.at(-1)).toEqual({ name: 'new_chat', params: {} });
  });
});
