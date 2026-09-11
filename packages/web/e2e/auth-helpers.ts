import { type Page, expect } from '@playwright/test';

/**
 * e2e/auth-helpers.ts: the one piece of S4.1 login plumbing every spec needs, factored out rather
 * than duplicated like each file's own `login()` wrapper (unlike those, which differ in what they
 * do before/after, this step is byte-identical everywhere it is needed).
 *
 * `.github/workflows/e2e.yml` runs every spec under `packages/web/e2e/` in one `playwright test`
 * invocation, `workers: 1` — sequential, alphabetical by filename (`approvals`, `chat`, `explorer`,
 * `governance`, `login`). Only `login.spec.ts`'s own "initialize platform" scenario ever calls
 * `POST /api/platform/setup`, so every spec that runs before it hits a freshly booted `App` with
 * `GET /api/platform/setup-state` still answering `initialized:false` — `App` renders `SetupPage`,
 * not `LoginPage`, on a bare `goto('/')` (see `App.tsx`'s own doc comment on the boot sequence).
 * `SetupPage` carries an "已有账户？登录 Already have an account? Log in" escape hatch
 * (`components/SetupPage.tsx`) for exactly this: every spec below only ever holds an API key or a
 * password for an already-existing user, never touches `/api/platform/setup` itself, and must
 * reach `LoginPage` regardless of whether platform setup has happened yet this run.
 */
export async function reachLoginForm(page: Page): Promise<'shell' | 'login'> {
  const forgetKey = page.getByRole('button', { name: 'Forget key' });
  const loginInstead = page.getByRole('button', { name: /Already have an account\? Log in/ });
  const apiKeySummary = page.getByText('用 API key 登录 Use an API key instead');
  const passwordLoginButton = page.getByRole('button', { name: 'Log in' });

  await expect
    .poll(
      async () => {
        if (await forgetKey.isVisible().catch(() => false)) return 'shell';
        if (await loginInstead.isVisible().catch(() => false)) return 'setup';
        if (await apiKeySummary.isVisible().catch(() => false)) return 'login';
        if (await passwordLoginButton.isVisible().catch(() => false)) return 'login';
        return 'pending';
      },
      { timeout: 15_000 },
    )
    .not.toBe('pending');

  if (await forgetKey.isVisible().catch(() => false)) return 'shell';

  if (await loginInstead.isVisible().catch(() => false)) {
    await loginInstead.click();
    await passwordLoginButton.waitFor({ state: 'visible', timeout: 15_000 });
  }
  return 'login';
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
