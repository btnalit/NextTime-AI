import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * hooks/usePermissions: what this session has learned it may not do. No capability returns the
 * current principal's role today (kernel gap — see the PR report), so the console infers it the
 * only way it can: a `403 forbidden` on a capability marks that capability denied for the rest
 * of the session, and owner-/operator-only affordances (`set_auto_approved_action_kind`,
 * `list_pending`, the `connection` group) hide or disable themselves with an explanation instead
 * of offering a button that can only fail again. Reset by "Forget key" (the provider remounts).
 */
export interface Permissions {
  readonly denied: ReadonlySet<string>;
  readonly isDenied: (capabilityName: string) => boolean;
  readonly markDenied: (capabilityName: string) => void;
}

const PermissionsContext = createContext<Permissions | null>(null);

export function PermissionsProvider({ children }: { readonly children: ReactNode }) {
  const [denied, setDenied] = useState<ReadonlySet<string>>(() => new Set());
  const markDenied = useCallback((name: string) => {
    setDenied((prev) => (prev.has(name) ? prev : new Set([...prev, name])));
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
