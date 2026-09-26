// @vitest-environment jsdom
import type { ExecutionReadinessWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ExecutionReadinessCard } from './ExecutionReadinessCard.js';

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
    expect(http.calls).toEqual([{ name: 'execution_readiness', params: {} }]);
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
    expect(missing.querySelector('a')?.getAttribute('href')).toBe('#/govern/catalog/workers');
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
