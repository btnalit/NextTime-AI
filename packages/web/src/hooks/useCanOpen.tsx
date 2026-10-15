import { type ReactNode, createContext, useCallback, useContext, useMemo } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { type RouteRequirement, routeRequirement } from '../lib/route-access.js';
import { useRoleCan } from './useRoleCan.js';

interface RouteAccess {
  /** The workspace caller whose role decides — the shell's `session.http`. */
  readonly http: CapabilityCaller | undefined;
  /** The signed-in user's platform role, for the `#/platform/*` routes. */
  readonly platformAdmin: boolean | null;
}

/** Outside the shell (a test rendering one component) nothing is known: links stay links. */
const RouteAccessContext = createContext<RouteAccess>({ http: undefined, platformAdmin: null });

export function RouteAccessProvider({
  http,
  platformAdmin,
  children,
}: RouteAccess & { readonly children: ReactNode }) {
  const value = useMemo(() => ({ http, platformAdmin }), [http, platformAdmin]);
  return <RouteAccessContext.Provider value={value}>{children}</RouteAccessContext.Provider>;
}

/**
 * hooks/useCanOpen: "may the signed-in reader open this in-app href?" by the route's own
 * requirement (`lib/route-access`) — `true` / `false`, or `null` while the reader's role is not
 * known yet (offer the link: the page itself still explains a refusal). #541 review N2: every
 * in-app navigation entry — link, button, toast action, deep link — asks here, not the page it
 * leads to. `http` overrides the shell's caller (`RouteAccessProvider`), for a hook that runs
 * above it.
 */
export function useCanOpen(http?: CapabilityCaller): (href: string) => boolean | null {
  const access = useContext(RouteAccessContext);
  const can = useRoleCan(http ?? access.http);
  const { platformAdmin } = access;
  return useCallback(
    (href: string) => meets(routeRequirement(href), can, platformAdmin),
    [can, platformAdmin],
  );
}

function meets(
  requirement: RouteRequirement | undefined,
  can: ReturnType<typeof useRoleCan>,
  platformAdmin: boolean | null,
): boolean | null {
  if (requirement === undefined) return true;
  if ('capability' in requirement) return can(requirement.capability);
  return platformAdmin;
}
