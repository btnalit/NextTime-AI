// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { GatekeeperListRow } from '../../lib/governance.js';
import { useGatekeeperDirectory, useGatekeeperNames } from './useDirectoryNames.js';

/**
 * useDirectoryNames.test.tsx (closing wave C6, G7 — `kernel-console-coverage-2026-09-26.md`'s
 * "list_gatekeepers ×7" structural-debt note): `useGatekeeperDirectory` is the one shared read the
 * seven call sites this closes now go through instead of their own
 * `useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers')` — rows while loaded (`undefined`
 * before that, same "typed-id fallback vs. empty picker" distinction `ProcedureEditorHost`/
 * `WorkerEditorHost` rely on) plus the `RefChip`-ready name map every caller of the older
 * `useGatekeeperNames` (still a thin wrapper over it) already expected.
 */

afterEach(cleanup);

function scriptedHttp(
  items: readonly GatekeeperListRow[],
): CapabilityCaller & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    call: vi.fn(async (name: string) => {
      calls.push(name);
      if (name !== 'list_gatekeepers') throw new Error(`unscripted capability ${name}`);
      return { items };
    }) as CapabilityCaller['call'],
  };
}

function gatekeeper(overrides: Partial<GatekeeperListRow> = {}): GatekeeperListRow {
  return {
    id: 'gk-1',
    name: 'Docker prod',
    kind: 'mcp',
    status: 'enabled',
    operationCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function DirectoryProbe({ http }: { readonly http: CapabilityCaller }) {
  const { rows, names } = useGatekeeperDirectory(http);
  return (
    <div data-testid="probe">
      {rows === undefined ? 'loading' : `rows:${rows.length}`} / {names.get('gk-1') ?? 'unnamed'}
    </div>
  );
}

function NamesOnlyProbe({ http }: { readonly http: CapabilityCaller }) {
  const names = useGatekeeperNames(http);
  return <div data-testid="names-probe">{names.get('gk-1') ?? 'unnamed'}</div>;
}

describe('useGatekeeperDirectory / useGatekeeperNames', () => {
  it('resolves rows (undefined while loading) and a RefChip-ready name map from list_gatekeepers', async () => {
    const http = scriptedHttp([gatekeeper()]);
    render(<DirectoryProbe http={http} />);
    expect(screen.getByTestId('probe').textContent).toContain('loading');
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('rows:1 / Docker prod'),
    );
  });

  it('degrades to an empty names map (never throws) when the read fails', async () => {
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        throw new Error('boom');
      }) as CapabilityCaller['call'],
    };
    render(<NamesOnlyProbe http={http} />);
    // No name resolved — falls back to the bare-id path the caller already handles, never an
    // uncaught rejection surfacing as a render error.
    await waitFor(() => expect(screen.getByTestId('names-probe').textContent).toBe('unnamed'));
  });

  it('useGatekeeperNames (the pre-existing callers’ own hook) is unchanged — a thin wrapper over the same directory', async () => {
    const http = scriptedHttp([gatekeeper({ id: 'gk-1', name: 'RagFlow' })]);
    render(<NamesOnlyProbe http={http} />);
    await waitFor(() => expect(screen.getByTestId('names-probe').textContent).toBe('RagFlow'));
    expect(http.calls).toEqual(['list_gatekeepers']);
  });
});
