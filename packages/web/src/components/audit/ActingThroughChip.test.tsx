// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LangProvider } from '../../lib/i18n.js';
import { ActingThroughChip } from './ActingThroughChip.js';
import { actedByAdminAgent } from './AdminAgentActingChip.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function chip(actingThrough: string | null | undefined, payload: unknown = {}) {
  return (
    <LangProvider>
      <ActingThroughChip actingThrough={actingThrough} payload={payload} />
    </LangProvider>
  );
}

/** Legacy 583 (S11 AA4c-3): an audit row the person's admin agent wrote in their name says so. */
describe('actedByAdminAgent', () => {
  it('reads the acting session the kernel records beside the payload', () => {
    expect(actedByAdminAgent({ sessionKind: 'admin_agent', sessionId: 's-1', gateId: 'g' })).toBe(
      true,
    );
    for (const payload of [
      { sessionKind: 'entry' },
      { gateId: 'g' },
      null,
      undefined,
      'admin_agent',
      [{ sessionKind: 'admin_agent' }],
    ]) {
      expect(actedByAdminAgent(payload)).toBe(false);
    }
  });
});

/** Legacy 666: every audit row says what its act came through. */
describe('ActingThroughChip', () => {
  it('names each recorded value, in the reader’s language', () => {
    const { rerender } = render(chip('person'));
    const shown = () => screen.getByTestId('audit-acting-through');
    expect(shown().textContent).toBe('经由 本人');
    expect(shown().getAttribute('data-acting-through')).toBe('person');
    rerender(chip('worker_handle'));
    expect(shown().textContent).toMatch(/^经由 Worker$/);
    rerender(chip('member_handle'));
    expect(shown().textContent).toBe('经由 成员的 MCP 会话');
    rerender(chip('system'));
    expect(shown().textContent).toBe('经由 平台后台任务');
    cleanup();

    localStorage.setItem('nexttime.lang', 'en');
    const { rerender: rerenderEn } = render(chip('service_handle'));
    expect(shown().textContent).toBe('Via Service account');
    // UX P3-1 on #1035: "Through In person" did not read.
    rerenderEn(chip('person'));
    expect(shown().textContent).toBe('In person');
  });

  it('legacy 666: names the Worker or service account it came through, when the row does', () => {
    const named = (actingThrough: string, name: string | null) => (
      <LangProvider>
        <ActingThroughChip actingThrough={actingThrough} actingName={name} payload={{}} />
      </LangProvider>
    );
    const { rerender } = render(named('worker_handle', 'invoice-reader'));
    const shown = () => screen.getByTestId('audit-acting-through');
    expect(shown().textContent).toMatch(/^经由 Worker · invoice-reader$/);
    rerender(named('service_handle', 'nightly-sync'));
    expect(shown().textContent).toMatch(/^经由 服务账号 · nightly-sync$/);
    rerender(named('service_handle', null));
    expect(shown().textContent).toBe('经由 服务账号');
  });

  it('a row from before it was recorded says so, and explains why', () => {
    render(chip(null));
    const shown = screen.getByTestId('audit-acting-through');
    expect(shown.textContent).toBe('经由 未记录');
    expect(shown.getAttribute('data-acting-through')).toBe('unrecorded');
    expect(shown.getAttribute('title')).toContain('早于平台开始记录');
  });

  it('the admin agent keeps its own mark whenever the recorded value or the payload says so', () => {
    const { rerender } = render(chip('admin_agent_session'));
    // Legacy 670: worded as the filter names it, still the warning mark.
    expect(screen.getByTestId('audit-admin-agent').textContent).toMatch(/^经由 管理员智能体$/);
    expect(screen.getByTestId('audit-admin-agent').className).toContain('chip-warn');
    expect(screen.queryByTestId('audit-acting-through')).toBeNull();
    rerender(chip(null, { sessionKind: 'admin_agent', sessionId: 's-1' }));
    expect(screen.getByTestId('audit-admin-agent')).toBeTruthy();
    // The payload alone still shows it, whatever was recorded: the mark legacy 583 put on such
    // a row never goes away.
    rerender(chip('person', { sessionKind: 'admin_agent' }));
    expect(screen.getByTestId('audit-admin-agent')).toBeTruthy();
    // Neither says so: the plain chip.
    rerender(chip('person', { sessionKind: 'entry' }));
    expect(screen.queryByTestId('audit-admin-agent')).toBeNull();
    expect(screen.getByTestId('audit-acting-through').textContent).toBe('经由 本人');
  });
});
