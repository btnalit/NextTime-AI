import { CAPABILITY_REGISTRY, getCapability } from '@nexttime/shared';
import type { Role } from '@nexttime/shared';
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * hooks/usePermissions: what this session has learned it may not do. No capability returns the
 * current principal's role today (kernel gap — see the PR report), so the console infers it the
 * only way it can: a `403 forbidden` on a capability marks it denied for the rest of the session,
 * and owner-/operator-only affordances (`set_auto_approved_action_kind`, `list_pending`, the
 * `connection` group) hide or disable themselves with an explanation instead of offering a button
 * that can only fail again. Reset by "Forget key" (the provider remounts).
 *
 * The inference follows the kernel's own rule (`application/gateway/authorize.ts`
 * `roleSatisfiesMinRole`: `owner` satisfies everything; any other role satisfies `member` or an
 * exact match): a 403 on a capability whose registry `minRole` is `owner` proves the principal is
 * not an owner, so every other `minRole: 'owner'` capability is denied too; a 403 on a
 * `minRole: 'operator'` capability proves it is neither owner nor operator, so every operator-
 * and owner-only capability is denied. `deniedRolesFor` derives that closure from
 * `CAPABILITY_REGISTRY` (`packages/shared/src/capabilities.ts`) — no hand-typed capability lists.
 */
export interface Permissions {
  readonly denied: ReadonlySet<string>;
  readonly isDenied: (capabilityName: string) => boolean;
  readonly markDenied: (capabilityName: string) => void;
}

/** Given a 403 on `capabilityName`, every capability the same principal must also be refused. */
export function deniedClosure(capabilityName: string): ReadonlySet<string> {
  const minRole = getCapability(capabilityName)?.minRole;
  const impliedRoles: readonly Role[] =
    minRole === 'owner' ? ['owner'] : minRole === 'operator' ? ['operator', 'owner'] : [];
  const closure = new Set<string>([capabilityName]);
  if (impliedRoles.length === 0) return closure;
  for (const capability of CAPABILITY_REGISTRY) {
    if (capability.minRole !== undefined && impliedRoles.includes(capability.minRole)) {
      closure.add(capability.name);
    }
  }
  return closure;
}

const PermissionsContext = createContext<Permissions | null>(null);

export function PermissionsProvider({ children }: { readonly children: ReactNode }) {
  const [denied, setDenied] = useState<ReadonlySet<string>>(() => new Set());
  const markDenied = useCallback((name: string) => {
    setDenied((prev) => {
      const next = new Set(prev);
      for (const implied of deniedClosure(name)) next.add(implied);
      return next.size === prev.size ? prev : next;
    });
  }, []);
  const value = useMemo<Permissions>(
    () => ({ denied, isDenied: (name) => denied.has(name), markDenied }),
    [denied, markDenied],
  );
  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

const NONE: Permissions = {
  denied: new Set(),
  isDenied: () => false,
  markDenied: () => undefined,
};

export function usePermissions(): Permissions {
  return useContext(PermissionsContext) ?? NONE;
}
