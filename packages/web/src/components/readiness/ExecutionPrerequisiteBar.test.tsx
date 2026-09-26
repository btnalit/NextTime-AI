// @vitest-environment jsdom
import type { ExecutionReadinessWire } from '@nexttime/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ExecutionPrerequisiteBar } from './ExecutionPrerequisiteBar.js';

afterEach(cleanup);

/**
 * ExecutionPrerequisiteBar.test.tsx (S8 W2 U3a, ui-audit-2026-09-23 J1 — the shared "执行前提"
 * hint bar mounted on 系统接入 / 能力目录 / 访问): hidden while loading, hidden once ready, and
 * — while not ready — one line per `missing[]` item with its cause and a fix-it link, never the
 * raw code or a raw id.
 */

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller {
  return {
    call: vi.fn(async (name: string, params?: unknown) => {
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

describe('ExecutionPrerequisiteBar', () => {
  it('renders nothing while loading', () => {
    const http = scriptedHttp({ execution_readiness: () => new Promise(() => undefined) });
    render(<ExecutionPrerequisiteBar http={http} />);
    expect(screen.queryByTestId('execution-prerequisite-bar')).toBeNull();
  });

  it('hidden once ready', async () => {
    const http = scriptedHttp({ execution_readiness: () => readiness({ ready: true }) });
    render(<ExecutionPrerequisiteBar http={http} />);
    // Give the pending call a tick to resolve, then assert it never renders.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('execution-prerequisite-bar')).toBeNull();
  });

  it('renders nothing on a load error (a supplementary hint, never a page-blocking error)', async () => {
    const http = scriptedHttp({
      execution_readiness: () => {
        throw new Error('boom');
      },
    });
    render(<ExecutionPrerequisiteBar http={http} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('execution-prerequisite-bar')).toBeNull();
  });

  it('not ready: one line per missing item, no raw code or raw id, each linking to its fix-it page', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          ready: false,
          missing: [{ code: 'no_enabled_gate' }, { code: 'no_grant', gateId: 'g-1' }],
          gates: [
            {
              gateId: 'g-1',
              name: 'CRM',
              granted: false,
              publishedOperationCount: 0,
              observeOperationCount: 0,
              executeOperationCount: 0,
              excludedByPolicy: false,
              excludedByProfile: false,
              inEntryScope: false,
              workerDefinitionIds: [],
              status: 'unreachable',
              reason: 'no_published_operation',
            },
          ],
        }),
    });
    render(<ExecutionPrerequisiteBar http={http} />);
    const bar = await screen.findByTestId('execution-prerequisite-bar');
    expect(bar.textContent).not.toContain('no_enabled_gate');
    expect(bar.textContent).not.toContain('no_grant');
    expect(bar.textContent).not.toContain('g-1');
    expect(bar.textContent).toContain('CRM');
    const links = bar.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe('#/govern/systems');
    expect(links[1]?.getAttribute('href')).toBe('#/govern/access');
  });
});
