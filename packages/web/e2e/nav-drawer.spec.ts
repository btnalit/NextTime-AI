import { expect, test } from '@playwright/test';
import {
  createFreshWorkspace,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './journeys/helpers.js';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from './lib/auth.js';

/**
 * e2e/nav-drawer.spec.ts (legacies 596 and 610, UX acceptance of #924): a person in a trial
 * workspace can see that they are in one at every width, and at a phone's width the navigation
 * drawer is a working navigation — labelled items, the workspace block and its switcher — not the
 * icon rail the ≤1100px rules once made it (they were not scoped to the wide sidebar).
 *
 * A fresh owner of a fresh trial workspace also belongs to the platform default workspace
 * (`selectOwnedWorkspace`'s own doc comment), so the switcher renders with two memberships: the
 * trial one and a standard one. Layout is asserted, not screenshotted: the drawer and the caption
 * fit their width (`scrollWidth <= clientWidth`), which is what the screenshot gate cannot see —
 * its baselines have no trial workspace and never open the drawer.
 */

test.describe('legacies 596 / 610: a trial workspace marked, and the drawer at 390px', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('the sidebar caption fits in English, the top bar says trial, the drawer is labelled and switches', async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const { workspaceName, ownerLogin, ownerTemporaryPassword } = await createFreshWorkspace(page, {
      purpose: 'admin_trial',
    });
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);

    // --- 1440: the caption 「工作区 · 试验 · 所有者」, and in English it stays inside its card ----
    const sidebar = page.locator('aside.sidebar');
    await expect(sidebar.getByTestId('sidebar-workspace-trial')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('lang-switch-en').click();
    const caption = sidebar.locator('.sidebar-workspace-caption');
    await expect(caption).toContainText('Owner');
    // Wider than the card in English (UX on #924: 200px of content, 177px of card); it wraps.
    expect(await caption.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(
      await caption.evaluate((el) => {
        const right = el.getBoundingClientRect().right + 0.5;
        return [...el.children].every((child) => child.getBoundingClientRect().right <= right);
      }),
    ).toBe(true);
    await page.getByTestId('lang-switch-zh').click();
    await expect(caption).toContainText('所有者');

    // --- 390: the top bar names the trial workspace; nothing scrolls sideways -----------------
    await page.setViewportSize({ width: 390, height: 844 });
    const topBarIdentity = page.locator('.mobile-topbar-sub');
    await expect(topBarIdentity).toContainText(`${workspaceName}（试验）`);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // --- 390: the drawer is labelled and carries the workspace block and its switcher ---------
    await page.getByTestId('nav-open').click();
    const drawer = page.locator('.nav-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('nav-chats').locator('.nav-label')).toBeVisible();
    await expect(drawer.getByTestId('nav-chats')).toContainText('对话');
    await expect(drawer.getByTestId('nav-section-use')).toBeVisible();
    await expect(drawer.getByTestId('sidebar-workspace-trial')).toBeVisible();
    await expect(drawer.getByTestId('sign-out')).toBeVisible();
    const switcher = drawer.getByTestId('workspace-switcher');
    await expect(switcher).toBeVisible();
    await expect(switcher.locator('option', { hasText: `${workspaceName}（试验）` })).toHaveCount(
      1,
    );
    expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // --- 390: switching from the drawer works — to the standard membership and back ------------
    const standard = switcher.locator('option', { hasNotText: '（试验）' });
    await expect(standard).toHaveCount(1);
    const standardId = (await standard.getAttribute('value')) ?? '';
    expect(standardId).not.toBe('');
    await switcher.selectOption(standardId);
    await expect(topBarIdentity).not.toContainText('（试验）', { timeout: 15_000 });
    // The switch lands on 对话; whether that closed the drawer depends on the page it started on,
    // so close it (a no-op when already shut) and open it again to read the switcher afresh.
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await page.getByTestId('nav-open').click();
    await expect(drawer.getByTestId('workspace-switcher')).toHaveValue(standardId, {
      timeout: 15_000,
    });
    await expect(drawer.getByTestId('workspace-switcher')).toBeEnabled();
    await expect(drawer.getByTestId('sidebar-workspace-trial')).toHaveCount(0);
  });
});
