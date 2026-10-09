// @vitest-environment jsdom
import type { QuotaListEntryWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { QuotaEditSheet } from './QuotaEditSheet.js';

afterEach(cleanup);

function row(key: string, value: number | null): QuotaListEntryWire {
  return { key, value, isDefault: true, updatedBy: null, updatedAt: null };
}

function renderSheet(entry: QuotaListEntryWire) {
  const call = vi.fn(async (_name: string, params?: unknown) => ({
    ...(params as object),
    updatedBy: 'owner-1',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }));
  const onSaved = vi.fn();
  render(
    <QuotaEditSheet
      http={{ call } as unknown as CapabilityCaller}
      open
      onOpenChange={vi.fn()}
      row={entry}
      onSaved={onSaved}
    />,
  );
  return { call, onSaved };
}

const input = () => document.getElementById('qe-value') as HTMLInputElement;
const submit = () => screen.getByTestId('quota-edit-submit') as HTMLButtonElement;

describe('QuotaEditSheet', () => {
  it('a blank value on a nullable axis means unlimited (as the hint says) and saves null', async () => {
    const { call } = renderSheet(row('task.default_token_budget', 5000));
    fireEvent.change(input(), { target: { value: '' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await screen.findByTestId('quota-edit-confirm');
    // Clearing a cap is loosening → irreversible tier: retype the target, acknowledge.
    fireEvent.change(screen.getByTestId('confirm-typed-name'), {
      target: { value: '每 Task token 预算' },
    });
    fireEvent.click(screen.getByTestId('confirm-acknowledge'));
    fireEvent.click(screen.getByTestId('confirm-button'));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('set_quota', {
        key: 'task.default_token_budget',
        value: null,
      }),
    );
  });

  it('a blank value on a non-nullable axis is rejected with the allowed range', () => {
    renderSheet(row('task.max_depth', 2));
    fireEvent.change(input(), { target: { value: '' } });
    expect(submit().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('0 到 3 的整数');
  });

  it('accepts thousands separators ("1,000", "1 000", "1_000")', async () => {
    for (const typed of ['1,000', '1 000', '1_000']) {
      cleanup();
      const { call } = renderSheet(row('task.default_token_budget', null));
      fireEvent.change(input(), { target: { value: typed } });
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(submit());
      await screen.findByTestId('quota-edit-confirm');
      fireEvent.click(screen.getByTestId('confirm-button'));
      await waitFor(() =>
        expect(call).toHaveBeenCalledWith('set_quota', {
          key: 'task.default_token_budget',
          value: 1000,
        }),
      );
    }
  });

  it('"10k" and out-of-range values say what is allowed', () => {
    renderSheet(row('task.max_depth', 2));
    fireEvent.change(input(), { target: { value: '10k' } });
    expect(screen.getByRole('alert').textContent).toMatch(/不是有效的数字.*0 到 3 的整数/);
    fireEvent.change(input(), { target: { value: '9' } });
    expect(screen.getByRole('alert').textContent).toMatch(/9 超出允许范围.*0 到 3 的整数/);
    fireEvent.change(input(), { target: { value: '1.5' } });
    expect(screen.getByRole('alert').textContent).toContain('整数');
    expect(submit().disabled).toBe(true);
  });
});
