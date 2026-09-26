// @vitest-environment jsdom
import type { ExecutionReadinessWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ExecutionReadinessCard } from './ExecutionReadinessCard.js';

afterEach(cleanup);

/**
 * ExecutionReadinessCard.test.tsx (S8 W2 U3a, ui-audit-2026-09-23 J1): the counts row, the ready
 * vs. not-ready body, each `missing[]` code's cause text and link target (never a raw code or raw
 * id), and that the call never asks for another principal's readiness (this lane ships no member
 * picker — see the component's own doc comment).
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
    const http = scriptedHttp({ execution_readiness: () => readiness() });
    render(<ExecutionReadinessCard http={http} />);
    await screen.findByTestId('execution-readiness-ready');
    expect(http.calls).toEqual([{ name: 'execution_readiness', params: {} }]);
  });

  it('console redesign M2: one row per system — delegation being ready never hides a system the agent cannot use', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: true,
          gates: [
            gate({
              gateId: 'g-1',
              name: 'CRM',
              observeOperationCount: 3,
              workerDefinitionIds: ['w-1'],
            }),
            gate({
              gateId: 'g-2',
              name: 'Knowledge base',
              excludedByProfile: true,
              inEntryScope: false,
              status: 'unreachable',
              reason: 'excluded_by_profile',
            }),
            gate({
              gateId: 'g-3',
              name: 'Billing',
              granted: false,
              inEntryScope: false,
              status: 'unreachable',
              reason: 'not_granted',
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
    const rows = await screen.findAllByTestId('execution-readiness-gate');
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual([
      'direct',
      'unreachable',
      'unreachable',
    ]);
    expect(rows[0]?.textContent).toContain('3 个只读操作');
    expect(rows[0]?.textContent).toContain('Ops runner');
    // The incident: granted but unticked on My Agent — says so, and links there.
    expect(rows[1]?.textContent).toContain('取消了勾选');
    expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe('#/me/agent');
    expect(rows[2]?.querySelector('a')?.getAttribute('href')).toBe('#/govern/access');
    // Delegation readiness is still shown, but no longer as a blanket "ready".
    expect(screen.getByTestId('execution-readiness-ready').textContent).toContain('委派');
  });

  it('no_enabled_gate: cause text and a link to 系统接入, never the raw code', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ ready: false, missing: [{ code: 'no_enabled_gate' }] }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const item = await screen.findByTestId('execution-readiness-missing-item');
    expect(item.textContent).not.toContain('no_enabled_gate');
    expect(item.textContent).toContain('还没有任何可以作用的系统');
    const link = item.querySelector('a');
    expect(link?.getAttribute('href')).toBe('#/govern/systems');
  });

  it('no_grant with a gateId: resolves the gate name from this same response, links to 访问', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: false,
          missing: [{ code: 'no_grant', gateId: 'g-9' }],
          gates: [
            gate({
              gateId: 'g-9',
              name: 'Payments',
              granted: false,
              inEntryScope: false,
              status: 'unreachable',
              reason: 'not_granted',
            }),
          ],
        }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const item = await screen.findByTestId('execution-readiness-missing-item');
    expect(item.textContent).toContain('Payments');
    expect(item.textContent).not.toContain('g-9');
    const link = item.querySelector('a');
    expect(link?.getAttribute('href')).toBe('#/govern/access');
  });

  it('no_published_worker: cause text and a link to 能力目录 · Workers', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ ready: false, missing: [{ code: 'no_published_worker' }] }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const item = await screen.findByTestId('execution-readiness-missing-item');
    expect(item.textContent).toContain('委派任务时找不到可用的');
    const link = item.querySelector('a');
    expect(link?.getAttribute('href')).toBe('#/govern/catalog/workers');
  });

  it('no_worker_gate: says the delegated Worker reaches no system, links to 能力目录 · Workers', async () => {
    const http = scriptedHttp({
      execution_readiness: () => readiness({ ready: false, missing: [{ code: 'no_worker_gate' }] }),
    });
    render(<ExecutionReadinessCard http={http} />);
    const item = await screen.findByTestId('execution-readiness-missing-item');
    expect(item.textContent).not.toContain('no_worker_gate');
    expect(item.textContent).toContain('碰不到任何系统');
    const link = item.querySelector('a');
    expect(link?.getAttribute('href')).toBe('#/govern/catalog/workers');
  });

  it('surfaces a load error with retry', async () => {
    let attempt = 0;
    const http = scriptedHttp({
      execution_readiness: () => {
        attempt += 1;
        if (attempt === 1) throw new Error('boom');
        return readiness();
      },
    });
    render(<ExecutionReadinessCard http={http} />);
    await screen.findByTestId('execution-readiness-error');
    screen.getByRole('button', { name: /retry|重试/i }).click();
    await waitFor(() => expect(screen.getByTestId('execution-readiness-ready')).toBeTruthy());
  });
});
