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
 * `lockedGatekeeper` is given), and — only while the grant targets exactly one gate — a read-only
 * list of the published Operations the grant covers (`list_operations{gatekeeperId}`). `scope` is
 * never sent: the kernel stores it but no authorization path reads it, so the form offers no
 * per-Operation narrowing that would narrow nothing.
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
        {
          gatekeeperId: 'gk-1',
          name: 'container.prune',
          mode: 'execute',
          blastRadius: 'high',
          autoApprovable: false,
          version: 1,
          status: 'draft',
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
  it('locked to one gate: no gate picker, no free-text id; submit grants the whole gate with no scope', async () => {
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
    // AX1/J6: what the grant covers is stated, read-only — the whole gate, published Operations only.
    const scope = await screen.findByTestId('ggf-operations-scope');
    expect(scope.textContent).toContain('授权针对整个门');
    const list = await screen.findByTestId('ggf-operations-list');
    expect(list.textContent).toContain('container.restart');
    expect(list.textContent).toContain('container.list');
    expect(list.textContent).not.toContain('container.prune');
    expect(within(scope).queryByRole('checkbox')).toBeNull();

    await selectMember('p-1');
    fireEvent.click(screen.getByTestId('ggf-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(true),
    );
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
  });

  it('one picked gate: shows its covered operations read-only and never sends scope', async () => {
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
    render(<GrantGateForm http={http} onGranted={vi.fn()} />);

    await selectMember('p-1');
    fireEvent.click(await screen.findByTestId('ggf-gate-gk-1'));
    const list = await screen.findByTestId('ggf-operations-list');
    expect(list.textContent).toContain('container.restart');
    expect(screen.queryByTestId('ggf-operation-container.restart')).toBeNull();
    fireEvent.click(screen.getByTestId('ggf-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(true),
    );
  });

  it('multi-gate selection: one grant_capability call per gate, no per-gate operations list (more than one target)', async () => {
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

  it('R-39: picking an operator discloses that the grant also makes them an approver of the gate; a member gets no such notice', async () => {
    const http = scriptedHttp({
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
          {
            id: 'p-2',
            kind: 'human',
            role: 'operator',
            displayName: 'Carol',
            createdAt: '2026-09-01T00:00:00.000Z',
            hasApiKey: false,
          },
        ],
      }),
    });
    render(
      <GrantGateForm
        http={http}
        lockedGatekeeper={{ id: 'gk-1', name: 'docker-gate' }}
        onGranted={vi.fn()}
      />,
    );
    // The always-visible hint states the effect for operators too.
    expect((await screen.findByTestId('ggf-operations-scope')).textContent).toContain(
      '授予 operator 时，这位成员同时成为这个门上所有动作的审批者',
    );

    await selectMember('p-1');
    expect(screen.queryByTestId('ggf-approver-notice')).toBeNull();

    await selectMember('p-2');
    const notice = await screen.findByTestId('ggf-approver-notice');
    expect(notice.textContent).toContain('Carol');
    expect(notice.textContent).toContain('所有动作的审批者');
  });

  it('a failed member list renders an error with retry, not "没有匹配的成员"', async () => {
    let attempts = 0;
    const http = scriptedHttp({
      list_principals: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
        return {
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
        };
      },
    });
    render(<GrantGateForm http={http} onGranted={vi.fn()} />);
    const banner = await screen.findByTestId('ggf-members-error');
    expect(screen.queryByText('没有匹配的成员')).toBeNull();
    fireEvent.click(within(banner).getByRole('button'));
    await waitFor(() => expect(screen.queryByTestId('ggf-members-error')).toBeNull());
    await selectMember('p-1');
  });

  it('a failed gate list renders an error with retry, not "没有匹配的门"', async () => {
    const http = scriptedHttp({
      list_gatekeepers: () => {
        throw new Error('boom');
      },
    });
    render(<GrantGateForm http={http} onGranted={vi.fn()} />);
    const banner = await screen.findByTestId('ggf-gates-error');
    expect(within(banner).getByRole('button')).toBeTruthy();
    expect(screen.queryByText('没有匹配的门。')).toBeNull();
  });

  it('multi-gate: a later failure keeps the earlier success in the summary, reports it, and leaves only the unfinished gates selected', async () => {
    const http = scriptedHttp({
      grant_capability: (params) => {
        const id = (params as { resourceId: string }).resourceId;
        if (id === 'gk-2') throw new Error('nope');
        return {
          id: 'grant-1',
          principalId: 'p-1',
          resourceType: 'gatekeeper',
          resourceId: id,
          status: 'active',
        };
      },
    });
    const onGranted = vi.fn();
    render(<GrantGateForm http={http} onGranted={onGranted} />);
    await selectMember('p-1');
    fireEvent.click(await screen.findByTestId('ggf-gate-gk-1'));
    fireEvent.click(await screen.findByTestId('ggf-gate-gk-2'));
    fireEvent.click(screen.getByTestId('ggf-submit'));

    const error = await screen.findByTestId('ggf-error');
    expect(error.textContent).toContain('ragflow-gate');
    const summary = screen.getByTestId('ggf-granted-summary');
    expect(summary.textContent).toContain('Bob → docker-gate');
    expect(summary.textContent).not.toContain('ragflow-gate');
    expect(onGranted).toHaveBeenCalledTimes(1);
    expect((onGranted.mock.calls[0]?.[0] as unknown[]).length).toBe(1);
    expect((screen.getByTestId('ggf-gate-gk-1') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('ggf-gate-gk-2') as HTMLInputElement).checked).toBe(true);
  });

  it('the summary names who was granted which gates, and the button shows progress while granting', async () => {
    let release: (() => void) | undefined;
    const http = scriptedHttp({
      grant_capability: (params) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              id: 'g',
              principalId: 'p-1',
              resourceType: 'gatekeeper',
              resourceId: (params as { resourceId: string }).resourceId,
              status: 'active',
            });
        }),
    });
    render(
      <GrantGateForm
        http={http}
        lockedGatekeeper={{ id: 'gk-1', name: 'docker-gate' }}
        onGranted={vi.fn()}
      />,
    );
    await selectMember('p-1');
    fireEvent.click(screen.getByTestId('ggf-submit'));
    await waitFor(() => expect(screen.getByTestId('ggf-submit').textContent).toBe('授予中…'));
    expect(screen.getByTestId('ggf-submit').getAttribute('aria-busy')).toBe('true');
    release?.();
    const summary = await screen.findByTestId('ggf-granted-summary');
    expect(summary.textContent).toContain('Bob → docker-gate');
    expect(screen.getByTestId('ggf-submit').textContent).toBe('授予');
  });
});

describe('GrantGateForm: audit P1-9 still-needed line', () => {
  it('names the member and the gate while 授予 is disabled, and goes away once both are picked', async () => {
    render(<GrantGateForm http={scriptedHttp({})} onGranted={vi.fn()} />);
    const submit = screen.getByTestId('ggf-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId('ggf-missing').textContent).toBe('还差：选择成员、选择门');

    await selectMember('p-1');
    expect(screen.getByTestId('ggf-missing').textContent).toBe('还差：选择门');

    fireEvent.click(await screen.findByTestId('ggf-gate-gk-1'));
    expect(submit.disabled).toBe(false);
    expect(screen.queryByTestId('ggf-missing')).toBeNull();
  });
});
