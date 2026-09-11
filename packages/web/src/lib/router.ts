/**
 * lib/router: hash routes (no router library — see the S3.14 PR report for why: this file already
 * carried S1.8's own hand-rolled convention with zero dependencies, and the new route set below is
 * still a flat list with optional trailing segments — nothing here needs nested layouts, data
 * loaders, or history-stack features a library would add. Extending the existing convention keeps
 * `pnpm --filter @nexttime/web build`'s bundle dependency-free, matching this package's own
 * documented "no UI framework, no router library" stance, README.md). A hard reload lands back on
 * the same view with no server-side routing. Detail drawers are addressable (`#/work/approvals/<id>`,
 * `#/work/tasks/<id>`, `#/govern/systems/<id>`) so a chat notice or a bookmark can deep-link
 * straight into one.
 *
 * S3.14 restructure: routes now sit under three prefixes — `work/*` (chat/approvals/tasks, the
 * S1/S2 acceptance surface), `me/*` (per-user settings, S3.13's mount point), `govern/*` (the
 * owner/operator control plane, S3.11's mount point). `NavSection` is one-to-one with a Sidebar nav
 * item; `sectionOf` collapses route variants (`chat` detail → `chats` section, a catalog tab →
 * `catalog` section) onto their nav item for `aria-current`/active-state.
 */
export type NavSection =
  | 'chats'
  | 'approvals'
  | 'tasks'
  | 'agent'
  | 'account'
  | 'members'
  | 'access'
  | 'systems'
  | 'catalog'
  | 'models'
  | 'audit'
  | 'platformOverview'
  | 'platformUsers'
  | 'platformSettings'
  | 'platformAudit';

export const CATALOG_TAB_VALUES = ['operations', 'skills', 'procedures', 'workers'] as const;
export type CatalogTab = (typeof CATALOG_TAB_VALUES)[number];

export type Route =
  | { readonly kind: 'login' }
  | { readonly kind: 'chats' }
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'approvals'; readonly actionRequestId?: string }
  | { readonly kind: 'tasks'; readonly taskId?: string }
  | { readonly kind: 'agent' }
  | { readonly kind: 'account' }
  | { readonly kind: 'members' }
  | { readonly kind: 'access' }
  | { readonly kind: 'systems'; readonly gatekeeperId?: string }
  | { readonly kind: 'catalog'; readonly tab: CatalogTab }
  | { readonly kind: 'models' }
  | { readonly kind: 'audit' }
  | { readonly kind: 'platformOverview' }
  | { readonly kind: 'platformUsers' }
  | { readonly kind: 'platformSettings' }
  | { readonly kind: 'platformAudit' };

function isCatalogTab(value: string | undefined): value is CatalogTab {
  return value !== undefined && (CATALOG_TAB_VALUES as readonly string[]).includes(value);
}

/** Unmatched/unknown hashes (including a stale `#/login` while already signed in, and every pre-
 *  S3.14 `#/chats`-style hash a bookmark might still carry) fall back to the default work view —
 *  the "unknown route → redirect to /work/chats" rule. This mirrors the pre-S3.14 fallback's own
 *  shape (return the default `Route` object rather than rewriting `window.location.hash` itself);
 *  see this module's doc comment. */
const DEFAULT_ROUTE: Route = { kind: 'chats' };

export function routeFromHash(hash: string): Route {
  if (hash === '#/login') return { kind: 'login' };

  const chat = /^#\/work\/chats\/(.+)$/.exec(hash);
  if (chat?.[1]) return { kind: 'chat', chatId: decodeURIComponent(chat[1]) };
  if (hash === '#/work/chats') return { kind: 'chats' };

  const approval = /^#\/work\/approvals(?:\/(.+))?$/.exec(hash);
  if (approval) {
    return approval[1]
      ? { kind: 'approvals', actionRequestId: decodeURIComponent(approval[1]) }
      : { kind: 'approvals' };
  }

  const task = /^#\/work\/tasks(?:\/(.+))?$/.exec(hash);
  if (task) {
    return task[1] ? { kind: 'tasks', taskId: decodeURIComponent(task[1]) } : { kind: 'tasks' };
  }

  if (hash === '#/me/agent') return { kind: 'agent' };
  if (hash === '#/me/account') return { kind: 'account' };

  if (hash === '#/govern/members') return { kind: 'members' };
  if (hash === '#/govern/access') return { kind: 'access' };

  const systems = /^#\/govern\/systems(?:\/(.+))?$/.exec(hash);
  if (systems) {
    return systems[1]
      ? { kind: 'systems', gatekeeperId: decodeURIComponent(systems[1]) }
      : { kind: 'systems' };
  }

  const catalog = /^#\/govern\/catalog(?:\/(.+))?$/.exec(hash);
  if (catalog) {
    const tab = catalog[1] ? decodeURIComponent(catalog[1]) : undefined;
    return { kind: 'catalog', tab: isCatalogTab(tab) ? tab : 'operations' };
  }

  if (hash === '#/govern/models') return { kind: 'models' };
  if (hash === '#/govern/audit') return { kind: 'audit' };

  if (hash === '#/platform/overview') return { kind: 'platformOverview' };
  if (hash === '#/platform/users') return { kind: 'platformUsers' };
  if (hash === '#/platform/settings') return { kind: 'platformSettings' };
  if (hash === '#/platform/audit') return { kind: 'platformAudit' };

  return DEFAULT_ROUTE;
}

/** The Sidebar item (and push-toast "already looking at it" check) a route belongs to. `login`
 *  never reaches the Sidebar (the shell only renders once authenticated) — `Routed` in App.tsx
 *  redirects a stray `#/login` to `hrefs.chats()` before this is consulted. */
export function sectionOf(route: Route): NavSection {
  switch (route.kind) {
    case 'chat':
      return 'chats';
    case 'login':
      return 'chats';
    default:
      return route.kind;
  }
}

export const hrefs = {
  login: () => '#/login',
  chats: () => '#/work/chats',
  chat: (chatId: string) => `#/work/chats/${encodeURIComponent(chatId)}`,
  approvals: () => '#/work/approvals',
  approval: (actionRequestId: string) => `#/work/approvals/${encodeURIComponent(actionRequestId)}`,
  tasks: () => '#/work/tasks',
  task: (taskId: string) => `#/work/tasks/${encodeURIComponent(taskId)}`,
  agent: () => '#/me/agent',
  account: () => '#/me/account',
  members: () => '#/govern/members',
  access: () => '#/govern/access',
  systems: () => '#/govern/systems',
  gatekeeper: (gatekeeperId: string) => `#/govern/systems/${encodeURIComponent(gatekeeperId)}`,
  catalog: (tab: CatalogTab = 'operations') => `#/govern/catalog/${tab}`,
  models: () => '#/govern/models',
  audit: () => '#/govern/audit',
  platformOverview: () => '#/platform/overview',
  platformUsers: () => '#/platform/users',
  platformSettings: () => '#/platform/settings',
  platformAudit: () => '#/platform/audit',
} as const;

export function navigate(href: string): void {
  window.location.hash = href;
}
