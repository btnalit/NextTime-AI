// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { PermissionsProvider } from './usePermissions.js';
import { useWorkspaceIdentity } from './useWorkspaceIdentity.js';

afterEach(cleanup);

function scriptedHttp(handler: () => unknown | Promise<unknown>): CapabilityCaller {
  return { call: vi.fn(async () => handler()) as CapabilityCaller['call'] };
}

describe('useWorkspaceIdentity', () => {
  it('prefers the authoritative caller.role from get_workspace once it resolves', async () => {
    const http = scriptedHttp(() => ({
      id: 'ws-1',
      name: 'Acme',
      createdAt: '2026-01-01T00:00:00Z',
      principalCount: 3,
      gatekeeperCount: 1,
      caller: { id: 'p-1', role: 'auditor', displayName: 'Ada', kind: 'human' },
    }));
    const { result } = renderHook(() => useWorkspaceIdentity(http), {
      wrapper: PermissionsProvider,
    });

    // Before the read resolves, the role is a best-effort inferred bucket (unknown — no
    // evidence yet), not a guess at the real role.
    expect(result.current.role).toEqual({ kind: 'inferred', role: 'unknown' });

    await waitFor(() => expect(result.current.role).toEqual({ kind: 'known', role: 'auditor' }));
    expect(result.current.workspaceName).toBe('Acme');
  });

  it('falls back to inference when get_workspace 404s (a kernel predating the caller field)', async () => {
    const http = scriptedHttp(() =>
      Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    );
    const { result } = renderHook(() => useWorkspaceIdentity(http), {
      wrapper: PermissionsProvider,
    });

    await waitFor(() => expect(result.current.role).toEqual({ kind: 'inferred', role: 'unknown' }));
    expect(result.current.workspaceName).toBe('Workspace console');
  });

  it('falls back to inference on a forbidden error too, using whatever evidence permissions already has', async () => {
    const http = scriptedHttp(() =>
      Promise.reject(new HttpError('capability_error', 'nope', 'forbidden')),
    );
    const { result } = renderHook(() => useWorkspaceIdentity(http), {
      wrapper: PermissionsProvider,
    });

    await waitFor(() => expect(result.current.role.kind).toBe('inferred'));
  });
});
