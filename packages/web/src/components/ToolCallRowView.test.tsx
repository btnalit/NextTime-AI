// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistedToolCallRowView, ToolCallRowView } from './ToolCallRowView.js';

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
    const chip = screen.getByText('失败');
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
    const chip = screen.getByText('完成');
    expect(chip.getAttribute('data-tool-outcome')).toBe('ok');
  });

  it('says what a gate refusal in the result means and what to do, above the raw result (review of #538, G3)', () => {
    render(
      <ToolCallRowView
        row={{
          toolCallId: 'c1',
          name: 'nexttime_request_action',
          status: 'ended',
          args: { gatekeeperId: 'gk-1', name: 'db.restart', params: {} },
          result: {
            status: 'failed',
            reason:
              'operation_definition_mismatch: operation "db.restart": the definition that was approved (0123456789ab) is not the one this gate runs (ba9876543210) — refused, nothing ran.',
          },
        }}
      />,
    );
    const note = screen.getByTestId('tool-call-gate-reason');
    expect(note.textContent).toContain('门运行的定义和批准的不一样');
    expect(note.textContent).toContain('与门公告对齐');
    // The raw result stays as the agent saw it.
    expect(screen.getByText(/is not the one this gate runs/)).toBeTruthy();
    // UX acceptance of #538: the note links to the system the call went to.
    expect(screen.getByTestId('tool-call-gate-reason-link').getAttribute('href')).toBe(
      '#/govern/systems/gk-1',
    );
  });

  it('has nothing to add to a result that names no gate refusal', () => {
    render(
      <ToolCallRowView
        row={{ toolCallId: 'c1', name: 'bash', status: 'ended', result: { ok: true } }}
      />,
    );
    expect(screen.queryByTestId('tool-call-gate-reason')).toBeNull();
  });
});

describe('PersistedToolCallRowView', () => {
  it('explains a request made against no definition (operation_definition_unavailable)', () => {
    render(
      <PersistedToolCallRowView
        record={{
          toolCallId: 'c2',
          name: 'nexttime_request_action',
          outcome: 'done',
          result: {
            text: '{"status":"failed","reason":"operation_definition_unavailable: \\"k.op\\" was requested while it was not published and had no draft"}',
            truncated: false,
            totalChars: 120,
          },
          redactedValues: 0,
          startedAt: null,
          endedAt: null,
        }}
      />,
    );
    const note = screen.getByTestId('tool-call-gate-reason');
    expect(note.textContent).toContain('没有批准过的定义');
    expect(note.textContent).toContain('先在能力目录发布它');
    // No arguments recorded: nothing to link to.
    expect(screen.queryByTestId('tool-call-gate-reason-link')).toBeNull();
  });

  it('links the note to the system its recorded arguments name, and to none when they were cut short', () => {
    const record = (argsText: string, truncated: boolean) => ({
      toolCallId: 'c3',
      name: 'nexttime_request_action',
      outcome: 'done' as const,
      args: { text: argsText, truncated, totalChars: argsText.length },
      result: {
        text: '{"status":"failed","reason":"operation_definition_mismatch: refused"}',
        truncated: false,
        totalChars: 70,
      },
      redactedValues: 0,
      startedAt: null,
      endedAt: null,
    });
    const { unmount } = render(
      <PersistedToolCallRowView
        record={record('{"gatekeeperId":"gk 2","name":"stock.get"}', false)}
      />,
    );
    expect(screen.getByTestId('tool-call-gate-reason-link').getAttribute('href')).toBe(
      '#/govern/systems/gk%202',
    );
    unmount();
    render(<PersistedToolCallRowView record={record('{"gatekeeperId":"gk', true)} />);
    expect(screen.getByTestId('tool-call-gate-reason')).toBeTruthy();
    expect(screen.queryByTestId('tool-call-gate-reason-link')).toBeNull();
  });
});
