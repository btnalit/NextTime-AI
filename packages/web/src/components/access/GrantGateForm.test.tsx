// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { GrantGateForm } from './GrantGateForm.js';

/** `list_principals` resolves asynchronously — setting the `<select>`'s value before its `<option
 *  value="p-1">` exists is a silent no-op (no matching option, the DOM value does not change), so
 *  every caller awaits the option first. */
async function selectMember(id: string): Promise<void> {
  const select = screen.getByTestId('ggf-member-select');
  await waitFor(() => expect(select.querySelector(`option[value="${id}"]`)).not.toBeNull());
  fireEvent.change(select, { target: { value: id } });
}

/**
 * GrantGateForm.test.tsx (S8 W2-U1, audit J6/SY2/AX1): the picker-based grant flow — a member
 * (`list_principals`), one or more gates (`list_gatekeepers`, hidden entirely when
 * `lockedGatekeeper` is given), and — only while the grant targets exactly one gate — an
 * Operations checklist (`list_operations{gatekeeperId}`) narrowing the grant, with the "empty ==
 * every operation" wording stated explicitly rather than left implicit.
 */

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown> = {
    list_principals: () => ({
      items: [
        {
          id: 'p-1',
          kind: 'human',
          role: 'member',
          displayName: 'Bob',
          createdAt: '2026-09-01T00:00:00.000Z',
          hasApiKey: false,
        },
      ],
    }),
    list_gatekeepers: () => ({
      items: [
        {
          id: 'gk-1',
          name: 'docker-gate',
          kind: 'cli',
          status: 'active',
          operationCount: 2,
          createdAt: '2026-09-01T00:00:00.000Z',
        },
        {
          id: 'gk-2',
          name: 'ragflow-gate',
          kind: 'http',
          status: 'active',
          operationCount: 1,
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    }),
    list_operations: () => ({
      items: [
        {
          gatekeeperId: 'gk-1',
          name: 'container.restart',
          mode: 'execute',
          blastRadius: 'medium',
          autoApprovable: false,
          version: 1,
          status: 'published',
        },
        {
          gatekeeperId: 'gk-1',
          name: 'container.list',
          mode: 'observe',
          blastRadius: 'low',
          autoApprovable: true,
          version: 1,
          status: 'published',
        },
      ],
    }),
    ...handlers,
  };
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = base[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

describe('GrantGateForm', () => {
  it('locked to one gate: no gate picker, no free-text id; submit grants that gate with no scope (empty checklist)', async () => {
    const http = scriptedHttp({
      grant_capability: (params) => {
        expect(params).toEqual({
          principalId: 'p-1',
          resourceType: 'gatekeeper',
          resourceId: 'gk-1',
        });
        return {
          id: 'grant-1',
          principalId: 'p-1',
          resourceType: 'gatekeeper',
          resourceId: 'gk-1',
          status: 'active',
        };
      },
    });
    const onGranted = vi.fn();
    render(
      <GrantGateForm
        http={http}
        lockedGatekeeper={{ id: 'gk-1', name: 'docker-gate' }}
        onGranted={onGranted}
      />,
    );

    expect(screen.queryByTestId('ggf-gate-picker')).toBeNull();
    expect(screen.getByTestId('ggf-locked-gate-chip').textContent).toContain('docker-gate');
    // AX1/J6: the empty-scope wording is explicit, not an implicit default nobody chose.
    const scope = await screen.findByTestId('ggf-operations-scope');
    expect(scope.textContent).toContain('留空');
    expect(scope.textContent).toContain('覆盖该门的全部');
    expect(scope.textContent).toContain('Operation');

    await selectMember('p-1');
    fireEvent.click(screen.getByTestId('ggf-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(true),
    );
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
  });

  it('narrows to picked operations only when exactly one gate is targeted', async () => {
    const http = scriptedHttp({
      grant_capability: (params) => {
        expect(params).toEqual({
          principalId: 'p-1',
          resourceType: 'gatekeeper',
          resourceId: 'gk-1',
          scope: { operationNames: ['container.restart'] },
        });
        return {
          id: 'grant-1',
          principalId: 'p-1',
          resourceType: 'gatekeeper',
          resourceId: 'gk-1',
          status: 'active',
        };
      },
    });
    render(<GrantGateForm http={http} onGranted={vi.fn()} />);

    await selectMember('p-1');
    fireEvent.click(await screen.findByTestId('ggf-gate-gk-1'));
    fireEvent.click(await screen.findByTestId('ggf-operation-container.restart'));
    fireEvent.click(screen.getByTestId('ggf-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(true),
    );
  });

  it('multi-gate selection: one grant_capability call per gate, no operations checklist (more than one target)', async () => {
    const calls: string[] = [];
    const http = scriptedHttp({
      grant_capability: (params) => {
        calls.push((params as { resourceId: string }).resourceId);
        return {
          id: `grant-${calls.length}`,
          principalId: 'p-1',
          resourceType: 'gatekeeper',
          resourceId: (params as { resourceId: string }).resourceId,
          status: 'active',
        };
      },
    });
    render(<GrantGateForm http={http} onGranted={vi.fn()} />);

    await selectMember('p-1');
    fireEvent.click(await screen.findByTestId('ggf-gate-gk-1'));
    fireEvent.click(await screen.findByTestId('ggf-gate-gk-2'));
    expect(screen.queryByTestId('ggf-operations-scope')).toBeNull();
    fireEvent.click(screen.getByTestId('ggf-submit'));

    await waitFor(() => expect(calls.sort()).toEqual(['gk-1', 'gk-2']));
  });

  it('J6: "全部门" is blocked behind an explicit confirm; grant_capability then omits resourceId', async () => {
    const http = scriptedHttp({
      grant_capability: (params) => {
        expect(params).toEqual({ principalId: 'p-1', resourceType: 'gatekeeper' });
        return { id: 'grant-1', principalId: 'p-1', resourceType: 'gatekeeper', status: 'active' };
      },
    });
    render(<GrantGateForm http={http} onGranted={vi.fn()} />);

    await selectMember('p-1');
    fireEvent.click(await screen.findByTestId('ggf-gate-gk-1'));
    fireEvent.click(screen.getByTestId('ggf-all-gates-checkbox'));
    expect((screen.getByTestId('ggf-all-gates-checkbox') as HTMLInputElement).checked).toBe(false);
    // Picking "全部门" also clears the specific-gate selection underneath it.
    const confirm = await screen.findByTestId('ggf-all-gates-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect((screen.getByTestId('ggf-all-gates-checkbox') as HTMLInputElement).checked).toBe(true),
    );
    expect((screen.getByTestId('ggf-gate-gk-1') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId('ggf-submit'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(true),
    );
  });

  it('submit is disabled until a member and a target are both chosen', async () => {
    const http = scriptedHttp({});
    render(<GrantGateForm http={http} onGranted={vi.fn()} />);
    expect(screen.getByTestId('ggf-submit').hasAttribute('disabled')).toBe(true);

    await selectMember('p-1');
    expect(screen.getByTestId('ggf-submit').hasAttribute('disabled')).toBe(true);

    fireEvent.click(await screen.findByTestId('ggf-gate-gk-1'));
    expect(screen.getByTestId('ggf-submit').hasAttribute('disabled')).toBe(false);
  });
});
