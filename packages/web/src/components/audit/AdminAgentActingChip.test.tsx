// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LangProvider } from '../../lib/i18n.js';
import { AdminAgentActingChip, actedByAdminAgent } from './AdminAgentActingChip.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Legacy 583 (S11 AA4c-3): an audit row the person's admin agent wrote in their name says so. */
describe('AdminAgentActingChip', () => {
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

  it('renders beside an admin agent row only, in the reader’s language', () => {
    const { rerender } = render(
      <LangProvider>
        <AdminAgentActingChip payload={{ sessionKind: 'admin_agent', sessionId: 's-1' }} />
      </LangProvider>,
    );
    expect(screen.getByTestId('audit-admin-agent').textContent).toBe('由管理员智能体代为');
    rerender(
      <LangProvider>
        <AdminAgentActingChip payload={{ gateId: 'g' }} />
      </LangProvider>,
    );
    expect(screen.queryByTestId('audit-admin-agent')).toBeNull();
    cleanup();

    localStorage.setItem('nexttime.lang', 'en');
    render(
      <LangProvider>
        <AdminAgentActingChip payload={{ sessionKind: 'admin_agent', sessionId: 's-1' }} />
      </LangProvider>,
    );
    expect(screen.getByTestId('audit-admin-agent').textContent).toBe('By their admin agent');
  });
});
