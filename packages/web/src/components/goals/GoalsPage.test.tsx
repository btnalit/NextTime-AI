// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { GoalsPage } from './GoalsPage.js';
import { goalRun } from './goal-fixtures.test-helpers.js';

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown>,
): CapabilityCaller & { readonly calls: { name: string; params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

const PRINCIPALS = {
  items: [
    { id: 'p-alice', displayName: 'alice', kind: 'human', role: 'member' },
    { id: 'p-bob', displayName: 'bob', kind: 'human', role: 'member' },
  ],
};

function renderPage(http: CapabilityCaller, onOpen = vi.fn()) {
  render(
    <PermissionsProvider>
      <GoalsPage http={http} pushes={SILENT_PUSH_SOURCE} onOpen={onOpen} />
    </PermissionsProvider>,
  );
  return onOpen;
}

describe('GoalsPage (S11 GO6)', () => {
  it('walks every page of list_goals and shows each goal’s state, requester, steps and spend', async () => {
    const http = scriptedHttp({
      list_goals: (params) =>
        (params as { cursor?: string }).cursor === 'c2'
          ? {
              items: [
                goalRun({
                  id: 'goal-2',
                  status: 'paused',
                  pauseReason: 'requested',
                  pausedBy: 'p-owner',
                  pausedByAuthority: 'owner',
                  statement: '清理旧备份',
                }),
              ],
            }
          : { items: [goalRun()], nextCursor: 'c2' },
      list_principals: () => PRINCIPALS,
    });
    const onOpen = renderPage(http);

    const rows = await screen.findAllByTestId('goal-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('把三台主机的证书都换成新签发的');
    expect(rows[0]?.textContent).toMatch(/进行中/);
    expect(rows[0]?.textContent).toMatch(/步骤 0\/2/);
    await waitFor(() => expect(rows[0]?.textContent).toContain('alice'));
    expect(within(rows[1] as HTMLElement).getByTestId('goal-row-pause-reason').textContent).toMatch(
      /有人暂停了它（所有者锁定）/,
    );

    fireEvent.click(rows[1] as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('goal-2');
  });

  it('offers the requester filter only when the goals have more than one requester, picked from them', async () => {
    const http = scriptedHttp({
      list_goals: () => ({
        items: [
          goalRun({ id: 'goal-a' }),
          goalRun({ id: 'goal-b', onBehalfOf: 'p-bob', statement: '升级数据库' }),
        ],
      }),
      list_principals: () => PRINCIPALS,
    });
    renderPage(http);
    const filter = (await screen.findByTestId('goals-requester-filter')) as HTMLSelectElement;
    await waitFor(() =>
      expect([...filter.options].map((option) => option.textContent)).toEqual([
        '所有请求人',
        'alice',
        'bob',
      ]),
    );
    fireEvent.change(filter, { target: { value: 'p-bob' } });
    const rows = screen.getAllByTestId('goal-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('升级数据库');
  });

  it('a member’s own goals (one requester) show no requester filter; the tabs split open from finished', async () => {
    const http = scriptedHttp({
      list_goals: () => ({
        items: [
          goalRun({ id: 'goal-open' }),
          goalRun({
            id: 'goal-done',
            status: 'completed',
            outcome: 'achieved',
            outcomeBasis: 'verified_by_check',
            statement: '已完成的那个',
            endedAt: '2026-10-21T00:00:00.000Z',
          }),
        ],
      }),
      list_principals: () => PRINCIPALS,
    });
    renderPage(http);
    await screen.findAllByTestId('goal-row');
    expect(screen.queryByTestId('goals-requester-filter')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /已结束/ }));
    const rows = screen.getAllByTestId('goal-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toMatch(/达成/);
  });

  it('no goals yet says how one comes to exist', async () => {
    const http = scriptedHttp({
      list_goals: () => ({ items: [] }),
      list_principals: () => PRINCIPALS,
    });
    renderPage(http);
    expect((await screen.findByTestId('goals-empty')).textContent).toMatch(/入口智能体/);
  });
});
