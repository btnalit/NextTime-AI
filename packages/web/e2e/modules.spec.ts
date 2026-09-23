import { type Page, expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/modules.spec.ts: the P-B2b acceptance flow (docs/development-tasks.md §5d S7-D; design
 * §9 P-B e2e "模块页把 ops-assets v2 装进第二个工作区") — the platform 模块 page lists the
 * checked-in `ops-assets` module, an administrator creates a second workspace (owned by
 * themselves — this file needs no separate owner login, unlike `workspaces.spec.ts`'s P-A2
 * delegation flow, which this one does not re-test), and installs `ops-assets` into it from the
 * workspace's own 能力目录 模块 tab: not installed → v2 (the family's latest indexed version, one
 * click — `install_module` always targets the latest directly, never v1 first); the platform 模块
 * page's own "installed in n workspaces" count reflects it afterward.
 *
 * Both scenarios run as **one** `test()` (not split further): Playwright gives every `test()` a
 * fresh browser context (no persisted cookies, no persisted `session.memberships` client state)
 * — `workspaces.spec.ts`'s own serial group re-authenticates at the top of *each* of its tests for
 * exactly this reason. This file's own steps 2–4 depend on the "just switched into workspace B"
 * client session state, which is materially more awkward to re-derive per test than to keep in one
 * continuous session — see that file's doc comment for the alternative this one deliberately does
 * not take.
 *
 * Requires `WEB_E2E_BASE_URL`, `WEB_E2E_ADMIN_LOGIN`/`WEB_E2E_ADMIN_INITIAL_PASSWORD` — the same
 * pre-created platform administrator `workspaces.spec.ts`/`integrations.spec.ts` use.
 */

const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';

/** Same shape as `integrations.spec.ts`'s own copy (see that file's doc comment for why this is
 *  a per-file copy, not a shared helper): tolerates both password states the admin account can be
 *  in across a serial run of every e2e spec file. */
async function signInAsAdmin(page: Page): Promise<void> {
  const login = ADMIN_LOGIN as string;
  const initialPassword = ADMIN_INITIAL_PASSWORD as string;
  const changedPassword = `${initialPassword}-changed`;

  const changePasswordHeading = page.getByRole('heading', { name: /Password change required/ });
  const shell = page.getByTestId('nav-platformWorkspaces');
  const badCredentials = page.getByText(BAD_CREDENTIALS_MESSAGE);

  await page.goto('/');
  await reachLoginForm(page);
  await loginWithPassword(page, login, initialPassword);
  await expect(changePasswordHeading.or(shell).or(badCredentials).first()).toBeVisible({
    timeout: 15_000,
  });

  if (await badCredentials.isVisible().catch(() => false)) {
    await page.getByLabel(/密码 Password/).fill(changedPassword);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(changePasswordHeading.or(shell).first()).toBeVisible({ timeout: 15_000 });
  }

  if (await changePasswordHeading.isVisible().catch(() => false)) {
    await page.getByLabel(/当前密码 Current password/).fill(initialPassword);
    await page.getByLabel(/新密码 New password/).fill(changedPassword);
    await page.getByLabel(/确认新密码 Confirm new password/).fill(changedPassword);
    await page.getByRole('button', { name: /Change password/ }).click();
  }

  await expect(shell).toBeVisible({ timeout: 15_000 });
}

test.describe('P-B2b acceptance: platform modules page, install ops-assets into a second workspace', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD to run this suite (see README.md)',
  );

  test('platform modules page lists ops-assets with its two versions', async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByTestId('nav-platformModules').click();
    await expect(page.getByTestId('platform-modules-page')).toBeVisible({ timeout: 15_000 });
    const row = page.getByTestId('module-row-ops-assets');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('v2');

    await row.getByTestId('module-expand-ops-assets').click();
    const versions = page.getByTestId('module-versions-ops-assets');
    await expect(versions).toBeVisible();
    await expect(versions).toContainText('v1');
    await expect(versions).toContainText('v2');
  });

  test('create a second workspace, switch into it, and install ops-assets (lands on v2, its latest)', async ({
    page,
  }) => {
    test.slow();
    await signInAsAdmin(page);
    const workspaceName = `modules-e2e-${Date.now().toString(36)}`;

    // --- baseline: ops-assets' current "installed in n workspaces" count -------------------
    await page.getByTestId('nav-platformModules').click();
    await expect(page.getByTestId('platform-modules-page')).toBeVisible({ timeout: 15_000 });
    const modulesRow = page.getByTestId('module-row-ops-assets');
    await expect(modulesRow).toBeVisible({ timeout: 15_000 });
    const baselineText = await modulesRow.locator('td').nth(2).textContent();
    const baselineInstalledCount = Number(baselineText?.trim() ?? '0');
    expect(Number.isNaN(baselineInstalledCount)).toBe(false);

    // --- create workspace B, owned by admin itself ------------------------------------------
    await page.getByTestId('nav-platformWorkspaces').click();
    await expect(page.getByTestId('platform-workspaces-page')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('new-workspace').click();
    const createDrawer = page.getByTestId('create-workspace-drawer');
    await expect(createDrawer.getByTestId('create-workspace-form')).toBeVisible();
    await createDrawer.locator('#cw-name').fill(workspaceName);

    await createDrawer.locator('#cw-owner-query').fill(ADMIN_LOGIN as string);
    await createDrawer.getByRole('button', { name: /搜索 Search/ }).click();
    const ownerSelect = createDrawer.getByTestId('create-workspace-owner');
    await expect(ownerSelect).toBeEnabled();
    const ownerOption = ownerSelect.locator('option', { hasText: ADMIN_LOGIN as string });
    await expect(ownerOption).toHaveCount(1);
    const ownerUserId = await ownerOption.getAttribute('value');
    expect(ownerUserId ?? '').not.toBe('');
    await ownerSelect.selectOption(ownerUserId as string);

    await createDrawer.getByRole('button', { name: /创建 Create/ }).click();
    await expect(createDrawer).toBeHidden({ timeout: 20_000 });

    const drawer = page.getByTestId('workspace-drawer');
    await expect(drawer.getByTestId('workspace-detail')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // `session.memberships` was fetched at sign-in, before this workspace existed — reload so
    // `GET /api/auth/me` refreshes it and `onOpenWorkspaceConfig` (gated on membership,
    // `PlatformWorkspacesPage`'s own `memberOf`) is offered for the workspace just created.
    await page.goto('/');
    await expect(page.getByTestId('nav-platformWorkspaces')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('nav-platformWorkspaces').click();
    await expect(page.getByTestId('platform-workspaces-page')).toBeVisible({ timeout: 15_000 });

    const wsRow = page
      .getByTestId('platform-workspaces-table')
      .locator('tbody tr')
      .filter({ hasText: workspaceName });
    await wsRow.click();
    const detailDrawer = page.getByTestId('workspace-drawer');
    await expect(detailDrawer.getByTestId('workspace-detail')).toBeVisible({ timeout: 15_000 });
    await detailDrawer.getByTestId('open-workspace-config').click();
    await expect(page.getByTestId('nav-catalog')).toBeVisible({ timeout: 15_000 });

    // --- workspace catalog 模块 tab: not installed → v2 (the latest, one click) --------------
    // `install_module` always targets a module's own **latest** indexed version directly (one
    // publish, never stepping through v1 first) — see `application/platform/modules.ts`'s own
    // module doc comment. ops-assets' two versions are both non-breaking, so a fresh install needs
    // no confirm either way.
    //
    // Sidebar click + tab click (both client-side hash navigation, `lib/router.ts`'s `navigate`)
    // — never `page.goto` here: a full reload re-mounts the session from `GET /api/auth/me`,
    // which re-derives `selectedWorkspaceId` and would drop back out of workspace B (admin now
    // has 2+ memberships, so the "auto-select the only one" rule this file's own comment on
    // `signInAsAdmin` relies on no longer applies once B exists).
    await page.getByTestId('nav-catalog').click();
    await page.getByRole('tab', { name: 'Modules' }).click();
    const catalogTable = page.getByTestId('catalog-modules-table');
    await expect(catalogTable).toBeVisible({ timeout: 15_000 });

    const catalogRow = page.getByTestId('catalog-module-row-ops-assets');
    await expect(catalogRow).toBeVisible({ timeout: 15_000 });
    await expect(catalogRow).toContainText('未安装 Not installed');

    await catalogRow.getByTestId('catalog-module-action-ops-assets').click();
    await expect(catalogRow).toContainText('已是最新 Up to date', { timeout: 15_000 });
    await expect(catalogRow.locator('td').nth(2)).toHaveText('v2');

    // --- back on the platform 模块 page: installed-in count went up by one -----------------
    await page.getByTestId('nav-platformModules').click();
    const finalRow = page.getByTestId('module-row-ops-assets');
    await expect(finalRow).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const text = await finalRow.locator('td').nth(2).textContent();
          return Number(text?.trim() ?? '0');
        },
        { timeout: 15_000 },
      )
      .toBe(baselineInstalledCount + 1);
  });
});
