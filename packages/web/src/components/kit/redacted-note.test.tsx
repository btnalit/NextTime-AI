// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RedactedNote, showsRedaction } from './redacted-note.js';

afterEach(cleanup);

describe('kit/redacted-note (legacy 420)', () => {
  it('finds the mask in a string or anywhere in a JSON value', () => {
    expect(showsRedaction('PGPASSWORD=[redacted] psql')).toBe(true);
    expect(showsRedaction({ reason: 'ok', steps: [{ note: 'token=[redacted]' }] })).toBe(true);
    expect(showsRedaction({ reason: 'the token expired', count: 3 })).toBe(false);
    expect(showsRedaction(null)).toBe(false);
  });

  it('says what [redacted] stands for under masked text', () => {
    render(<RedactedNote value="rejected: PGPASSWORD=[redacted] is inline" testId="note" />);
    expect(screen.getByTestId('note').textContent).toContain('[redacted] 处的内容看起来像密码');
  });

  it('renders nothing when nothing was masked', () => {
    const { container } = render(<RedactedNote value="the token expired" testId="note" />);
    expect(container.innerHTML).toBe('');
  });
});
