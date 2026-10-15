// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import type { ActionPendingPush } from '../lib/ws-client.js';
import { PermissionsProvider } from './usePermissions.js';
import { usePushToasts } from './usePushToasts.js';

// The hook's toasts, as pushed (the legacy toast kit itself is not this test's subject).
const pushed = vi.hoisted(
  () => [] as { title: string; description?: string; action?: { label: string } }[],
);
vi.mock('../components/ui/Toast.js', () => ({
  useToast: () => ({
    push: (toast: (typeof pushed)[number]) => pushed.push(toast),
    dismiss: () => undefined,
  }),
}));

afterEach(() => {
  cleanup();
  pushed.length = 0;
});

function caller(role: string): CapabilityCaller {
  return {
    call: vi.fn(async (name: string) => {
      if (name === 'get_workspace')
        return { id: 'ws-1', name: 'Acme', caller: { id: 'p-1', role } };
      return {};
    }) as CapabilityCaller['call'],
  };
}

function pushes() {
  let pending: ((event: ActionPendingPush) => void) | null = null;
  const source: PushSource = {
    onActionPending: (handler: (event: ActionPendingPush) => void) => {
      pending = handler;
      return () => undefined;
    },
    onActionUpdated: () => () => undefined,
    onTaskUpdated: () => () => undefined,
  } as unknown as PushSource;
  return { source, fire: (event: ActionPendingPush) => pending?.(event) };
}

function Harness({
  source,
  http,
}: { readonly source: PushSource; readonly http: CapabilityCaller }) {
  usePushToasts(source, 'chats', http);
  return null;
}

const EVENT: ActionPendingPush = {
  actionRequestId: 'ar-1',
  gatekeeperId: 'gk-1',
  title: '',
  description: '',
  actionKind: { tag: 'restart', label: 'restart' },
  awaitDecision: true,
};

async function renderFor(role: string) {
  const http = caller(role);
  const { source, fire } = pushes();
  render(
    <PermissionsProvider>
      <Harness source={source} http={http} />
    </PermissionsProvider>,
  );
  await waitFor(() =>
    expect(vi.mocked(http.call).mock.calls.some(([name]) => name === 'get_workspace')).toBe(true),
  );
  // The role has answered before the push arrives.
  await act(async () => undefined);
  act(() => fire(EVENT));
}

describe('usePushToasts (#541 review N2)', () => {
  it('an approver gets the review action, in Chinese', async () => {
    await renderFor('operator');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.title).toMatch(/^待审批：restart$/);
    expect(pushed[0]?.action?.label).toMatch(/^去审批$/);
  });

  it('the member it was requested for is told who decides, with no way onto the approvals page', async () => {
    await renderFor('member');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.title).toMatch(/^已提交审批：restart$/);
    expect(pushed[0]?.description).toMatch(/等待 operator 或工作区所有者处理/);
    expect(pushed[0]?.action).toBeUndefined();
  });
});
