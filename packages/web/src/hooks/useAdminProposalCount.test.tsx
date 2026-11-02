// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../lib/clients.js';
import { notifyAdminProposalsDecided, useAdminProposalCount } from './useAdminProposalCount.js';
import { PermissionsProvider } from './usePermissions.js';

afterEach(cleanup);

/** `get_workspace` says the role; `get_admin_proposal_segment_counts` answers `proposed` in turn. */
function caller(role: string, answers: number[]) {
  const counts: string[] = [];
  const http: CapabilityCaller = {
    call: vi.fn(async (name: string) => {
      if (name === 'get_workspace') {
        return { id: 'ws-1', name: 'Ops', caller: { id: 'p-1', kind: 'human', role } };
      }
      if (name === 'get_admin_proposal_segment_counts') {
        counts.push(name);
        return { proposed: answers.shift() ?? 0 };
      }
      throw new Error(`unscripted capability ${name}`);
    }) as CapabilityCaller['call'],
  };
  return { http, reads: () => counts.length };
}

describe('useAdminProposalCount (S11 AA4e)', () => {
  it("the owner's count, read again on navigation and after a decision here", async () => {
    const { http, reads } = caller('owner', [2, 1, 0]);
    const { result } = renderHook(() => useAdminProposalCount(http, SILENT_PUSH_SOURCE), {
      wrapper: PermissionsProvider,
    });
    await waitFor(() => expect(result.current).toBe(2));

    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(result.current).toBe(1));

    act(() => notifyAdminProposalsDecided());
    await waitFor(() => expect(result.current).toBe(0));
    expect(reads()).toBe(3);
  });

  it('nothing, and no read, for anyone but the owner', async () => {
    for (const role of ['builder', 'operator', 'member', 'auditor']) {
      const { http, reads } = caller(role, [5]);
      const { result, unmount } = renderHook(
        () => useAdminProposalCount(http, SILENT_PUSH_SOURCE),
        { wrapper: PermissionsProvider },
      );
      await waitFor(() =>
        expect(vi.mocked(http.call).mock.calls.some(([name]) => name === 'get_workspace')).toBe(
          true,
        ),
      );
      act(() => {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(result.current, role).toBeNull();
      expect(reads(), role).toBe(0);
      unmount();
    }
  });
});
