import {
  type CapabilityName,
  type Role,
  getCapability,
  roleMayUseCapability,
} from '@nexttime/shared';
import { type Route, routeFromHash } from './router.js';

/**
 * lib/route-access: what each route needs before its page has anything to show (#541 review N2).
 * The one place a route says it — the sidebar, every in-app link, toast action and deep link ask
 * here (`hooks/useCanOpen`), so an entry the reader's role cannot open is not offered as a link
 * and says whom to ask instead; opening such a route directly still lands on the page's own
 * explanation.
 *
 *   - `capability`: the read the page cannot work without; the reader's workspace role decides
 *     (`roleMayUseCapability`, the kernel's own predicate). An approval's detail (`get_action`)
 *     and the queue (`list_pending`) are open to the same roles.
 *   - `platformAdmin`: a `#/platform/*` page (`scope:'platform'`, the cookie channel decides).
 *
 * A route that is not listed is open to every member of the workspace.
 */
export type RouteRequirement =
  | { readonly capability: CapabilityName }
  | { readonly platformAdmin: true };

const PLATFORM: RouteRequirement = { platformAdmin: true };

export const ROUTE_REQUIRES: Readonly<Partial<Record<Route['kind'], RouteRequirement>>> = {
  approvals: { capability: 'list_pending' },
  members: { capability: 'list_principals' },
  audit: { capability: 'audit_query' },
  platformOverview: PLATFORM,
  platformUsers: PLATFORM,
  platformWorkspaces: PLATFORM,
  platformIntegrations: PLATFORM,
  platformModules: PLATFORM,
  platformModels: PLATFORM,
  platformSettings: PLATFORM,
  platformRuntime: PLATFORM,
  platformStatus: PLATFORM,
  platformAudit: PLATFORM,
  platformResidue: PLATFORM,
};

/** The requirement of the route an in-app `#/…` href opens (`undefined`: open to every member;
 *  an href outside the hash router, like `/explorer/`, is not this table's to judge). */
export function routeRequirement(href: string): RouteRequirement | undefined {
  if (!href.startsWith('#/')) return undefined;
  return ROUTE_REQUIRES[routeFromHash(href).kind];
}

/** Whether a known workspace role clears an href's role requirement (the sidebar's check; a
 *  component with a caller asks `hooks/useCanOpen`). A platform route is the platform role's to
 *  decide, not this one's. */
export function roleMayOpen(role: Role, href: string): boolean {
  const requirement = routeRequirement(href);
  return (
    requirement === undefined ||
    !('capability' in requirement) ||
    roleMayUseCapability(role, getCapability(requirement.capability))
  );
}
