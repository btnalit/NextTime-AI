// @vitest-environment jsdom
import type { ChatWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ChatRenameForm } from './ChatRenameForm.js';

afterEach(cleanup);

const CHAT: ChatWire = {
  id: 'chat-1',
  ownerPrincipalId: 'p-1',
  title: 'Ops chat',
  visibility: 'private',
  createdAt: '2026-09-01T00:00:00.000Z',
  archivedAt: null,
};

function renderForm(
  call = vi.fn(async (_n: string, p: unknown) => ({ ...CHAT, ...(p as object) })),
) {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const client = { call } as unknown as CapabilityCaller;
  render(<ChatRenameForm client={client} chat={CHAT} onSaved={onSaved} onCancel={onCancel} />);
  return { call, onSaved, onCancel };
}

describe('ChatRenameForm', () => {
  it('starts focused with the current title selected', () => {
    renderForm();
    const input = screen.getByTestId('chat-rename-input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Ops chat');
  });

  it('saving an unchanged title is a cancel, not a call', () => {
    const { call, onCancel, onSaved } = renderForm();
    fireEvent.click(screen.getByTestId('chat-rename-save'));
    expect(call).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('cuts an over-long title to 200 code points before calling rename_chat', async () => {
    const { call, onSaved } = renderForm();
    fireEvent.change(screen.getByTestId('chat-rename-input'), {
      target: { value: '龙'.repeat(250) },
    });
    fireEvent.click(screen.getByTestId('chat-rename-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const params = call.mock.calls[0]?.[1] as { title: string };
    expect(Array.from(params.title)).toHaveLength(200);
  });

  it('a composing Enter (IME) does not save', () => {
    const { call } = renderForm();
    const input = screen.getByTestId('chat-rename-input');
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(call).not.toHaveBeenCalled();
  });
});
