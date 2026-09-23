import type { BreadcrumbItem } from '../components/kit/page-header.js';
import type { NavSection } from './router.js';
import { hrefs } from './router.js';

export interface NavItem {
  readonly section: NavSection;
  readonly label: string;
  readonly sub: string;
  /** components/ui/Icon's `IconName` union, kept as a plain string here so this file — the single
   *  source of nav data `breadcrumbFor` also reads from — never imports `components/ui/*` itself
   *  (`scripts/guards/legacy-ui-importers.json` only shrinks, S8 §5e risk ①). Sidebar.tsx, already
   *  on that allowlist, casts back to `IconName` at the one place it renders `<Icon>`. */
  readonly icon: string;
  readonly href: string;
}

/** A nav entry that opens outside the console's own hash-routed shell — no `section` (it never
 *  matches `NavSection`/`aria-current`), always `target="_blank"`. Rendered separately from
 *  `NavItem`s rather than folding it into `NavSection` (`lib/router.ts`), which is one-to-one with
 *  an internal hash route. */
export interface ExternalNavItem {
  readonly testId: string;
  readonly label: string;
  readonly sub: string;
  readonly icon: string;
  readonly href: string;
}

export type NavGroupId = 'use' | 'govern' | 'platform';

export interface NavGroup {
  readonly id: NavGroupId;
  readonly titleZh: string;
  readonly titleEn: string;
  readonly items: readonly NavItem[];
}

/** Explorer（第三方）— the read-only graph/decision/provenance UI (kernel `interfaces/explorer-
 *  contract`), an unmodified third-party static bundle served by caddy at `/explorer/` on this
 *  same origin. Opens in a new tab; same visibility as the 治理 group (`showGovern`) since
 *  every Explorer endpoint requires at least the same role. S6-C / S6-D: the console's own 图谱
 *  page (`WORK_NAV`) is the primary graph entry; this link is rendered only while the bundle is
 *  built (`explorerAvailable !== false`, `lib/explorer-probe.ts`). */
export const EXPLORER_NAV: ExternalNavItem = {
  testId: 'nav-explorer',
  label: '打开 Explorer',
  sub: 'third-party',
  icon: 'search',
  href: '/explorer/',
};

/** 使用 Use (design doc §2/§5 "使用面") — always visible, every role. 我的智能体 (S3.13 placeholder)
 *  sits here rather than in a separate section: it is per-user configuration, not governance. */
export const WORK_NAV: readonly NavItem[] = [
  { section: 'chats', label: '对话', sub: 'Chats', icon: 'chat', href: hrefs.chats() },
  {
    section: 'approvals',
    label: '待我审批',
    sub: 'Approvals',
    icon: 'approvals',
    href: hrefs.approvals(),
  },
  { section: 'tasks', label: '任务', sub: 'Tasks', icon: 'tasks', href: hrefs.tasks() },
  // S6-D: the native 图谱 page (object browser on search / state_at / explain) replaces the
  // third-party Explorer bundle as the console's graph entry.
  { section: 'graph', label: '图谱', sub: 'Graph', icon: 'link', href: hrefs.graph() },
  { section: 'agent', label: '我的智能体', sub: 'My Agent', icon: 'bot', href: hrefs.agent() },
  // S4.1: sits right next to 我的智能体 — both are per-user "我的" settings, not governance.
  { section: 'account', label: '我的账户', sub: 'My Account', icon: 'user', href: hrefs.account() },
];

/** 治理 Govern (S6-A0 §5.9 "壳与导航": 使用 / 治理 / 平台) — the per-workspace owner/operator pages,
 *  hidden for a *proven* member (S3.11: "member 只见工作区 + 「我的智能体」"), shown otherwise
 *  (owner/operator, or role not yet known this session — see `lib/role.ts` and the runbook's
 *  "角色与可见性": show governance nav to everyone and let the kernel's 403 render as an inline
 *  state — never invent a capability) and only once a workspace is in scope (`showGovern` — an
 *  apiKey session always has one implicitly; a cookie session needs `selectedWorkspaceId`, since a
 *  platform admin with zero memberships has nothing here to configure). */
export const GOVERN_NAV: readonly NavItem[] = [
  { section: 'members', label: '成员与授权', sub: 'Members', icon: 'users', href: hrefs.members() },
  { section: 'access', label: '访问', sub: 'Access', icon: 'key', href: hrefs.access() },
  {
    section: 'systems',
    label: '系统接入',
    sub: 'Systems',
    icon: 'connections',
    href: hrefs.systems(),
  },
  { section: 'catalog', label: '能力目录', sub: 'Catalog', icon: 'inbox', href: hrefs.catalog() },
  { section: 'models', label: '模型与配额', sub: 'Models', icon: 'sparkle', href: hrefs.models() },
  { section: 'audit', label: '审计', sub: 'Audit', icon: 'clock', href: hrefs.audit() },
];

/** 平台 Platform (S6-A0 §5.9) — platform-admin only (`platformRole === 'admin'`), independent of
 *  workspace role/selection: an administrator configures workspaces they are not a member of,
 *  manages users and platform settings with zero memberships. Overview first (the control tower
 *  of §5.9 "页面对照原型"), then the four management pages, then the platform audit stream —
 *  the former 管理 → 工作区配置 / 用户 / 平台设置 和 维护 groups folded into one labelled group. */
export const PLATFORM_NAV: readonly NavItem[] = [
  {
    section: 'platformOverview',
    label: '概览',
    sub: 'Overview',
    icon: 'info',
    href: hrefs.platformOverview(),
  },
  {
    section: 'platformWorkspaces',
    label: '工作区',
    sub: 'Workspaces',
    icon: 'grid',
    href: hrefs.platformWorkspaces(),
  },
  {
    section: 'platformUsers',
    label: '用户',
    sub: 'Users',
    icon: 'badge',
    href: hrefs.platformUsers(),
  },
  {
    section: 'platformIntegrations',
    label: '集成',
    sub: 'Integrations',
    icon: 'send',
    href: hrefs.platformIntegrations(),
  },
  // P-B2b (design §6.4): modules — versioned domain packs, install counts, default modules.
  {
    section: 'platformModules',
    label: '模块',
    sub: 'Modules',
    icon: 'box',
    href: hrefs.platformModules(),
  },
  // S6-B (design §6.2): providers are platform-level; the page talks to llm-proxy's admin API.
  {
    section: 'platformModels',
    label: '模型与供应商',
    sub: 'Models & providers',
    icon: 'refresh',
    href: hrefs.platformModels(),
  },
  {
    section: 'platformSettings',
    label: '平台设置',
    sub: 'Platform settings',
    icon: 'settings',
    href: hrefs.platformSettings(),
  },
  // S7-E (design §6.5 / §6.7, P-C): 运行层 / 运行状态 — which pi/image/extension version is
  // running and whether every service is healthy.
  {
    section: 'platformRuntime',
    label: '运行层',
    sub: 'Runtime',
    icon: 'cpu',
    href: hrefs.platformRuntime(),
  },
  {
    section: 'platformStatus',
    label: '运行状态',
    sub: 'Status',
    icon: 'shield',
    href: hrefs.platformStatus(),
  },
  {
    section: 'platformAudit',
    label: '平台审计',
    sub: 'Platform audit',
    icon: 'copy',
    href: hrefs.platformAudit(),
  },
];

/** lib/nav: the single place that names every nav group and page (S8 W1-A1, docs/development-
 *  tasks.md §5e "W1 拆分" — "面包屑与分组命名 S12"). `components/shell/Sidebar` renders these three
 *  groups; `breadcrumbFor` below is every kit `PageHeader`'s breadcrumb source — the same
 *  `NavItem.label` the Sidebar shows for that section, so a page's breadcrumb can never drift from
 *  the Sidebar's own wording the way ad hoc per-page breadcrumb strings did before this lane
 *  (three spellings of the same group coexisted: "工作/使用 Work/USE", "治理 Govern/Governance/
 *  GOVERN"). */
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'use', titleZh: '使用', titleEn: 'Use', items: WORK_NAV },
  { id: 'govern', titleZh: '治理', titleEn: 'Govern', items: GOVERN_NAV },
  { id: 'platform', titleZh: '平台', titleEn: 'Platform', items: PLATFORM_NAV },
];

/** Every kit `PageHeader`'s breadcrumb: `[{group}, {page}]`, read from `NAV_GROUPS` above. The
 *  group crumb has no `href` — none of the three groups has a landing page of its own to link to
 *  — and renders as plain text (`kit/page-header.tsx`'s own rule: no `href` = plain text). Chinese
 *  only, no "中文 English" pairing: F5 (docs/development-tasks.md §5e) makes the console Chinese-
 *  first for now (English moves into a later language-switch lane, not built here), and audit S4
 *  found that exact pairing was the main cause of header text wrapping at 1280/768 — pairing it
 *  back in here would reintroduce the same failure this lane's `PageHeader` layout fix addresses.
 *  Returns `[]` for a section with no nav entry (routes that are drawers over another page's own
 *  route, e.g. `chat`'s `chatId` detail — `router.ts`'s `sectionOf` already collapses that onto
 *  `chats` before anything would call this with a value that isn't in `NAV_GROUPS`). */
export function breadcrumbFor(section: NavSection): readonly BreadcrumbItem[] {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((candidate) => candidate.section === section);
    if (item !== undefined) {
      return [{ label: group.titleZh }, { label: item.label }];
    }
  }
  return [];
}
