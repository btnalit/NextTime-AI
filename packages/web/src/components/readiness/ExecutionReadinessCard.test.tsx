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

  it('ready: shows the three counts and a ready line, no missing list', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: true,
          gates: [
            { gateId: 'g-1', name: 'CRM', granted: true, publishedOperationCount: 3 },
            { gateId: 'g-2', name: 'Billing', granted: false, publishedOperationCount: 1 },
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
    const counts = await screen.findByTestId('execution-readiness-counts');
    expect(counts.textContent).toContain('2'); // gates available
    expect(counts.textContent).toContain('1'); // gates granted
    expect(screen.getByTestId('execution-readiness-ready')).toBeTruthy();
    expect(screen.queryByTestId('execution-readiness-missing')).toBeNull();
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
          gates: [{ gateId: 'g-9', name: 'Payments', granted: false, publishedOperationCount: 2 }],
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
