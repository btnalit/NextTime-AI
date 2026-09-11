import { expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/login.spec.ts: the P-A1 acceptance flow (docs/platform-admin-design.md §4/§5) — admin first
 * login (forced password change → lands on the platform overview) → owner password login →
 * temporary-password forced change → account lockout. Opt-in only, same convention as every other
 * spec in this directory.
 *
 * `.github/workflows/e2e.yml` runs every spec alphabetically in one `playwright test` invocation
 * (`workers: 1`), so this file runs *last* — `approvals`/`chat`/`explorer`/`governance` all run
 * first, against a platform whose `admin` user already exists (the kernel pre-creates it on
 * startup, docs/platform-admin-design.md §4) but none of those specs ever logs in as `admin`.
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_ADMIN_LOGIN`/`WEB_E2E_ADMIN_INITIAL_PASSWORD` (the
 * pre-created platform administrator's random temporary password, read from
 * `${NEXTTIME_DATA}/secrets/setup/initial-admin-password` before any bootstrap step runs — see
 * docs/runbooks/web-console.md's "CI（Playwright）" section), `WEB_E2E_OWNER_LOGIN`/
 * `WEB_E2E_OWNER_PASSWORD` (a workspace owner with a permanent console password) and
 * `WEB_E2E_TEMP_LOGIN`/`WEB_E2E_TEMP_PASSWORD` (a second principal with a temporary one, i.e.
 * `must_change_password`) — both set up by `bootstrap.js set-password` in CI, see that workflow's
 * "Set console passwords" step.
 *
 * Test order within this file matters and is NOT alphabetical — Playwright runs a file's own
 * tests in declaration order. "5 wrong passwords lock the account" is declared last on purpose:
 * it locks the `admin` account itself for 5 minutes, and nothing else in this suite (this file's
 * own earlier tests included, all idempotent for a CI retry) or after it needs `admin` again.
 */

const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;
const OWNER_LOGIN = process.env.WEB_E2E_OWNER_LOGIN;
const OWNER_PASSWORD = process.env.WEB_E2E_OWNER_PASSWORD;
const TEMP_LOGIN = process.env.WEB_E2E_TEMP_LOGIN;
const TEMP_PASSWORD = process.env.WEB_E2E_TEMP_PASSWORD;

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';
const LOCKED_MESSAGE = '尝试次数过多，请几分钟后再试';

test.describe('P-A1 acceptance: admin first login, password login, forced change, lockout', () => {
  test.skip(
    !ADMIN_LOGIN ||
      !ADMIN_INITIAL_PASSWORD ||
      !OWNER_LOGIN ||
      !OWNER_PASSWORD ||
      !TEMP_LOGIN ||
      !TEMP_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_ADMIN_LOGIN/ADMIN_INITIAL_PASSWORD, WEB_E2E_OWNER_LOGIN/PASSWORD and WEB_E2E_TEMP_LOGIN/PASSWORD to run this suite (see README.md)',
  );

  test('admin: first login -> forced change -> platform overview -> open Users -> sign out (idempotent for CI retry)', async ({
    page,
  }) => {
    const adminLogin = ADMIN_LOGIN as string;
    const initialPassword = ADMIN_INITIAL_PASSWORD as string;
    const changedPassword = `${initialPassword}-changed`;

    const changePasswordHeading = page.getByRole('heading', { name: /Password change required/ });
    const overviewHeading = page.getByRole('heading', { name: '概览 Overview', exact: true });
    const platformOverviewNav = page.getByTestId('nav-platformOverview');
    const badCredentials = page.getByText(BAD_CREDENTIALS_MESSAGE);

    // `.first()` on every `.or()` chain below: `overviewHeading` (the page `<h1>`) and
    // `platformOverviewNav` (the sidebar item) are designed to be on screen *together* once the
    // admin is past the change-password screen — a bare `expect(a.or(b)).toBeVisible()` would hit
    // Playwright's strict-mode "resolved to 2 elements" error the instant both match, unlike
    // `changePasswordHeading`/`wsStatus` elsewhere in this file, which never co-occur.
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithPassword(page, adminLogin, initialPassword);
    await expect(
      changePasswordHeading.or(overviewHeading).or(platformOverviewNav).or(badCredentials).first(),
    ).toBeVisible({ timeout: 15_000 });

    if (await badCredentials.isVisible().catch(() => false)) {
      // A previous (retried) run already changed the password away from the initial one — try
      // the deterministic changed password instead.
      await page.getByLabel(/密码 Password/).fill(changedPassword);
      await page.getByRole('button', { name: 'Log in' }).click();
      await expect(
        changePasswordHeading.or(overviewHeading).or(platformOverviewNav).first(),
      ).toBeVisible({ timeout: 15_000 });
    }

    if (await changePasswordHeading.isVisible().catch(() => false)) {
      await page.getByLabel(/当前密码 Current password/).fill(initialPassword);
      await page.getByLabel(/新密码 New password/).fill(changedPassword);
      await page.getByLabel(/确认新密码 Confirm new password/).fill(changedPassword);
      await page.getByRole('button', { name: /Change password/ }).click();
    }

    await expect(overviewHeading.or(platformOverviewNav).first()).toBeVisible({
      timeout: 15_000,
    });
    if (!(await overviewHeading.isVisible().catch(() => false))) {
      await platformOverviewNav.click();
      await expect(overviewHeading).toBeVisible({ timeout: 15_000 });
    }

    await page.getByTestId('nav-platformUsers').click();
    await expect(page.getByRole('heading', { name: '用户 Users', exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: /登出 Sign out/ }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  });

  test('owner: password login -> shell -> sign out -> GET /api/auth/me is 401', async ({
    page,
  }) => {
    const ownerLogin = OWNER_LOGIN as string;
    const ownerPassword = OWNER_PASSWORD as string;

    await page.goto('/');
    await reachLoginForm(page);
    await loginWithPassword(page, ownerLogin, ownerPassword);
    await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();

    await page.getByRole('button', { name: /登出 Sign out/ }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

    const res = await page.request.get('/api/auth/me');
    expect(res.status()).toBe(401);
  });

  test('temporary password: forced change -> shell -> sign out -> log in with the new password -> shell', async ({
    page,
  }) => {
    const tempLogin = TEMP_LOGIN as string;
    const oldPassword = TEMP_PASSWORD as string;
    const newPassword = `${oldPassword}-changed`;

    const wsStatus = page.getByTestId('ws-status');
    const changePasswordHeading = page.getByRole('heading', { name: /Password change required/ });
    const badCredentials = page.getByText(BAD_CREDENTIALS_MESSAGE);

    await page.goto('/');
    await reachLoginForm(page);
    await loginWithPassword(page, tempLogin, oldPassword);
    await expect(changePasswordHeading.or(wsStatus).or(badCredentials)).toBeVisible({
      timeout: 15_000,
    });

    if (await badCredentials.isVisible().catch(() => false)) {
      // A previous (retried) run already changed the password away from the original temporary
      // one — try the deterministic new one instead.
      await page.getByLabel(/密码 Password/).fill(newPassword);
      await page.getByRole('button', { name: 'Log in' }).click();
      await expect(changePasswordHeading.or(wsStatus)).toBeVisible({ timeout: 15_000 });
    }

    if (await changePasswordHeading.isVisible().catch(() => false)) {
      // Wrong current password -> inline error, no state change.
      await page.getByLabel(/当前密码 Current password/).fill('definitely-wrong');
      await page.getByLabel(/新密码 New password/).fill(newPassword);
      await page.getByLabel(/确认新密码 Confirm new password/).fill(newPassword);
      await page.getByRole('button', { name: /Change password/ }).click();
      await expect(page.getByText('当前密码不正确')).toBeVisible();

      await page.getByLabel(/当前密码 Current password/).fill(oldPassword);
      await page.getByRole('button', { name: /Change password/ }).click();
    }
    await expect(wsStatus).toHaveText('Connected', { timeout: 15_000 });

    await page.getByRole('button', { name: /登出 Sign out/ }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

    // Sign in again with the NEW password.
    await reachLoginForm(page);
    await loginWithPassword(page, tempLogin, newPassword);
    await expect(wsStatus).toHaveText('Connected', { timeout: 15_000 });
  });

  test('5 wrong passwords lock the admin account; a 6th, correct attempt still shows the lock message', async ({
    page,
  }) => {
    const adminLogin = ADMIN_LOGIN as string;
    const initialPassword = ADMIN_INITIAL_PASSWORD as string;
    const changedPassword = `${initialPassword}-changed`;

    await page.goto('/');
    await reachLoginForm(page);

    for (let attempt = 0; attempt < 5; attempt++) {
      await page.getByLabel(/登录名 Login/).fill(adminLogin);
      await page.getByLabel(/密码 Password/).fill('definitely-the-wrong-password');
      await page.getByRole('button', { name: 'Log in' }).click();
      // Tolerant of an already-locked account (a retried run of this same test) — either message
      // is a valid "that attempt did not succeed" outcome.
      await expect(
        page.getByText(new RegExp(`${BAD_CREDENTIALS_MESSAGE}|${LOCKED_MESSAGE}`)),
      ).toBeVisible();
    }

    // The correct, current password by this point in the run is the changed one (the first test
    // above always changes it away from the initial temporary password) — either is accepted as
    // "the real password" here since only the lock message matters for this assertion.
    await page.getByLabel(/登录名 Login/).fill(adminLogin);
    await page.getByLabel(/密码 Password/).fill(changedPassword);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByText(LOCKED_MESSAGE)).toBeVisible();
  });
});
