import { expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/login.spec.ts: the S4.1 acceptance flow (design doc §7.11 "登录" and "初始化：一次性令牌") —
 * initialize the platform → password login → forced temporary-password change → account lockout.
 * Opt-in only, same convention as every other spec in this directory.
 *
 * `.github/workflows/e2e.yml` runs every spec alphabetically in one `playwright test` invocation
 * (`workers: 1`), so this file runs *last* — `approvals`/`chat`/`explorer`/`governance` all run
 * first, against a platform that is not yet initialized (see `e2e/auth-helpers.ts`'s own doc
 * comment on why every one of them needs the `SetupPage` → `LoginPage` escape hatch). Only this
 * file's own "initialize platform" test ever calls `POST /api/platform/setup`.
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_SETUP_TOKEN` (the one-time token minted at kernel start,
 * read from `${NEXTTIME_DATA}/secrets/setup/token` before any bootstrap step runs — see
 * docs/runbooks/web-console.md's "CI（Playwright）" section), `WEB_E2E_OWNER_LOGIN`/
 * `WEB_E2E_OWNER_PASSWORD` (a workspace owner with a permanent console password) and
 * `WEB_E2E_TEMP_LOGIN`/`WEB_E2E_TEMP_PASSWORD` (a second principal with a temporary one, i.e.
 * `must_change_password`) — both set up by `bootstrap.js set-password` in CI, see that workflow's
 * "Set console passwords" step.
 *
 * Test order within this file matters and is NOT alphabetical — Playwright runs a file's own
 * tests in declaration order. "5 wrong passwords lock the account" is declared last on purpose:
 * it locks the `e2e-admin` account this file's own first test creates for 5 minutes, and nothing
 * else in this suite uses that account afterward.
 */

const SETUP_TOKEN = process.env.WEB_E2E_SETUP_TOKEN;
const OWNER_LOGIN = process.env.WEB_E2E_OWNER_LOGIN;
const OWNER_PASSWORD = process.env.WEB_E2E_OWNER_PASSWORD;
const TEMP_LOGIN = process.env.WEB_E2E_TEMP_LOGIN;
const TEMP_PASSWORD = process.env.WEB_E2E_TEMP_PASSWORD;

/** Fully under this spec's own control (created by its first test) — no env var needed. */
const ADMIN_LOGIN = 'e2e-admin';
const ADMIN_PASSWORD = 'e2e-admin-password-1';

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';
const LOCKED_MESSAGE = '尝试次数过多，请几分钟后再试';

type Page = import('@playwright/test').Page;

/** Resolves whether a bare `goto('/')` landed on `SetupPage` (platform not yet initialized) or
 *  `LoginPage` — unlike `reachLoginForm` (e2e/auth-helpers.ts), this does NOT click past
 *  `SetupPage`: the "initialize platform" test needs to tell the two apart. */
async function waitForSetupOrLogin(page: Page): Promise<'setup' | 'login'> {
  const loginInstead = page.getByRole('button', { name: /Already have an account\? Log in/ });
  const passwordLoginButton = page.getByRole('button', { name: 'Log in' });
  await expect
    .poll(
      async () => {
        if (await loginInstead.isVisible().catch(() => false)) return 'setup';
        if (await passwordLoginButton.isVisible().catch(() => false)) return 'login';
        return 'pending';
      },
      { timeout: 15_000 },
    )
    .not.toBe('pending');
  return (await loginInstead.isVisible().catch(() => false)) ? 'setup' : 'login';
}

test.describe('S4.1 acceptance: platform setup, password login, forced change, lockout', () => {
  test.skip(
    !SETUP_TOKEN || !OWNER_LOGIN || !OWNER_PASSWORD || !TEMP_LOGIN || !TEMP_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_SETUP_TOKEN, WEB_E2E_OWNER_LOGIN/PASSWORD and WEB_E2E_TEMP_LOGIN/PASSWORD to run this suite (see README.md)',
  );

  test('initialize platform -> NoWorkspacePage -> sign out (idempotent for CI retry)', async ({
    page,
  }) => {
    const setupToken = SETUP_TOKEN as string; // guarded by test.skip above
    await page.goto('/');
    const state = await waitForSetupOrLogin(page);

    if (state === 'setup') {
      await page.getByLabel(/一次性令牌 Setup token/).fill(setupToken);
      await page.getByLabel(/登录名 Login/).fill(ADMIN_LOGIN);
      await page.getByLabel(/显示名 Display name/).fill('E2E Admin');
      await page.getByLabel(/密码 Password/).fill(ADMIN_PASSWORD);
      await page.getByLabel(/确认密码 Confirm password/).fill(ADMIN_PASSWORD);
      await page.getByRole('button', { name: /Create administrator/ }).click();
    } else {
      // A CI retry: the platform was already initialized by a previous (failed) attempt at this
      // same test — log in as the admin it already created instead of re-running setup.
      await loginWithPassword(page, ADMIN_LOGIN, ADMIN_PASSWORD);
    }

    // Rare retry edge case: a previous attempt's login (the branch above) already burned through
    // enough failed attempts (e.g. a stale/incorrect token elsewhere in a flaky run) to lock the
    // account — accept the lock message as a valid terminal state rather than failing on it.
    const locked = page.getByText(LOCKED_MESSAGE);
    const noWorkspace = page.getByText('You are not a member of any workspace yet');
    await expect(locked.or(noWorkspace)).toBeVisible({ timeout: 15_000 });
    if (await locked.isVisible().catch(() => false)) return;

    await expect(noWorkspace).toBeVisible();
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

  test('5 wrong passwords lock the e2e-admin account; a 6th, correct attempt still shows the lock message', async ({
    page,
  }) => {
    await page.goto('/');
    await reachLoginForm(page);

    for (let attempt = 0; attempt < 5; attempt++) {
      await page.getByLabel(/登录名 Login/).fill(ADMIN_LOGIN);
      await page.getByLabel(/密码 Password/).fill('definitely-the-wrong-password');
      await page.getByRole('button', { name: 'Log in' }).click();
      // Tolerant of an already-locked account (a retried run of this same test) — either message
      // is a valid "that attempt did not succeed" outcome.
      await expect(
        page.getByText(new RegExp(`${BAD_CREDENTIALS_MESSAGE}|${LOCKED_MESSAGE}`)),
      ).toBeVisible();
    }

    await page.getByLabel(/登录名 Login/).fill(ADMIN_LOGIN);
    await page.getByLabel(/密码 Password/).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByText(LOCKED_MESSAGE)).toBeVisible();
  });
});
