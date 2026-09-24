import { type Page, expect } from '@playwright/test';
import { loginAsAdmin, loginAsOwner } from '../lib/auth.js';

/**
 * e2e/journeys/helpers.ts: shared plumbing for the six S8 F4 journey specs (`journeys/*.spec.ts`)
 * — login as the two roles a journey typically needs, and navigation by the Sidebar's own visible
 * label rather than a hard-coded `#/...` hash (F4's own instruction: a journey narrates what a
 * person clicks, not which route that happens to be — `lib/router.ts`'s hash shape is an
 * implementation detail a journey spec should survive a change to). See `journeys/README.md` for
 * how a journey is specified and what "host read-only smoke" will mean once one of these runs
 * against a real host.
 *
 * Deliberately plain `journeys/`, not directory-ordering-hacked: an earlier version of this file
 * prefixed the directory `01-` (right after `00-gates/`) specifically so it ran *before*
 * `chat.spec.ts` — `chat.spec.ts`'s own first test creates a Chat it never archives, which would
 * otherwise shadow `application/linkage/chat-targets.ts`'s "most recently created Chat" targeting
 * that the seeded ActionRequests actually linked into. That ordering hack traded one bug for
 * another: running *before* `approvals.spec.ts` too meant journey ③'s own approvals landed
 * "approved" status lines in the same Chat that `approvals.spec.ts`'s own (unscoped, `data-
 * status="approved"`) assertion expects to be the only one there. An even later version tried
 * searching the Chat list for the card instead of assuming "most recent" — that avoided both
 * ordering problems, but CI evidence (a committed database snapshot from a failing run) then
 * showed the deeper reason to stop chasing this entirely: a single ActionRequest's `system.
 * action_update` messages can land in more than one Chat across the approved→failed transition —
 * a kernel-side `resolveDefaultChat` behaviour, out of this lane's file scope
 * (`packages/kernel/**`) to change. `journeys/03-approve-action.spec.ts` now reads the decided
 * state from `ApprovalQueuePage`'s own 历史 History tab instead — the authoritative,
 * single-page source `list_action_requests` already is, sidestepping "which Chat" altogether.
 */

export const OWNER_API_KEY = process.env.WEB_E2E_API_KEY;
/** The fake stack's second principal (`.github/workflows/e2e.yml` "Add a second principal") is
 *  seeded as `operator`, not `member` — the closest role the CI stack actually creates. A journey
 *  that specifically needs a *member*-role principal (no operator/owner capability) has no fixture
 *  for that yet; note it in the journey's own header rather than silently substituting operator
 *  for member. */
export const SECOND_PRINCIPAL_API_KEY = process.env.WEB_E2E_API_KEY_B;

export async function asOwner(page: Page): Promise<void> {
  await loginAsOwner(page);
}

export async function asAdmin(page: Page): Promise<void> {
  await loginAsAdmin(page);
}

export async function asSecondPrincipal(page: Page): Promise<void> {
  await loginAsOwner(page, SECOND_PRINCIPAL_API_KEY as string);
}

/**
 * `NavSection` values (`lib/router.ts`) keyed by the Chinese label every journey spec calls
 * `goToByLabel` with — `Sidebar.tsx`'s own `data-testid={`nav-${item.section}`}` convention,
 * already how every *other* spec in this suite clicks a nav item (workspaces.spec.ts,
 * login.spec.ts, catalog.spec.ts, …), reused here rather than re-derived. Not every `NavSection`
 * needs an entry — only the ones a journey actually navigates to today.
 *
 * Why not click by the nav item's own accessible name (an earlier version of this file did): at
 * the (960px, 1100px] icon-rail width `.nav-label` is `display: none`, and the first
 * baseline-generation CI run showed the link's accessible name does not reliably fall back to its
 * `title` attribute in that state — `getByRole('link', {name: …})` timed out waiting for a click
 * target that was in fact on screen (an icon-only rail item), full stop. `data-testid` is a DOM
 * attribute, unaffected by what CSS hides — the fix, not a workaround, and it's F4's actual intent
 * either way: "navigate by what the Sidebar item *is*", not by a hash route.
 *
 * S8 W1-A3 follow-up (audit S2): 768px — the F4 narrow-screen state every journey is supposed to
 * cover — moved out of the icon rail entirely. `AppShell` no longer renders `Sidebar` at all at
 * ≤960px; `nav-<section>` only exists once `MobileTopBar`'s menu button (`nav-open`) has opened
 * `NavDrawer`. `goToByLabel` below opens it first whenever the current viewport is that narrow —
 * every single call, not just the first, since `AppShell` closes the drawer again on the
 * navigation this same function causes (an effect keyed on the active `NavSection`).
 */
const NAV_TESTID_BY_LABEL: Readonly<Record<string, string>> = {
  对话: 'chats',
  待我审批: 'approvals',
  任务: 'tasks',
  图谱: 'graph',
  我的智能体: 'agent',
  我的账户: 'account',
  成员与授权: 'members',
  访问: 'access',
  系统接入: 'systems',
  能力目录: 'catalog',
  模型与配额: 'models',
  审计: 'audit',
  概览: 'platformOverview',
  工作区: 'platformWorkspaces',
  用户: 'platformUsers',
  集成: 'platformIntegrations',
  模块: 'platformModules',
  模型与供应商: 'platformModels',
  平台设置: 'platformSettings',
  运行层: 'platformRuntime',
  运行状态: 'platformStatus',
  平台审计: 'platformAudit',
};

/** The Sidebar nav item labelled (in Chinese) `labelZh` — see `NAV_TESTID_BY_LABEL`'s doc comment
 *  for why this is `data-testid`-based rather than accessible-name-based. */
export function navItem(page: Page, labelZh: string) {
  const testId = NAV_TESTID_BY_LABEL[labelZh];
  if (testId === undefined) {
    throw new Error(
      `no NavSection mapped for "${labelZh}" — add it to NAV_TESTID_BY_LABEL in journeys/helpers.ts`,
    );
  }
  return page.getByTestId(`nav-${testId}`);
}

/** ≤960px (`components/shell/AppShell.tsx`'s own breakpoint) `Sidebar` is not in the DOM — open
 *  `NavDrawer` via `MobileTopBar`'s menu button (`nav-open`) first, so the `nav-<section>` item
 *  `navItem` looks for actually exists to click. A no-op above 960px (`nav-open` does not exist
 *  there, and is never queried). `page.viewportSize()` is synchronous/local — every journey spec
 *  sets the width once with `page.setViewportSize` before running, so this never races a resize. */
async function openNavDrawerIfNarrow(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport !== null && viewport.width > 960) return;
  await page.getByTestId('nav-open').click();
}

/** Clicks the nav item and waits for the resulting page's own `<h1>` (every page uses
 *  `components/ui/PageHeader.tsx`, one per page) to carry the same label — the generic "did the
 *  click actually navigate" signal every journey step needs without each one restating it.
 *  `level: 1` (not just a `RegExp` name match): some pages nest a second heading whose text also
 *  contains `labelZh` as a substring (e.g. AuditPage's own `<h1>审计 Audit</h1>` plus a nested
 *  `<h2>审计流 Audit log</h2>`) — restricting to `<h1>` is what every page's single PageHeader
 *  actually guarantees, a plain substring match on "heading, any level" does not. */
export async function goToByLabel(page: Page, labelZh: string): Promise<void> {
  await openNavDrawerIfNarrow(page);
  await navItem(page, labelZh).click();
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(labelZh) })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Admin creates a platform user (新建用户) and captures its one-time-shown temporary password —
 * the first half of `workspaces.spec.ts`'s P-A2 acceptance flow, factored out here because both
 * `createFreshWorkspace` below and `06-add-member.spec.ts` need exactly this step and nothing
 * about it differs between them. Assumes the caller is already signed in as admin and stays there
 * — does not itself navigate away afterwards.
 */
export async function createPlatformUser(
  page: Page,
  displayName: string,
): Promise<{ readonly login: string; readonly temporaryPassword: string }> {
  const login = `journey${Date.now().toString(36)}`;
  await goToByLabel(page, '用户');
  await page.getByRole('button', { name: /新建用户 Create user/ }).click();
  const userDrawer = page.getByTestId('create-user-drawer');
  await expect(userDrawer.getByTestId('create-user-form')).toBeVisible();
  await userDrawer.locator('#cu-login').fill(login);
  await userDrawer.locator('#cu-display-name').fill(displayName);
  await userDrawer.getByRole('button', { name: /创建 Create/ }).click();
  const password = page.getByTestId('temporary-password-value');
  await expect(password).toBeVisible({ timeout: 15_000 });
  const temporaryPassword = (await password.textContent())?.trim() ?? '';
  await page.getByRole('button', { name: /我已保存 I have saved it/ }).click();
  await expect(page.getByTestId('temporary-password-dialog')).toBeHidden();
  return { login, temporaryPassword };
}

/**
 * `fresh-workspace fixture` (F4's own wording) — admin creates a platform user (`createPlatformUser`
 * above), then a workspace owned by that user (the exact UI flow `workspaces.spec.ts`'s P-A2
 * acceptance already exercises end to end), returning the new owner's login/temporary password so
 * a journey can sign in as a genuinely empty workspace rather than the shared, ever-accumulating
 * `ci-e2e` one every other spec (and `00-gates/`) also touches. Slow (two drawer round-trips) —
 * only worth it for a journey whose success criteria specifically depend on an empty canvas.
 */
export async function createFreshWorkspace(page: Page): Promise<{
  readonly workspaceName: string;
  readonly ownerLogin: string;
  readonly ownerTemporaryPassword: string;
}> {
  const suffix = Date.now().toString(36);
  const workspaceName = `journey-${suffix}`;

  await asAdmin(page);
  const { login: ownerLogin, temporaryPassword: ownerTemporaryPassword } = await createPlatformUser(
    page,
    `Journey owner ${suffix}`,
  );

  await goToByLabel(page, '工作区');
  await page.getByTestId('new-workspace').click();
  const wsDrawer = page.getByTestId('create-workspace-drawer');
  await expect(wsDrawer.getByTestId('create-workspace-form')).toBeVisible();
  await wsDrawer.locator('#cw-name').fill(workspaceName);
  await wsDrawer.locator('#cw-owner-query').fill(ownerLogin);
  await wsDrawer.getByRole('button', { name: /搜索 Search/ }).click();
  const ownerSelect = wsDrawer.getByTestId('create-workspace-owner');
  await expect(ownerSelect).toBeEnabled();
  const ownerOption = ownerSelect.locator('option', { hasText: ownerLogin });
  await expect(ownerOption).toHaveCount(1);
  const ownerUserId = await ownerOption.getAttribute('value');
  await ownerSelect.selectOption(ownerUserId as string);
  await wsDrawer.getByRole('button', { name: /创建 Create/ }).click();
  await expect(wsDrawer).toBeHidden({ timeout: 20_000 });

  return { workspaceName, ownerLogin, ownerTemporaryPassword };
}
