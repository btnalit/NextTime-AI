// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from './copy-button.js';

afterEach(cleanup);

describe('kit/CopyButton', () => {
  it('copies the given value to the clipboard and shows a transient "copied" state', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton value="sk-once-fixture" label="API key" />);
    const button = screen.getByRole('button', { name: /复制API key/ });
    fireEvent.click(button);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('sk-once-fixture'));
    await vi.waitFor(() => expect(button.getAttribute('aria-label')).toBe('已复制'));
  });
});
