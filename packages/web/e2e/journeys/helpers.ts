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
 * ≤1100px (`styles/shell.css`'s icon-rail breakpoint — 768px, the F4 narrow-screen state every
 * journey is supposed to cover, falls inside it) `.nav-label` is `display: none`, and the first
 * baseline-generation CI run showed the link's accessible name does not reliably fall back to its
 * `title` attribute in that state — `getByRole('link', {name: …})` timed out waiting for a click
 * target that was in fact on screen (an icon-only rail item), full stop. `data-testid` is a DOM
 * attribute, unaffected by what CSS hides — the fix, not a workaround, and it's F4's actual intent
 * either way: "navigate by what the Sidebar item *is*", not by a hash route.
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

/** Clicks the nav item and waits for the resulting page's own `<h1>` (every page uses
 *  `components/ui/PageHeader.tsx`, one per page) to carry the same label — the generic "did the
 *  click actually navigate" signal every journey step needs without each one restating it.
 *  `level: 1` (not just a `RegExp` name match): some pages nest a second heading whose text also
 *  contains `labelZh` as a substring (e.g. AuditPage's own `<h1>审计 Audit</h1>` plus a nested
 *  `<h2>审计流 Audit log</h2>`) — restricting to `<h1>` is what every page's single PageHeader
 *  actually guarantees, a plain substring match on "heading, any level" does not. */
export async function goToByLabel(page: Page, labelZh: string): Promise<void> {
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
