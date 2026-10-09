// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { PrincipalRow } from '../../lib/governance.js';
import { IssueServiceHandleSection, isNameList } from './IssueServiceHandleSection.js';

afterEach(cleanup);

function service(id: string, displayName: string): PrincipalRow {
  return {
    id,
    kind: 'service',
    role: 'member',
    displayName,
    createdAt: '2026-09-01T00:00:00.000Z',
    hasApiKey: true,
  };
}

function renderSection(principals: readonly PrincipalRow[]) {
  const call = vi.fn(async (_name: string, params?: unknown) => ({
    handle: 'svc_handle',
    principalId: (params as { principalId: string }).principalId,
    sessionId: 'sess-1',
    expiresAt: '2026-11-01T00:00:00.000Z',
    scope: (params as { scope: string[] }).scope,
  }));
  const http = { call } as unknown as CapabilityCaller;
  render(<IssueServiceHandleSection http={http} principals={principals} onDone={vi.fn()} />);
  return { call };
}

function nameBox(): HTMLInputElement {
  return screen.getByRole('combobox', { name: /查找或粘贴能力名/ }) as HTMLInputElement;
}

describe('IssueServiceHandleSection — picked, not typed', () => {
  it('auto-selects the only service principal and says so', () => {
    renderSection([service('p-svc', 'CI runner')]);
    expect((screen.getByLabelText(/服务主体/) as HTMLSelectElement).value).toBe('p-svc');
    expect(screen.getByText(/已自动选中/)).toBeTruthy();
  });

  it('leaves the choice to the person when there are several service principals', () => {
    renderSection([service('p-a', 'A'), service('p-b', 'B')]);
    expect((screen.getByLabelText(/服务主体/) as HTMLSelectElement).value).toBe('');
    expect(screen.queryByText(/已自动选中/)).toBeNull();
  });

  it('the name box searches the handle-channel names and Enter ticks the match', async () => {
    const { call } = renderSection([service('p-svc', 'CI runner')]);
    fireEvent.change(nameBox(), { target: { value: 'report_task' } });
    const offered = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((option) => option.querySelector('.combobox-option-label')?.textContent);
    expect(offered).toContain('report_task_result');
    // Human-only capabilities are never offered.
    fireEvent.change(nameBox(), { target: { value: 'list_users' } });
    expect(
      within(screen.getByRole('listbox'))
        .queryAllByRole('option')
        .map((option) => option.querySelector('.combobox-option-label')?.textContent),
    ).not.toContain('list_users');

    fireEvent.change(nameBox(), { target: { value: 'report_task_res' } });
    fireEvent.keyDown(nameBox(), { key: 'Enter' });
    expect(nameBox().value).toBe('');
    expect(
      (
        screen
          .getByTestId('ish-scope-checklist')
          .querySelector('input[data-capability="report_task_result"]') as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(screen.getByTestId('ish-scope-summary').textContent).toContain('report_task_result');

    fireEvent.click(screen.getByRole('button', { name: '签发' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('issue_service_handle', {
        principalId: 'p-svc',
        scope: ['report_task_result'],
        ttlSeconds: 30 * 86400,
      }),
    );
  });

  it('a pasted list ticks every issuable name and keeps the rest in the box with the reason', () => {
    renderSection([service('p-svc', 'CI runner')]);
    fireEvent.change(nameBox(), { target: { value: 'get_task, search list_users' } });
    expect(nameBox().value).toBe('list_users');
    expect(screen.getByText(/不是可签发的能力名/).textContent).toContain('list_users');
    expect(screen.getByRole('button', { name: '签发' }).hasAttribute('disabled')).toBe(true);
    const summary = screen.getByTestId('ish-scope-summary').textContent ?? '';
    expect(summary).toContain('get_task');
    expect(summary).toContain('search');
    // Editing the leftover text clears the complaint.
    fireEvent.change(nameBox(), { target: { value: '' } });
    expect(screen.queryByText(/不是可签发的能力名/)).toBeNull();
    expect(screen.getByRole('button', { name: '签发' }).hasAttribute('disabled')).toBe(false);
  });

  it('isNameList: a separator after a name makes a list, a bare word is a search', () => {
    expect(isNameList('get_task')).toBe(false);
    expect(isNameList('get_task ')).toBe(true);
    expect(isNameList('a,b')).toBe(true);
    expect(isNameList('   ')).toBe(false);
  });
});
