// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Permissions,
  PermissionsProvider,
  deniedClosure,
  usePermissions,
} from './usePermissions.js';

afterEach(cleanup);

function Probe({ onReady }: { readonly onReady: (permissions: Permissions) => void }) {
  onReady(usePermissions());
  return null;
}

describe('usePermissions', () => {
  it('derives the denial closure from the capability registry minRole', () => {
    // owner-only 403 → every owner-only capability, nothing operator-level
    const owner = deniedClosure('list_connection_requests');
    expect(owner.has('create_connection')).toBe(true);
    expect(owner.has('publish_manifest')).toBe(true);
    expect(owner.has('connect_gatekeeper')).toBe(true);
    expect(owner.has('grant_capability')).toBe(true);
    expect(owner.has('list_pending')).toBe(false);

    // operator-only 403 → operator-only and owner-only capabilities alike
    const operator = deniedClosure('list_pending');
    expect(operator.has('approve')).toBe(true);
    expect(operator.has('set_auto_approved_action_kind')).toBe(true);
    expect(operator.has('create_connection')).toBe(true);
    expect(operator.has('list_tasks')).toBe(false);
    expect(operator.has('list_chats')).toBe(false);

    // a capability with no minRole (or unknown) denies only itself
    expect([...deniedClosure('publish_skill')]).toEqual(['publish_skill']);
    expect([...deniedClosure('not_a_capability')]).toEqual(['not_a_capability']);
  });

  it('markDenied records the closure for the session; outside a provider nothing is denied', () => {
    let latest: Permissions | undefined;
    render(
      <PermissionsProvider>
        <Probe
          onReady={(permissions) => {
            latest = permissions;
          }}
        />
      </PermissionsProvider>,
    );
    expect(latest?.isDenied('publish_manifest')).toBe(false);
    act(() => latest?.markDenied('list_connection_requests'));
    expect(latest?.isDenied('publish_manifest')).toBe(true);
    expect(latest?.isDenied('list_pending')).toBe(false);

    let bare: Permissions | undefined;
    render(
      <Probe
        onReady={(permissions) => {
          bare = permissions;
        }}
      />,
    );
    bare?.markDenied('list_pending');
    expect(bare?.isDenied('list_pending')).toBe(false);
  });
});
