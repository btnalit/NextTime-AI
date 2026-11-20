// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { LangProvider } from '../../lib/i18n.js';
import { ChatListPane } from './ChatListPane.js';

afterEach(cleanup);

/** Legacy 668: an open chat's page has one h1, the chat's own title (`ChatHeader`); the list pane
 *  beside it titles itself as a section. Alone (the chat list page) it is the page's h1. */
const client: CapabilityCaller = {
  call: vi.fn(async () => ({ items: [] })) as CapabilityCaller['call'],
};

function renderPane(selectedChatId?: string) {
  render(
    <LangProvider>
      <ChatListPane
        client={client}
        selectedChatId={selectedChatId}
        onSelectChat={() => undefined}
        initialHash="#/work/chats"
      />
    </LangProvider>,
  );
}

describe('ChatListPane heading (legacy 668)', () => {
  it('is the page h1 on the chat list page', () => {
    renderPane();
    expect(screen.getByRole('heading', { name: '对话' }).tagName).toBe('H1');
  });

  it('is an h2 beside an open chat, whose title is the h1', () => {
    renderPane('chat-1');
    expect(screen.getByRole('heading', { name: '对话' }).tagName).toBe('H2');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});
