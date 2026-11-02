// @vitest-environment jsdom
import type { ChatWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
import { ChatListPane } from './ChatListPane.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** S11 AA4c-3: a platform administrator's admin agent chats in a trial workspace's chat list — the
 *  新管理员对话 button, the row marker, and `?open=admin_agent` (平台 · 管理员智能体's
 *  打开管理员对话) landing on their latest admin agent chat, or starting one. */

function chat(overrides: Partial<ChatWire> = {}): ChatWire {
  return {
    id: 'chat-1',
    ownerPrincipalId: 'p-1',
    title: 'Ops chat',
    visibility: 'private',
    createdAt: '2026-11-01T00:00:00.000Z',
    archivedAt: null,
    lastActivityAt: '2026-11-01T00:00:00.000Z',
    hasRunningTurn: false,
    agentKind: 'entry',
    ...overrides,
  };
}

function scriptedClient(
  handlers: Record<string, (params: unknown) => unknown>,
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

function renderPane(
  client: CapabilityCaller,
  options: { adminAgent?: boolean; hash?: string; english?: boolean } = {},
) {
  if (options.english) localStorage.setItem('nexttime.lang', 'en');
  const onSelectChat = vi.fn();
  render(
    <LangProvider>
      <ChatListPane
        client={client}
        onSelectChat={onSelectChat}
        adminAgent={options.adminAgent}
        initialHash={options.hash ?? '#/work/chats'}
      />
    </LangProvider>,
  );
  return { onSelectChat };
}

const ADMIN_OLD = chat({
  id: 'c-admin-old',
  title: '试 RAGFlow 接入',
  agentKind: 'admin_agent',
  lastActivityAt: '2026-11-01T08:00:00.000Z',
});
const ADMIN_NEW = chat({
  id: 'c-admin-new',
  title: '试新的运维流程',
  agentKind: 'admin_agent',
  lastActivityAt: '2026-11-02T08:00:00.000Z',
});
const ADMIN_ARCHIVED = chat({
  id: 'c-admin-archived',
  title: '旧的试验',
  agentKind: 'admin_agent',
  lastActivityAt: '2026-11-02T10:00:00.000Z',
  archivedAt: '2026-11-02T11:00:00.000Z',
});
const ENTRY = chat({ id: 'c-entry', lastActivityAt: '2026-11-02T12:00:00.000Z' });

describe('ChatListPane admin agent chats (S11 AA4c-3)', () => {
  it('marks admin agent chats and starts a new one with agentKind admin_agent', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: [ENTRY, ADMIN_NEW] }),
      new_chat: () => chat({ id: 'c-created', title: null, agentKind: 'admin_agent' }),
    });
    const { onSelectChat } = renderPane(client, { adminAgent: true });

    await screen.findByTestId('chats-list');
    const rows = screen.getAllByTestId('chat-row');
    const marked = rows.filter((row) => within(row).queryByTestId('chat-admin-agent-chip'));
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain('试新的运维流程');
    expect(within(marked[0] as HTMLElement).getByTestId('chat-admin-agent-chip').textContent).toBe(
      '管理员智能体',
    );

    fireEvent.click(screen.getByTestId('new-admin-agent-chat'));
    await waitFor(() => expect(onSelectChat).toHaveBeenCalledWith('c-created'));
    expect(client.calls.filter((call) => call.name === 'new_chat')).toEqual([
      { name: 'new_chat', params: { agentKind: 'admin_agent' } },
    ]);
  });

  it('offers no admin agent chat outside a trial workspace, and ignores the open preset there', async () => {
    const client = scriptedClient({ list_chats: () => ({ items: [ENTRY] }) });
    const { onSelectChat } = renderPane(client, { hash: '#/work/chats?open=admin_agent' });

    await screen.findByTestId('chats-list');
    expect(screen.queryByTestId('new-admin-agent-chat')).toBeNull();
    expect(onSelectChat).not.toHaveBeenCalled();
    expect(client.calls.map((call) => call.name)).toEqual(['list_chats']);
  });

  it('opens the latest active admin agent chat on ?open=admin_agent, once', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: [ADMIN_OLD, ENTRY, ADMIN_ARCHIVED, ADMIN_NEW] }),
    });
    const { onSelectChat } = renderPane(client, {
      adminAgent: true,
      hash: '#/work/chats?open=admin_agent',
    });

    await waitFor(() => expect(onSelectChat).toHaveBeenCalledWith('c-admin-new'));
    expect(onSelectChat).toHaveBeenCalledTimes(1);
    expect(client.calls.some((call) => call.name === 'new_chat')).toBe(false);
  });

  it('starts an admin agent chat on ?open=admin_agent when there is none yet', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: [ENTRY, ADMIN_ARCHIVED] }),
      new_chat: () => chat({ id: 'c-first', title: null, agentKind: 'admin_agent' }),
    });
    const { onSelectChat } = renderPane(client, {
      adminAgent: true,
      hash: '#/work/chats?open=admin_agent',
    });

    await waitFor(() => expect(onSelectChat).toHaveBeenCalledWith('c-first'));
    expect(client.calls.filter((call) => call.name === 'new_chat')).toEqual([
      { name: 'new_chat', params: { agentKind: 'admin_agent' } },
    ]);
  });

  it('says why an admin agent chat could not start', async () => {
    const client = scriptedClient({
      list_chats: () => ({ items: [] }),
      new_chat: () => {
        throw new HttpError('capability_error', 'admin agent refused', 'admin_agent_refused', {
          reason: 'switched_off',
        });
      },
    });
    renderPane(client, { adminAgent: true });

    await screen.findByTestId('new-admin-agent-chat');
    fireEvent.click(screen.getByTestId('new-admin-agent-chat'));
    const banner = await screen.findByTestId('chat-create-error');
    expect(banner.textContent).toContain('无法创建管理员对话');
    expect(banner.textContent).toContain('平台没有开启管理员智能体');
  });

  it('renders in English', async () => {
    const client = scriptedClient({ list_chats: () => ({ items: [ADMIN_NEW] }) });
    renderPane(client, { adminAgent: true, english: true });

    expect((await screen.findByTestId('new-admin-agent-chat')).textContent).toBe(
      'New admin agent chat',
    );
    expect((await screen.findByTestId('chat-admin-agent-chip')).textContent).toBe('Admin agent');
  });
});
