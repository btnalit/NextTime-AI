import { type Locator, type Page, expect } from '@playwright/test';
import { reachLoginForm } from '../auth-helpers.js';
import { loginAsAdmin, loginAsOwner } from '../lib/auth.js';
import { settleForCapture } from '../lib/determinism.js';

/**
 * e2e/00-gates/surfaces.ts: the enumerated set of console routes S8 W1-B's three CI gates
 * (screenshot/axe/copy-guard, `docs/development-tasks.md` §5e F5) all iterate over — one registry
 * shared by `screenshot.spec.ts` and `content.spec.ts` rather than two independent route lists
 * drifting apart. Enumerated from `lib/router.ts`'s `Route` union plus `components/shell/
 * Sidebar.tsx`'s three nav groups (使用/治理/平台) — every `Route.kind` that is reachable from the
 * signed-in shell on the fake stack is here once, except:
 * - `login`: not a `Route.kind` reachable *from* the shell (App.tsx redirects a stray `#/login`
 *   away once signed in) — handled as its own pre-auth surface below instead.
 * - `chat`/detail and the pending-approval detail: these need a concrete entity id, so they are
 *   `STATES` (see below) rather than a static `Surface` — a fresh chat/the seeded pending
 *   ActionRequest, created or located at test time.
 *
 * Widths: the three §5e F5 breakpoints (1440 desktop / 1280 laptop / 768 narrow — the point
 * Sidebar's own comment says it collapses to a top bar, `styles/shell.css`). Height fixed at 900:
 * `toHaveScreenshot`'s default `fullPage: false` then captures exactly this frame regardless of
 * how long a list page's content is below the fold — see determinism.ts's own doc comment for why
 * that matters here.
 */

export const WIDTHS = [1440, 1280, 768] as const;
export type Width = (typeof WIDTHS)[number];
export const VIEWPORT_HEIGHT = 900;

export type Role = 'none' | 'owner' | 'admin';

export interface Surface {
  /** Stable id — used as the screenshot/baseline key ("page × width at a glance"). kebab-case,
   *  matches the route's own nav section name where one exists. */
  readonly id: string;
  readonly labelZh: string;
  /** `null` for the pre-auth login surface (no hash route to visit — a bare `/` with no session
   *  already lands there). */
  readonly hash: string | null;
  readonly role: Role;
  /** Resolves once the page has actually rendered its data (not just its shell) — a heading text
   *  (every page's `<h1>` comes from `components/ui/PageHeader.tsx`'s `title` prop, read directly
   *  from each page component's own source — see the per-surface comments below for which) or an
   *  existing `data-testid` an already-shipped spec already relies on. */
  readonly ready: (page: Page) => Locator;
}

function heading(page: Page, name: string): Locator {
  return page.getByRole('heading', { name, exact: true });
}

export const SURFACES: readonly Surface[] = [
  // --- pre-auth --------------------------------------------------------------------------------
  {
    id: 'login',
    labelZh: '登录',
    hash: null,
    role: 'none',
    // Special-cased in `goToSurface` below (needs `reachLoginForm`'s own retry-poll, not a plain
    // `toBeVisible`) — this locator is never actually awaited for the login surface.
    ready: (page) => page.getByRole('button', { name: 'Log in' }),
  },

  // --- 使用 Use (WORK_NAV, Sidebar.tsx) ----------------------------------------------------------
  {
    id: 'chats',
    labelZh: '对话',
    hash: '#/work/chats',
    role: 'owner',
    ready: (page) => heading(page, '对话 Chats'), // ChatListPage.tsx PageHeader title
  },
  {
    id: 'approvals',
    labelZh: '待我审批',
    hash: '#/work/approvals',
    role: 'owner',
    ready: (page) => heading(page, '待我审批 Approvals'), // ApprovalQueuePage.tsx
  },
  {
    id: 'tasks',
    labelZh: '任务',
    hash: '#/work/tasks',
    role: 'owner',
    ready: (page) => heading(page, '任务 Tasks'), // TasksPage.tsx
  },
  {
    id: 'graph',
    labelZh: '图谱',
    hash: '#/work/graph',
    role: 'owner',
    ready: (page) => heading(page, '图谱 Graph'), // graph/GraphPage.tsx
  },
  {
    id: 'agent',
    labelZh: '我的智能体',
    hash: '#/me/agent',
    role: 'owner',
    ready: (page) => page.getByTestId('agent-profile-effective'), // AgentProfilePage.tsx
  },
  {
    id: 'account',
    labelZh: '我的账户',
    hash: '#/me/account',
    role: 'owner',
    ready: (page) => heading(page, '我的账户 My Account'), // AccountPage.tsx
  },

  // --- 治理 Govern (GOVERN_NAV) -----------------------------------------------------------------
  {
    id: 'members',
    labelZh: '成员与授权',
    hash: '#/govern/members',
    role: 'owner',
    ready: (page) => page.getByTestId('members-list'), // MembersPage.tsx
  },
  {
    id: 'access',
    labelZh: '访问',
    hash: '#/govern/access',
    role: 'owner',
    ready: (page) => heading(page, '访问 Access'), // AccessPage.tsx
  },
  {
    id: 'systems',
    labelZh: '系统接入',
    hash: '#/govern/systems',
    role: 'owner',
    ready: (page) => heading(page, '系统接入 Systems'), // ConnectionsPage.tsx
  },
  // CatalogPage.tsx renders the same "能力目录 Catalog" heading for all five tabs — only the tab
  // body under it changes (Tabs component, `#/govern/catalog/<tab>`).
  {
    id: 'catalog-operations',
    labelZh: '能力目录 · Operation',
    hash: '#/govern/catalog/operations',
    role: 'owner',
    ready: (page) => heading(page, '能力目录 Catalog'),
  },
  {
    id: 'catalog-skills',
    labelZh: '能力目录 · Skill',
    hash: '#/govern/catalog/skills',
    role: 'owner',
    ready: (page) => heading(page, '能力目录 Catalog'),
  },
  {
    id: 'catalog-procedures',
    labelZh: '能力目录 · Procedure',
    hash: '#/govern/catalog/procedures',
    role: 'owner',
    ready: (page) => heading(page, '能力目录 Catalog'),
  },
  {
    id: 'catalog-workers',
    labelZh: '能力目录 · Worker',
    hash: '#/govern/catalog/workers',
    role: 'owner',
    ready: (page) => heading(page, '能力目录 Catalog'),
  },
  {
    id: 'catalog-modules',
    labelZh: '能力目录 · Module',
    hash: '#/govern/catalog/modules',
    role: 'owner',
    ready: (page) => heading(page, '能力目录 Catalog'),
  },
  {
    id: 'models',
    labelZh: '模型与配额',
    hash: '#/govern/models',
    role: 'owner',
    ready: (page) => heading(page, '模型与配额 Models & Quotas'), // ModelsPage.tsx
  },
  {
    id: 'audit',
    labelZh: '审计',
    hash: '#/govern/audit',
    role: 'owner',
    ready: (page) => heading(page, '审计 Audit'), // AuditPage.tsx
  },

  // --- 平台 Platform (PLATFORM_NAV, admin only) -------------------------------------------------
  {
    id: 'platform-overview',
    labelZh: '平台 · 概览',
    hash: '#/platform/overview',
    role: 'admin',
    ready: (page) => heading(page, '概览 Overview'), // PlatformOverviewPage.tsx
  },
  {
    id: 'platform-workspaces',
    labelZh: '平台 · 工作区',
    hash: '#/platform/workspaces',
    role: 'admin',
    ready: (page) => page.getByTestId('platform-workspaces-page'),
  },
  {
    id: 'platform-users',
    labelZh: '平台 · 用户',
    hash: '#/platform/users',
    role: 'admin',
    ready: (page) => heading(page, '用户 Users'), // PlatformUsersPage.tsx
  },
  {
    id: 'platform-integrations',
    labelZh: '平台 · 集成',
    hash: '#/platform/integrations',
    role: 'admin',
    ready: (page) => page.getByTestId('platform-integrations-page'),
  },
  {
    id: 'platform-modules',
    labelZh: '平台 · 模块',
    hash: '#/platform/modules',
    role: 'admin',
    ready: (page) => page.getByTestId('platform-modules-page'),
  },
  {
    id: 'platform-models',
    labelZh: '平台 · 模型与供应商',
    hash: '#/platform/models',
    role: 'admin',
    ready: (page) => page.getByTestId('platform-models-page'),
  },
  {
    id: 'platform-settings',
    labelZh: '平台 · 平台设置',
    hash: '#/platform/settings',
    role: 'admin',
    ready: (page) => heading(page, '平台设置 Platform settings'), // PlatformSettingsPage.tsx
  },
  {
    id: 'platform-runtime',
    labelZh: '平台 · 运行层',
    hash: '#/platform/runtime',
    role: 'admin',
    ready: (page) => page.getByTestId('platform-runtime-page'),
  },
  {
    id: 'platform-status',
    labelZh: '平台 · 运行状态',
    hash: '#/platform/status',
    role: 'admin',
    ready: (page) => page.getByTestId('platform-status-page'),
  },
  {
    id: 'platform-audit',
    labelZh: '平台 · 平台审计',
    hash: '#/platform/audit',
    role: 'admin',
    ready: (page) => heading(page, '平台审计 Platform audit'), // PlatformAuditPage.tsx
  },
];

/** Signs in for `surface.role` and navigates to it, waiting for its ready signal — the one place
 *  every gate test's "get to this surface" step lives. Does not itself freeze the clock/settle
 *  motion (screenshot.spec.ts and content.spec.ts want that at slightly different points relative
 *  to login), so callers call `freezeClock` before this and `settleForCapture` after — the default
 *  export below (`visitSurface`) does both, for callers (`content.spec.ts`) that don't need the
 *  gap.
 */
export async function goToSurface(page: Page, surface: Surface): Promise<void> {
  if (surface.role === 'none') {
    // The login surface itself: a bare, unauthenticated `/` — `reachLoginForm` polls for the form
    // rather than a single `toBeVisible` (see its own doc comment in auth-helpers.ts).
    await page.goto('/');
    const state = await reachLoginForm(page);
    if (state !== 'login') {
      throw new Error(
        'expected the login surface to reach the login form, not an already-signed-in shell',
      );
    }
    return;
  }
  if (surface.role === 'admin') {
    await loginAsAdmin(page);
  } else {
    await loginAsOwner(page);
  }
  if (surface.hash !== null) {
    await page.goto(`/${surface.hash}`);
  }
  await expect(surface.ready(page)).toBeVisible({ timeout: 20_000 });
  // Skeleton lists (`components/ui/Skeleton.tsx` `SkeletonRows`, `.skeleton-rows`) render before
  // real data arrives — every list page uses the same component, so waiting for it to be gone is a
  // generic "the data actually loaded" signal on top of the surface-specific heading above.
  await expect(page.locator('.skeleton-rows')).toHaveCount(0, { timeout: 15_000 });
}

/** Login + navigate + wait ready + settle fonts/motion — content.spec.ts's one-call entry point
 *  (it never needs the clock frozen before login the way a screenshot does, since it never
 *  captures pixels). */
export async function visitSurface(page: Page, surface: Surface): Promise<void> {
  await goToSurface(page, surface);
  await settleForCapture(page);
}
