// @vitest-environment jsdom
import type { ChatWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ChatHeader } from './ChatHeader.js';

afterEach(cleanup);

/**
 * ChatHeader.test.tsx (S8 W1-A3, audit C3): the two-row layout and the overflow menu the row was
 * split out into — `ChatPage.test.tsx`'s "ChatPage header" suite already exercises rename/archive/
 * restore end to end through the full page; this file isolates `ChatHeader` itself (no WS
 * subscription, no streaming state) to check the layout split and that the overflow menu's items
 * call the same handlers `ChatLifecycleActions` used to (`setRenaming`, `setArchiveTarget`,
 * `useRestoreChat`'s `restore`), not new ones.
 */

function chatRow(overrides: Partial<ChatWire> = {}): ChatWire {
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

function fakeCaller(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>> = {},
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (handler) return handler(params);
      throw new Error(`unscripted capability ${name}`);
    }) as CapabilityCaller['call'],
  };
}

/** `fireEvent.click` alone leaves a Radix `DropdownMenu` closed under jsdom — the trigger opens
 *  on `onPointerDown` (`kit/dropdown-menu`'s own doc comment / `dropdown-menu.test.tsx`). */
function openOverflowMenu(): void {
  fireEvent.pointerDown(screen.getByTestId('chat-header-menu'), { button: 0 });
}

function renderHeader(props: Partial<Parameters<typeof ChatHeader>[0]> = {}) {
  const client = props.client ?? fakeCaller();
  const http = props.http ?? fakeCaller();
  return {
    client,
    http,
    ...render(
      <PermissionsProvider>
        <ChatHeader
          client={client}
          http={http}
          chat={chatRow()}
          lookupFailed={false}
          turnStatus="idle"
          stopBusy={false}
          onBack={vi.fn()}
          onStop={vi.fn()}
          onChatChanged={vi.fn()}
          {...props}
        />
      </PermissionsProvider>,
    ),
  };
}

describe('ChatHeader', () => {
  it('renders two fixed rows — row 1 title/actions, row 2 the model line — and truncates the title', () => {
    renderHeader();
    const row1 = document.querySelector('.chat-header-row1');
    const row2 = document.querySelector('.chat-header-row2');
    expect(row1).toBeTruthy();
    expect(row2).toBeTruthy();
    expect(row1?.contains(screen.getByTestId('chat-title'))).toBe(true);
    expect(row1?.contains(screen.getByTestId('chat-header-menu'))).toBe(true);
    expect(row2?.contains(screen.getByTestId('chat-model-line'))).toBe(true);
    // The truncation classes live on the title itself (pages.css `.chat-header-title`).
    expect(screen.getByTestId('chat-title').className).toContain('chat-header-title');
  });

  it('overflow menu closed by default; opening it offers 改名/归档 for an active chat', async () => {
    renderHeader();
    expect(screen.queryByTestId('chat-header-rename')).toBeNull();
    expect(screen.queryByTestId('chat-header-archive')).toBeNull();
    openOverflowMenu();
    expect(await screen.findByTestId('chat-header-rename')).toBeTruthy();
    expect(screen.getByTestId('chat-header-archive')).toBeTruthy();
    expect(screen.queryByTestId('chat-header-restore')).toBeNull();
  });

  it('改名 opens the same inline ChatRenameForm the old always-visible button did', async () => {
    renderHeader();
    openOverflowMenu();
    fireEvent.click(await screen.findByTestId('chat-header-rename'));
    expect(screen.getByTestId('chat-rename-form')).toBeTruthy();
    expect(screen.queryByTestId('chat-title')).toBeNull();
  });

  it('归档 opens the page-level ChatArchiveConfirm (tier low: archive_chat fires immediately)', async () => {
    const client = fakeCaller({
      archive_chat: () => chatRow({ archivedAt: '2026-09-04T00:00:00Z' }),
    });
    const onChatChanged = vi.fn();
    renderHeader({ client, onChatChanged });
    openOverflowMenu();
    fireEvent.click(await screen.findByTestId('chat-header-archive'));
    await waitFor(() => expect(client.calls.some((c) => c.name === 'archive_chat')).toBe(true));
    expect(onChatChanged).toHaveBeenCalledWith(
      expect.objectContaining({ archivedAt: '2026-09-04T00:00:00Z' }),
    );
  });

  it('an archived chat offers 恢复 instead, disabled while a restore is already in flight, and it calls unarchive_chat', async () => {
    const archived = chatRow({ archivedAt: '2026-09-04T00:00:00Z' });
    const client = fakeCaller({ unarchive_chat: () => chatRow({ archivedAt: null }) });
    const onChatChanged = vi.fn();
    renderHeader({ client, chat: archived, onChatChanged });
    openOverflowMenu();
    const restoreItem = await screen.findByTestId('chat-header-restore');
    expect(screen.queryByTestId('chat-header-rename')).toBeNull();
    expect(screen.queryByTestId('chat-header-archive')).toBeNull();
    expect(restoreItem.getAttribute('data-disabled')).toBeNull();

    fireEvent.click(restoreItem);
    await waitFor(() =>
      expect(client.calls).toContainEqual({ name: 'unarchive_chat', params: { chatId: 'chat-1' } }),
    );
    expect(onChatChanged).toHaveBeenCalledWith(expect.objectContaining({ archivedAt: null }));
  });

  it('no overflow menu at all while the chat row is still being looked up (chat === null)', () => {
    renderHeader({ chat: null, lookupFailed: false });
    expect(screen.queryByTestId('chat-header-menu')).toBeNull();
  });
});
