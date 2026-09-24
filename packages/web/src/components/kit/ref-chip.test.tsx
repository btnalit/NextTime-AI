// @vitest-environment jsdom
import type { ResolvedRefWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { RefChip, useResolveRefs } from './ref-chip.js';

afterEach(cleanup);

function scriptedCaller(
  handler: (ids: readonly string[]) => readonly ResolvedRefWire[],
): CapabilityCaller & { readonly calls: readonly (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      expect(name).toBe('resolve_refs');
      const { ids } = params as { ids: readonly string[] };
      calls.push(ids);
      return { items: handler(ids) };
    }) as CapabilityCaller['call'],
  };
}

describe('kit/RefChip', () => {
  it('renders the caller-supplied name and kind label without calling http', () => {
    const http = scriptedCaller(() => []);
    render(<RefChip kind="principal" id="p-1" name="Ada" http={http} testId="chip" />);
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('主体')).toBeTruthy();
    expect(http.call).not.toHaveBeenCalled();
  });

  it('renders the degrade fallback (short id + 未知 / 已删除) when there is no name and no http', () => {
    render(<RefChip kind="workerDefinition" id="0123456789abcdef" testId="chip" />);
    const fallback = screen.getByTestId('chip-fallback');
    expect(fallback.textContent).toContain('01234567');
    expect(fallback.textContent).toContain('未知 / 已删除');
  });

  it('never renders the full bare id as plain text in the fallback state', () => {
    const fullId = '11111111-2222-3333-4444-555555555555';
    render(<RefChip kind="object" id={fullId} testId="chip" />);
    // The short (8-char) form is shown; the full id lives only in the title/copy attributes.
    expect(screen.queryByText(fullId)).toBeNull();
    expect(screen.getByTestId('chip-fallback').textContent).toContain('11111111');
  });

  it('self-resolves via http when name is omitted, and renders the resolved name', async () => {
    const http = scriptedCaller((ids) =>
      ids.map((id) => ({ id, kind: 'principal' as const, name: 'Resolved Name' })),
    );
    render(<RefChip kind="principal" id="p-1" http={http} testId="chip" />);
    await waitFor(() => expect(screen.getByText('Resolved Name')).toBeTruthy());
    expect(http.call).toHaveBeenCalledTimes(1);
  });

  it('renders the fallback when resolve_refs returns no match for the id (unknown/invisible)', async () => {
    const http = scriptedCaller(() => []);
    render(<RefChip kind="task" id="t-missing" http={http} testId="chip" />);
    await waitFor(() => expect(screen.getByTestId('chip-fallback')).toBeTruthy());
  });

  it('batches every chip mounted in the same tick against the same caller into one resolve_refs call', async () => {
    const http = scriptedCaller((ids) =>
      ids.map((id) => ({ id, kind: 'task' as const, name: id })),
    );
    render(
      <>
        <RefChip kind="task" id="t-1" http={http} testId="chip-1" />
        <RefChip kind="task" id="t-2" http={http} testId="chip-2" />
        <RefChip kind="chat" id="c-1" http={http} testId="chip-3" />
      </>,
    );
    await waitFor(() => expect(screen.getByText('t-1')).toBeTruthy());
    expect(http.call).toHaveBeenCalledTimes(1);
    expect(http.calls[0]).toEqual(expect.arrayContaining(['t-1', 't-2', 'c-1']));
  });

  it('caches a resolved id for the session: a second chip for the same id makes no new call', async () => {
    const http = scriptedCaller((ids) =>
      ids.map((id) => ({ id, kind: 'task' as const, name: 'X' })),
    );
    const { rerender } = render(<RefChip kind="task" id="t-shared" http={http} testId="chip" />);
    await waitFor(() => expect(http.call).toHaveBeenCalledTimes(1));

    rerender(
      <>
        <RefChip kind="task" id="t-shared" http={http} testId="chip" />
        <RefChip kind="task" id="t-shared" http={http} testId="chip-2" />
      </>,
    );
    // Both chips resolve immediately from cache; no additional resolve_refs call goes out.
    await waitFor(() => expect(screen.getAllByText('X')).toHaveLength(2));
    expect(http.call).toHaveBeenCalledTimes(1);
  });

  it('the copy button carries a >=36px (h-9 w-9) hit area regardless of chip size', () => {
    render(<RefChip kind="principal" id="p-1" name="Ada" size="s" testId="chip" />);
    const button = screen.getByRole('button', { name: /copy/i });
    expect(button.className).toContain('h-9');
    expect(button.className).toContain('w-9');
  });

  it('links the name to href when both a name and href are given', () => {
    render(
      <RefChip kind="gatekeeper" id="g-1" name="Gate" href="#/govern/systems" testId="chip" />,
    );
    const link = screen.getByRole('link', { name: 'Gate' });
    expect(link.getAttribute('href')).toBe('#/govern/systems');
  });
});

describe('kit/useResolveRefs', () => {
  it('returns undefined for every id when caller is undefined and issues no calls', () => {
    function Probe() {
      const { get } = useResolveRefs(undefined, ['a', 'b']);
      return <span data-testid="probe">{String(get('a'))}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('undefined');
  });
});
