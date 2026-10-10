import { getCapability, roleMayUseCapability } from '@nexttime/shared';
import { useCallback } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { usePermissions } from './usePermissions.js';
import { useWorkspaceIdentity } from './useWorkspaceIdentity.js';

/**
 * hooks/useRoleCan: "may the signed-in reader use this capability here?" with the kernel's own
 * predicate (`roleMayUseCapability`, shared with `application/gateway/authorize.ts`) once
 * `get_workspace` said the role; `null` while that read is still in flight; after it failed (an
 * older kernel, no workspace), whatever this session learned from a 403 (`usePermissions`).
 * A page hides a control the reader's role can never use (`can(x) !== false`) and holds a read
 * until it is sure (`can(x) === true`) — #541 acceptance must-fix 2; the same rule
 * `lib/http-client.ts`'s `roleGate` applies to the request itself.
 */
export function useRoleCan(http: CapabilityCaller): (capabilityName: string) => boolean | null {
  const { role, roleSettled } = useWorkspaceIdentity(http);
  const permissions = usePermissions();
  const knownRole = role.kind === 'known' ? role.role : null;
  const { isDenied } = permissions;
  return useCallback(
    (capabilityName: string) =>
      knownRole !== null
        ? roleMayUseCapability(knownRole, getCapability(capabilityName))
        : roleSettled
          ? !isDenied(capabilityName)
          : null,
    [knownRole, roleSettled, isDenied],
  );
}
