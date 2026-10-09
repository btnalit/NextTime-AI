import { type Page, expect } from '@playwright/test';

/**
 * e2e/auth-helpers.ts: the one piece of P-A1 login plumbing every spec needs, factored out rather
 * than duplicated like each file's own `login()` wrapper (unlike those, which differ in what they
 * do before/after, this step is byte-identical everywhere it is needed).
 *
 * `.github/workflows/e2e.yml` runs every spec under `packages/web/e2e/` in one `playwright test`
 * invocation, `workers: 1` — sequential: the `chromium` project (`approvals`, `chat`, `explorer`,
 * `governance`, `workspaces`) and then the dependent `chromium-login` project (`login`, whose
 * lockout test must come last — `playwright.config.ts`). There is no setup page any more (docs/platform-admin-design.md §4): the
 * kernel pre-creates the `admin` user with a random temporary password on a fresh database, so a
 * bare `goto('/')` always reaches `LoginPage` — every spec below only ever holds an API key or a
 * password for an already-existing user.
 */
export async function reachLoginForm(page: Page): Promise<'shell' | 'login'> {
  // By test id, not visible copy: these are the doors every spec walks through, and the console's
  // wording keeps being tuned — a renamed button once timed out every test in the suite.
  const forgetKey = page.getByTestId('forget-key');
  const apiKeySummary = page.getByTestId('api-key-login-toggle');
  const passwordLoginButton = page.getByTestId('login-submit');

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
 *  equivalent of the old, always-visible API-key form every existing spec used to click
 *  directly. Assumes `reachLoginForm` has already resolved to `'login'`. */
export async function loginWithApiKey(page: Page, apiKey: string): Promise<void> {
  const apiKeySummary = page.getByTestId('api-key-login-toggle');
  if (
    !(await page
      .getByPlaceholder('sk-...')
      .isVisible()
      .catch(() => false))
  ) {
    await apiKeySummary.click();
  }
  await page.getByPlaceholder('sk-...').fill(apiKey);
  await page.getByTestId('api-key-login-submit').click();
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'connected', {
    timeout: 15_000,
  });
}

/** Fills/submits `LoginPage`'s primary password form. Assumes `reachLoginForm` has already
 *  resolved to `'login'`. By id (`#login-name`/`#login-password`), not `getByLabel` — S8 W1-A9's
 *  i18n switch found `getByLabel(/^密码$/)` never resolving in CI (Chromium's computed accessible
 *  name for `<Field required>`'s label apparently still folds in the `aria-hidden` required
 *  asterisk in this label-association shape, so no locator matches the exact-anchored regex); the
 *  id is unambiguous either way. */
export async function loginWithPassword(
  page: Page,
  login: string,
  password: string,
): Promise<void> {
  await page.locator('#login-name').fill(login);
  await page.locator('#login-password').fill(password);
  await page.getByTestId('login-submit').click();
}
