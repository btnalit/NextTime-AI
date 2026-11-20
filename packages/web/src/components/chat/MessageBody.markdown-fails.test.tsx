// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBody } from './MessageBody.js';

// Legacy 880: the Markdown chunk failing to load, as a network change mid-fetch makes it.
vi.mock('../kit/markdown.js', () => {
  throw new Error('Failed to fetch dynamically imported module: https://x/assets/markdown-a.js');
});

afterEach(cleanup);

describe('chat/MessageBody when the Markdown chunk does not load (legacy 880)', () => {
  it('shows the reply as plain text and stays inside the message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container } = render(
        <div data-testid="page">
          <MessageBody messageRole="assistant" text={'**bold** reply'} />
          <textarea defaultValue="unsent draft" />
        </div>,
      );
      await waitFor(() =>
        expect(container.querySelector('[data-markdown="unavailable"]')).toBeTruthy(),
      );
      expect(container.querySelector('.message-bubble.message-text')?.textContent).toBe(
        '**bold** reply',
      );
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('unsent draft');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
