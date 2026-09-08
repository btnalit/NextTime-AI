import { CAPABILITY_REGISTRY, getCapability } from '@nexttime/shared';
import type { Role } from '@nexttime/shared';
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * hooks/usePermissions: what this session has learned it may, and may not, do. No capability
 * returns the current principal's role directly (kernel gap — see the PR report), so the console
 * infers it the only way it can: a `403 forbidden` on a capability marks it denied for the rest of
 * the session, and owner-/operator-only affordances (`set_auto_approved_action_kind`,
 * `list_pending`, the `connection` group, and S3.11's governance group) hide or disable themselves
 * with an explanation instead of offering a button that can only fail again. The mirror image —
 * `markAllowed`/`allowed` (S3.14) — records a capability call that actually *succeeded*: positive
 * role evidence `lib/role.ts` uses to show a best-effort role badge (there is no way to conclude
 * "this principal is an owner" from denials alone, only "is not one"). Reset by "Forget key" (the
 * provider remounts).
 *
 * The inference follows the kernel's own rule (`application/gateway/authorize.ts`
 * `roleSatisfiesMinRole`: `owner` satisfies everything; any other role satisfies `member` or an
 * exact match): a 403 on a capability whose registry `minRole` is `owner` proves the principal is
 * not an owner, so every other `minRole: 'owner'` capability is denied too; a 403 on a
 * `minRole: 'operator'` capability proves it is neither owner nor operator, so every operator-
 * and owner-only capability is denied. `deniedClosure` derives that closure from
 * `CAPABILITY_REGISTRY` (`packages/shared/src/capabilities.ts`) — no hand-typed capability lists.
 */
export interface Permissions {
  readonly denied: ReadonlySet<string>;
  readonly isDenied: (capabilityName: string) => boolean;
  readonly markDenied: (capabilityName: string) => void;
  /** Capabilities that have succeeded at least once this session (S3.14) — positive role evidence
   *  for `lib/role.ts`. Unlike `denied`, this carries no closure: a `list_quotas` (operator-
   *  minRole) success says nothing about whether an untried owner-minRole capability would also
   *  succeed. */
  readonly allowed: ReadonlySet<string>;
  readonly markAllowed: (capabilityName: string) => void;
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
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(() => new Set());
  const markDenied = useCallback((name: string) => {
    setDenied((prev) => {
      const next = new Set(prev);
      for (const implied of deniedClosure(name)) next.add(implied);
      return next.size === prev.size ? prev : next;
    });
  }, []);
  const markAllowed = useCallback((name: string) => {
    setAllowed((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
  }, []);
  const value = useMemo<Permissions>(
    () => ({ denied, isDenied: (name) => denied.has(name), markDenied, allowed, markAllowed }),
    [denied, markDenied, allowed, markAllowed],
  );
  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

const NONE: Permissions = {
  denied: new Set(),
  isDenied: () => false,
  markDenied: () => undefined,
  allowed: new Set(),
  markAllowed: () => undefined,
};

export function usePermissions(): Permissions {
  return useContext(PermissionsContext) ?? NONE;
}
