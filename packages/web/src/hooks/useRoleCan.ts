import { type CapabilityName, getCapability, roleMayUseCapability } from '@nexttime/shared';
import { useCallback } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { usePermissions } from './usePermissions.js';
import { useWorkspaceIdentity } from './useWorkspaceIdentity.js';

/** For a component rendered without a workspace caller (a read-only view): no role is read, so
 *  every name answers from this session's 403s. */
const NO_CALLER: CapabilityCaller = {
  call: () => Promise.reject(new Error('no workspace caller')),
};

/**
 * hooks/useRoleCan: "may the signed-in reader use this capability here?" with the kernel's own
 * predicate (`roleMayUseCapability`, shared with `application/gateway/authorize.ts`) once
 * `get_workspace` said the role; `null` while that read is still in flight; after it failed (an
 * older kernel, no workspace), whatever this session learned from a 403 (`usePermissions`).
 * A page hides a control the reader's role can never use (`can(x) !== false`) and holds a read
 * until it is sure (`can(x) === true`) — #541 acceptance must-fix 2; the same rule
 * `lib/http-client.ts`'s `roleGate` applies to the request itself.
 */
export function useRoleCan(
  http: CapabilityCaller | undefined,
): (capabilityName: CapabilityName) => boolean | null {
  const { role, roleSettled } = useWorkspaceIdentity(http ?? NO_CALLER);
  const permissions = usePermissions();
  const knownRole = role.kind === 'known' ? role.role : null;
  const { isDenied } = permissions;
  return useCallback(
    (capabilityName: CapabilityName) =>
      knownRole !== null
        ? roleMayUseCapability(knownRole, getCapability(capabilityName))
        : roleSettled
          ? !isDenied(capabilityName)
          : null,
    [knownRole, roleSettled, isDenied],
  );
}
