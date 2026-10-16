// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistedToolCallRowView, ToolCallGroupView, ToolCallRowView } from './ToolCallRowView.js';

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

  // Legacy 287: a failed action says whether it left the platform — not sent, or outcome unknown.
  it.each([
    [
      'gate_unreachable: gatekeeper client: gate/apply not sent — could not connect to the gate (ECONNREFUSED); nothing reached it',
      '没发出：连不上门',
      '什么都没有执行',
    ],
    [
      'outcome_unknown: apply for actionRequestId \\"a1\\" has an unknown outcome',
      '结果不明',
      '不要直接重试',
    ],
  ])(
    'tells a failed action that was not sent from one whose outcome is unknown (%#)',
    (reason, title, step) => {
      render(
        <PersistedToolCallRowView
          record={{
            toolCallId: 'c287',
            name: 'nexttime_request_action',
            outcome: 'done',
            result: {
              text: `{"status":"failed","reason":"${reason}"}`,
              truncated: false,
              totalChars: 160,
            },
            redactedValues: 0,
            startedAt: null,
            endedAt: null,
          }}
        />,
      );
      const note = screen.getByTestId('tool-call-gate-reason');
      expect(note.textContent).toContain(title);
      expect(note.textContent).toContain(step);
    },
  );
});

// UX acceptance of #586: the chip, the note and the raw result say the same thing, the note's
// tone matches how much harm a misread does, and an outcome-unknown note names what to check.
describe('legacy 287: one reading of a gate action', () => {
  const persisted = (resultText: string, argsText?: string) => ({
    toolCallId: 'c287',
    name: 'docker_container_restart',
    outcome: 'done' as const,
    ...(argsText !== undefined
      ? { args: { text: argsText, truncated: false, totalChars: argsText.length } }
      : {}),
    result: { text: resultText, truncated: false, totalChars: resultText.length },
    redactedValues: 0,
    startedAt: null,
    endedAt: null,
  });
  const failedWith = (reason: string) =>
    JSON.stringify({ id: 'ar-1', status: 'failed', reason }, null, 2);

  it('outcome unknown: a danger note naming the action, no system link, an outcome-unknown chip', () => {
    render(
      <PersistedToolCallRowView
        record={persisted(
          failedWith('outcome_unknown: apply for actionRequestId "ar-1" has an unknown outcome'),
          '{"gatekeeperId":"gk-1","name":"media"}',
        )}
      />,
    );
    const note = screen.getByTestId('tool-call-gate-reason');
    expect(note.className).toContain('notice-danger');
    expect(note.textContent).toContain('核对 docker_container_restart（name: media）是否已生效');
    expect(screen.getByTestId('tool-call-gate-reason-raw-status').textContent).toContain(
      '不表示动作没有执行',
    );
    expect(screen.queryByTestId('tool-call-gate-reason-link')).toBeNull();
    // The chip says what the note's title says.
    const chip = document.querySelector('[data-action-outcome]') as HTMLElement;
    expect(chip.textContent).toBe('结果不明');
    expect(note.textContent).toContain('结果不明');
    expect(chip.getAttribute('data-action-outcome')).toBe('outcome_unknown');
    // The tool call itself finished: the transcript's own hook is unchanged.
    expect(chip.getAttribute('data-tool-outcome')).toBe('done');
  });

  it.each([
    [
      'gate_unreachable: … not sent — could not connect to the gate (ECONNREFUSED)',
      '没发出：连不上门',
    ],
    [
      'apply_not_received: the gate holds no record of this request having run',
      '没执行：门上没有执行记录',
    ],
  ])('not sent (%#): a plain note and a did-not-run chip', (reason, title) => {
    render(
      <PersistedToolCallRowView
        record={persisted(failedWith(reason), '{"gatekeeperId":"gk-1","name":"media"}')}
      />,
    );
    const note = screen.getByTestId('tool-call-gate-reason');
    expect(note.className).toBe('notice');
    expect(note.textContent).toContain(title);
    expect(screen.getByTestId('tool-call-gate-reason-link')).toBeTruthy();
    expect(screen.getByText('没执行').getAttribute('data-action-outcome')).toBe('not_run');
  });

  it('a live row stuck in executing with no answer says the outcome is unknown and the platform is asking', () => {
    const outcome = {
      id: 'ar-2',
      status: 'executing',
      outcomeInDoubt: {
        since: '2026-10-16T07:00:00.000Z',
        reason: 'gate_connection_lost: … the request may have reached the gate',
      },
    };
    render(
      <ToolCallRowView
        row={{
          toolCallId: 'c1',
          name: 'docker_container_restart',
          status: 'ended',
          args: { name: 'media' },
          result: {
            content: [{ type: 'text', text: JSON.stringify(outcome, null, 2) }],
            details: outcome,
          },
        }}
      />,
    );
    const chip = screen.getByText('结果不明·查询中');
    expect(chip.className).toContain('chip-danger');
    expect(chip.getAttribute('data-action-outcome')).toBe('in_doubt');
    const waiting = screen.getByTestId('tool-call-waiting');
    expect(waiting.className).toContain('notice-danger');
    expect(waiting.textContent).toContain('动作结果不明，平台正在向门查询');
    expect(waiting.textContent).toContain('从不重新执行');
  });

  it('an approved row held back by an earlier one says it is queued, and why', () => {
    render(
      <PersistedToolCallRowView
        record={persisted(
          JSON.stringify(
            {
              id: 'ar-3',
              status: 'approved',
              queuedBehind: { status: 'pending_approval', outcomeInDoubt: false },
            },
            null,
            2,
          ),
        )}
      />,
    );
    const chip = document.querySelector('[data-action-outcome]') as HTMLElement;
    expect(chip.textContent).toBe('排队中');
    expect(chip.getAttribute('data-action-outcome')).toBe('queued');
    const waiting = screen.getByTestId('tool-call-waiting');
    expect(waiting.className).toBe('notice');
    expect(waiting.textContent).toContain('还在等审批');
  });

  it('opens the group and counts an action whose outcome is unknown', () => {
    render(
      <ToolCallGroupView
        records={[
          persisted(JSON.stringify({ id: 'ar-1', status: 'executed' }, null, 2)),
          { ...persisted(failedWith('outcome_unknown: …')), toolCallId: 'c288' },
        ]}
      />,
    );
    const group = screen.getByTestId('tool-call-group') as HTMLDetailsElement;
    expect(group.open).toBe(true);
    expect(screen.getByTestId('tool-call-group-outcome-unknown').textContent).toBe('1 个结果不明');
  });

  it('a plain tool result keeps the plain chip', () => {
    render(
      <PersistedToolCallRowView
        record={persisted(JSON.stringify({ data: { status: 'failed' } }))}
      />,
    );
    const chip = screen.getByText('完成');
    expect(chip.hasAttribute('data-action-outcome')).toBe(false);
  });
});
