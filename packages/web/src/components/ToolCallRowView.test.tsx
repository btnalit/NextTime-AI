// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolCallRowView } from './ToolCallRowView.js';

afterEach(cleanup);

describe('ToolCallRowView', () => {
  it('renders "failed" with data-tool-outcome="failed" when the row is ended with isError:true', () => {
    render(
      <ToolCallRowView
        row={{
          toolCallId: 'c1',
          name: 'bash',
          status: 'ended',
          result: { ok: false },
          isError: true,
        }}
      />,
    );
    const chip = screen.getByText('failed');
    expect(chip.getAttribute('data-tool-outcome')).toBe('failed');
  });

  it('renders "done" for an ended row without isError', () => {
    render(
      <ToolCallRowView
        row={{
          toolCallId: 'c1',
          name: 'bash',
          status: 'ended',
          result: { ok: true },
        }}
      />,
    );
    const chip = screen.getByText('done');
    expect(chip.getAttribute('data-tool-outcome')).toBe('ok');
  });
});
