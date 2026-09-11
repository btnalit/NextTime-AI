import { type Page, expect } from '@playwright/test';

/**
 * e2e/auth-helpers.ts: the one piece of P-A1 login plumbing every spec needs, factored out rather
 * than duplicated like each file's own `login()` wrapper (unlike those, which differ in what they
 * do before/after, this step is byte-identical everywhere it is needed).
 *
 * `.github/workflows/e2e.yml` runs every spec under `packages/web/e2e/` in one `playwright test`
 * invocation, `workers: 1` — sequential, alphabetical by filename (`approvals`, `chat`, `explorer`,
 * `governance`, `login`). There is no setup page any more (docs/platform-admin-design.md §4): the
 * kernel pre-creates the `admin` user with a random temporary password on a fresh database, so a
 * bare `goto('/')` always reaches `LoginPage` — every spec below only ever holds an API key or a
 * password for an already-existing user.
 */
export async function reachLoginForm(page: Page): Promise<'shell' | 'login'> {
  const forgetKey = page.getByRole('button', { name: 'Forget key' });
  const apiKeySummary = page.getByText('用 API key 登录 Use an API key instead');
  const passwordLoginButton = page.getByRole('button', { name: 'Log in' });

  await expect
    .poll(
      async () => {
        if (await forgetKey.isVisible().catch(() => false)) return 'shell';
        if (await apiKeySummary.isVisible().catch(() => false)) return 'login';
        if (await passwordLoginButton.isVisible().catch(() => false)) return 'login';
        return 'pending';
      },
      { timeout: 15_000 },
    )
    .not.toBe('pending');

  return (await forgetKey.isVisible().catch(() => false)) ? 'shell' : 'login';
}

/** Expands `LoginPage`'s collapsed `<details>` and fills/submits the API-key form — the
 *  equivalent of the old, always-visible "Sign in" form every existing spec used to click
 *  directly. Assumes `reachLoginForm` has already resolved to `'login'`. */
export async function loginWithApiKey(page: Page, apiKey: string): Promise<void> {
  const apiKeySummary = page.getByText('用 API key 登录 Use an API key instead');
  if (
    !(await page
      .getByPlaceholder('sk-...')
      .isVisible()
      .catch(() => false))
  ) {
    await apiKeySummary.click();
  }
  await page.getByPlaceholder('sk-...').fill(apiKey);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 15_000 });
}

/** Fills/submits `LoginPage`'s primary password form. Assumes `reachLoginForm` has already
 *  resolved to `'login'`. */
export async function loginWithPassword(
  page: Page,
  login: string,
  password: string,
): Promise<void> {
  await page.getByLabel(/登录名 Login/).fill(login);
  await page.getByLabel(/密码 Password/).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}
