// @vitest-environment jsdom
import type { ExecutionReadinessWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ExecutionReadinessCard } from './ExecutionReadinessCard.js';
import { announceReadinessChange } from './useExecutionReadiness.js';

afterEach(cleanup);

/**
 * ExecutionReadinessCard.test.tsx (console redesign P2-b, docs/console-redesign-plan-2026-09-25.md
 * §4/§6 P2 "对话状态条"): the compact "我的智能体现在能用：" strip that replaced the old "执行就绪"
 * card — zero systems collapses to one line, one chip per system otherwise, the per-gate detail
 * (reason + fix link) stays behind "查看原因" until a system is actually unusable, and the
 * workspace-wide `missing[]` items a per-gate chip cannot say on their own (no `gateId`) still show,
 * never duplicating a sentence a gate chip/row already said.
 */

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
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

type GateWire = ExecutionReadinessWire['gates'][number];

function gate(overrides: Partial<GateWire> & Pick<GateWire, 'gateId' | 'name'>): GateWire {
  return {
    granted: true,
    publishedOperationCount: 1,
    observeOperationCount: 1,
    executeOperationCount: 0,
    disabledOperations: [],
    definitionMismatch: [],
    excludedByPolicy: false,
    excludedByProfile: false,
    inEntryScope: true,
    workerDefinitionIds: [],
    status: 'direct',
    ...overrides,
  };
}

function readiness(overrides: Partial<ExecutionReadinessWire> = {}): ExecutionReadinessWire {
  return {
    principalId: 'p-1',
    ready: true,
    missing: [],
    gates: [],
    workers: [],
    ...overrides,
  };
}

describe('ExecutionReadinessCard', () => {
  it('calls execution_readiness with no principalId — own readiness only', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ ready: true, gates: [gate({ gateId: 'g-1', name: 'CRM' })] }),
    });
    render(<ExecutionReadinessCard http={http} />);
    await screen.findByTestId('execution-readiness-body');
    // Legacy 253: and a second read of the same, own readiness for the gates' health only.
    await waitFor(() =>
      expect(
        http.calls.filter((call) => call.name === 'execution_readiness').map((c) => c.params),
      ).toEqual(expect.arrayContaining([{}, { includeGateHealth: true }])),
    );
    expect(http.calls.filter((call) => call.name === 'execution_readiness')).toHaveLength(2);
  });

  it('no systems at all: one line pointing at 系统接入, no chips, no toggle', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ ready: false, gates: [], missing: [{ code: 'no_enabled_gate' }] }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const missing = await screen.findByTestId('execution-readiness-missing');
    expect(missing.textContent).toContain('还没有任何可以作用的系统');
    expect(missing.querySelector('a')?.getAttribute('href')).toBe('#/govern/systems');
    expect(missing.querySelector('a')?.className).toContain('link-inline');
    expect(screen.queryAllByTestId('execution-readiness-gate-chip')).toHaveLength(0);
    expect(screen.queryByTestId('execution-readiness-toggle')).toBeNull();
    // Console redesign P3-3 (V2): a fresh workspace's day-1 state is calm, never an alarm.
    expect(screen.getByTestId('execution-readiness-body').className).not.toContain('notice-warn');
  });

  it('all systems direct: one chip per system, ready sentence, no toggle', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: true,
          gates: [
            gate({ gateId: 'g-1', name: 'CRM', workerDefinitionIds: ['w-1'] }),
            gate({ gateId: 'g-2', name: 'Docs' }),
          ],
          workers: [
            {
              definitionId: 'w-1',
              version: 1,
              name: 'Ops runner',
              delegable: true,
              reachableGateCount: 1,
              blockedBy: [],
            },
          ],
        }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const chips = await screen.findAllByTestId('execution-readiness-gate-chip');
    expect(chips.map((chip) => chip.getAttribute('data-status'))).toEqual(['direct', 'direct']);
    expect(chips[0]?.textContent).toContain('CRM');
    expect(chips[0]?.textContent).toContain('可直接调用');
    expect(screen.queryByTestId('execution-readiness-toggle')).toBeNull();
    expect(screen.queryByTestId('execution-readiness-gates')).toBeNull();
    expect(await screen.findByTestId('execution-readiness-ready')).toBeTruthy();
    expect(screen.queryByTestId('execution-readiness-missing')).toBeNull();
    // Console redesign P3-3 (V2): a neutral "n/m 个系统" summary line, not a bare "现在能用：".
    expect(screen.getByTestId('execution-readiness-summary').textContent).toContain('2/2');
  });

  it('one system unusable: strip counts it, 查看原因 expands the per-gate reason + fix link', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: true,
          gates: [
            gate({ gateId: 'g-1', name: 'CRM', workerDefinitionIds: ['w-1'] }),
            gate({
              gateId: 'g-2',
              name: 'Knowledge base',
              excludedByProfile: true,
              inEntryScope: false,
              status: 'unreachable',
              reason: 'excluded_by_profile',
            }),
          ],
          workers: [
            {
              definitionId: 'w-1',
              version: 1,
              name: 'Ops runner',
              delegable: true,
              reachableGateCount: 1,
              blockedBy: [],
            },
          ],
        }),
    });
    render(<ExecutionReadinessCard http={http} />);
    // Console redesign P3-3 (V2): amber lives on the unusable chip alone, never on the container.
    await screen.findByTestId('execution-readiness-body');
    expect(screen.getByTestId('execution-readiness-body').className).not.toContain('notice-warn');
    // Bugfix (PR #324 review): unusable gates no longer get their own inline chip — they fold into
    // the single "N 个用不了" toggle below, so only the usable gate (CRM) shows a chip here.
    const chips = await screen.findAllByTestId('execution-readiness-gate-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.getAttribute('data-status')).toBe('direct');
    expect(chips.some((chip) => chip.className.includes('chip-warn'))).toBe(false);

    const toggle = screen.getByTestId('execution-readiness-toggle');
    expect(toggle.textContent).toContain('1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('execution-readiness-gates')).toBeNull();

    toggle.click();
    const rows = await screen.findAllByTestId('execution-readiness-gate');
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['direct', 'unreachable']);
    // The incident this strip exists for: granted but unticked on My Agent — says so, links there.
    expect(rows[1]?.textContent).toContain('取消了勾选');
    const rowLink = rows[1]?.querySelector('a');
    expect(rowLink?.getAttribute('href')).toBe('#/me/agent');
    expect(rowLink?.className).toContain('link-inline');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  // Legacy 253: the strip said 「可直接调用」 for a gate that was down. The health comes from a
  // read of its own, so a slow probe never holds the strip up.
  it('legacy 253: a gate that does not answer, or rejects the platform’s credentials, folds into the unusable ones and its row says why', async () => {
    const gates = [
      gate({ gateId: 'g-1', name: 'CRM' }),
      gate({ gateId: 'g-2', name: 'Tickets', status: 'via_worker', workerDefinitionIds: ['w-1'] }),
      gate({ gateId: 'g-3', name: 'Wiki' }),
      gate({ gateId: 'g-4', name: 'Catalog' }),
    ];
    const health = { 'g-1': 'unreachable', 'g-2': 'unauthorized', 'g-3': 'ok', 'g-4': 'unknown' };
    let answerHealth: (value: ExecutionReadinessWire) => void = () => {};
    const http = scriptedHttp({
      execution_readiness: (params) =>
        (params as { includeGateHealth?: boolean }).includeGateHealth === true
          ? new Promise((resolve) => {
              answerHealth = resolve;
            })
          : readiness({ gates }),
    });
    render(<ExecutionReadinessCard http={http} />);
    // The strip is there before the health read answers, as before.
    expect((await screen.findByTestId('execution-readiness-summary')).textContent).toContain('4/4');
    answerHealth(
      readiness({
        gates: gates.map((g) => ({
          ...g,
          health: health[g.gateId as keyof typeof health] as GateWire['health'],
        })),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('execution-readiness-summary').textContent).toContain('2/4'),
    );
    // `unknown` (not announced yet) and `ok` say nothing: those two keep their chips.
    expect(
      screen
        .getAllByTestId('execution-readiness-gate-chip')
        .map((c) => c.getAttribute('data-gate-id')),
    ).toEqual(['g-3', 'g-4']);
    const toggle = screen.getByTestId('execution-readiness-toggle');
    expect(toggle.textContent).toContain('2 个用不了');
    toggle.click();
    const rows = await screen.findAllByTestId('execution-readiness-gate');
    const row = (gateId: string) => rows.find((r) => r.getAttribute('data-gate-id') === gateId);
    // Reachability is unchanged; the health is said beside it.
    expect(row('g-1')?.getAttribute('data-status')).toBe('direct');
    expect(row('g-1')?.getAttribute('data-health')).toBe('unreachable');
    expect(row('g-1')?.textContent).toContain('不可达');
    expect(row('g-1')?.textContent).toContain('门现在没有回应，调用它会失败');
    expect(row('g-1')?.textContent).toContain('直接调用');
    expect(row('g-1')?.textContent).not.toContain('可直接调用');
    expect(row('g-1')?.querySelector('a')?.getAttribute('href')).toBe('#/govern/systems/g-1');
    expect(row('g-1')?.querySelector('a')?.textContent).toBe('看门详情');
    expect(row('g-2')?.textContent).toContain('凭据被拒');
    expect(row('g-2')?.textContent).toContain('门拒绝了平台调用它用的凭据');
    expect(row('g-2')?.textContent).toContain('照常可以委派');
    expect(row('g-3')?.textContent).toContain('可直接调用');
    expect(row('g-3')?.hasAttribute('data-health')).toBe(true);
    expect(row('g-3')?.querySelector('a')).toBeNull();
  });

  it('legacy 253: a failed health read leaves the strip as it was', async () => {
    const http = scriptedHttp({
      execution_readiness: (params) => {
        if ((params as { includeGateHealth?: boolean }).includeGateHealth === true) {
          throw new Error('probe read failed');
        }
        return readiness({ gates: [gate({ gateId: 'g-1', name: 'CRM' })] });
      },
    });
    render(<ExecutionReadinessCard http={http} />);
    await waitFor(() =>
      expect(
        http.calls.some(
          (c) => (c.params as { includeGateHealth?: boolean } | undefined)?.includeGateHealth,
        ),
      ).toBe(true),
    );
    expect((await screen.findByTestId('execution-readiness-summary')).textContent).toContain('1/1');
    expect(screen.queryByTestId('execution-readiness-error')).toBeNull();
  });

  // Legacy 675: a gate the platform suspended said it was disabled on 平台 · 集成.
  it('legacy 675: a suspended gate says the platform suspended it and links to why', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          gates: [
            gate({
              gateId: 'g-1',
              name: 'CRM',
              status: 'unreachable',
              reason: 'suspended_by_platform',
              disabledOperations: ['crm.get'],
            }),
          ],
          missing: [{ code: 'suspended_by_platform', gateId: 'g-1' }],
        }),
    });
    render(<ExecutionReadinessCard http={http} />);
    (await screen.findByTestId('execution-readiness-toggle')).click();
    const row = await screen.findByTestId('execution-readiness-gate');
    expect(row.textContent).toContain('门被平台暂停');
    expect(row.textContent).toContain('平台管理员恢复');
    expect(row.textContent).not.toContain('平台 · 集成');
    const link = row.querySelector('a');
    expect(link?.getAttribute('href')).toBe('#/govern/systems/g-1');
    expect(link?.textContent).toBe('看暂停原因');
  });

  it('bugfix (PR #324 review): 0/5 usable shows no inline chips at all, just the summary and the toggle', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: false,
          gates: Array.from({ length: 5 }, (_, i) =>
            gate({
              gateId: `g-${i}`,
              name: `System ${i}`,
              status: 'unreachable',
              reason: 'not_granted',
            }),
          ),
        }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const summary = await screen.findByTestId('execution-readiness-summary');
    expect(summary.textContent).toContain('0/5');
    expect(screen.queryAllByTestId('execution-readiness-gate-chip')).toHaveLength(0);
    const toggle = screen.getByTestId('execution-readiness-toggle');
    expect(toggle.textContent).toContain('5');
  });

  it('console redesign P3-3 (V2): two gates sharing a display name get a short-id suffix', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: true,
          gates: [
            gate({ gateId: 'gate-aaaaaaaa-1', name: 'RAGFlow' }),
            gate({ gateId: 'gate-bbbbbbbb-2', name: 'RAGFlow' }),
          ],
        }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const chips = await screen.findAllByTestId('execution-readiness-gate-chip');
    const labels = chips.map((chip) => chip.textContent);
    expect(labels[0]).not.toEqual(labels[1]);
    expect(labels[0]).toContain('RAGFlow');
    expect(labels[1]).toContain('RAGFlow');
  });

  it('workspace-wide gap (no gateId) still shown; per-gate gaps are not duplicated', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: false,
          gates: [gate({ gateId: 'g-1', name: 'CRM' })],
          // `no_grant` here carries a gateId — already said by the gate's own chip/row (its
          // `reason`), so the strip must not also print `missingCauseText` for it.
          missing: [{ code: 'no_published_worker' }, { code: 'no_grant', gateId: 'g-1' }],
        }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const missing = await screen.findByTestId('execution-readiness-missing');
    const items = await screen.findAllByTestId('execution-readiness-missing-item');
    expect(items).toHaveLength(1);
    expect(missing.textContent).toContain('委派任务时找不到可用的');
    // UX acceptance of #679 P3-4: the shortest way to a Worker is installing ops-base.
    expect(missing.querySelector('a')?.getAttribute('href')).toBe(
      '#/govern/catalog/packs/ops-base',
    );
  });

  // Audit P1-5: a fix is a link only for a role that can make it; anyone else is told who to ask.
  it('a member is told who to ask instead of being sent to a page they cannot act on', async () => {
    const http = scriptedHttp({
      get_workspace: () => ({
        id: 'ws-1',
        name: 'Acme',
        caller: { id: 'p-1', role: 'member', displayName: 'Mia', kind: 'human' },
      }),
      execution_readiness: () =>
        readiness({
          ready: false,
          gates: [gate({ gateId: 'g-1', name: 'CRM' })],
          missing: [{ code: 'no_published_worker' }, { code: 'no_grant' }],
        }),
    });
    render(<ExecutionReadinessCard http={http} />);
    await waitFor(() =>
      expect(
        screen.getAllByTestId('execution-readiness-ask').map((node) => node.textContent),
      ).toEqual([
        '这一步要构建者或工作区所有者来做，请联系他们。',
        '这一步要工作区所有者来做，请联系他们。',
      ]),
    );
    const missing = screen.getByTestId('execution-readiness-missing');
    expect(missing.querySelector('a')).toBeNull();
    // Audit P1-4: reads need no grant — the no-grant line says it is about writes.
    expect(missing.textContent).toContain('写操作授权（只读操作不需要授权');
  });

  it('an owner gets the fix link, except to the page the card is already on', async () => {
    const http = scriptedHttp({
      get_workspace: () => ({
        id: 'ws-1',
        name: 'Acme',
        caller: { id: 'p-1', role: 'owner', displayName: 'Olu', kind: 'human' },
      }),
      execution_readiness: () =>
        readiness({
          ready: false,
          gates: [gate({ gateId: 'g-1', name: 'CRM' })],
          missing: [{ code: 'no_published_worker' }, { code: 'no_grant' }],
        }),
    });
    render(<ExecutionReadinessCard http={http} currentHref="#/govern/access" />);
    await waitFor(() =>
      expect(
        [...screen.getByTestId('execution-readiness-missing').querySelectorAll('a')].map((a) =>
          a.getAttribute('href'),
        ),
      ).toEqual(['#/govern/catalog/packs/ops-base']),
    );
    expect(screen.getByTestId('execution-readiness-missing').textContent).toMatch(
      /去安装\s+ops-base/,
    );
    expect(screen.queryByTestId('execution-readiness-ask')).toBeNull();
  });

  it('re-reads when a page announces a change (a Worker published under the card)', async () => {
    let published = false;
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: published,
          gates: [gate({ gateId: 'g-1', name: 'CRM' })],
          missing: published ? [] : [{ code: 'no_published_worker' }],
        }),
    });
    render(<ExecutionReadinessCard http={http} />);
    await screen.findByTestId('execution-readiness-missing');
    published = true;
    announceReadinessChange(http);
    expect(await screen.findByTestId('execution-readiness-ready')).toBeTruthy();
  });

  it('surfaces a load error with retry', async () => {
    let attempt = 0;
    const http = scriptedHttp({
      execution_readiness: () => {
        attempt += 1;
        if (attempt === 1) throw new Error('boom');
        return readiness({ gates: [gate({ gateId: 'g-1', name: 'CRM' })] });
      },
    });
    render(<ExecutionReadinessCard http={http} />);
    await screen.findByTestId('execution-readiness-error');
    screen.getByRole('button', { name: /retry|重试/i }).click();
    await waitFor(() => expect(screen.getByTestId('execution-readiness-body')).toBeTruthy());
  });
});

describe('ExecutionReadinessCard in a trial workspace (legacy 624)', () => {
  it('with no system yet, says the admin agent asks to connect one, not that the entry agent has nothing', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ ready: false, gates: [], missing: [{ code: 'no_enabled_gate' }] }),
    });
    render(<ExecutionReadinessCard http={http} trialWorkspace={true} />);
    const missing = await screen.findByTestId('execution-readiness-missing');
    expect(missing.textContent).toContain('这个试验工作区还没有接入系统');
    expect(missing.textContent).toContain('管理员智能体会在对话里申请接入');
    expect(missing.textContent).not.toContain('还没有任何可以作用的系统');
    // Enabling a gate by hand is still offered.
    expect(missing.querySelector('a')?.getAttribute('href')).toBe('#/govern/systems');
    expect(screen.getByTestId('execution-readiness-body').className).not.toContain('notice-warn');
  });

  it('with systems, names the entry agent in the summary', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ ready: false, gates: [gate({ gateId: 'g-1', name: 'CRM' })] }),
    });
    render(<ExecutionReadinessCard http={http} trialWorkspace={true} />);
    const summary = await screen.findByTestId('execution-readiness-summary');
    expect(summary.textContent).toBe('入口 agent（新对话）能用 1/1 个系统');
  });

  it('elsewhere the strip reads as before', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ ready: false, gates: [gate({ gateId: 'g-1', name: 'CRM' })] }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const summary = await screen.findByTestId('execution-readiness-summary');
    expect(summary.textContent).toBe('我的智能体能用 1/1 个系统');
  });
});

describe('ExecutionReadinessCard — by role (#541 acceptance must-fix 2)', () => {
  it('an auditor, who may not read readiness, gets no card and no request', async () => {
    const http = scriptedHttp({
      get_workspace: () => ({ id: 'ws-1', name: 'Acme', caller: { id: 'p-a', role: 'auditor' } }),
      get_agent_policy: () => ({ memberCanEditProfile: true }),
    });
    const { container } = render(<ExecutionReadinessCard http={http} />);
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(http.calls.some((c) => c.name === 'execution_readiness')).toBe(false);
  });
});
