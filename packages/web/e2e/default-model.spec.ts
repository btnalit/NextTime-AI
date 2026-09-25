import { type Page, expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/default-model.spec.ts: the S7-E-page acceptance for E5 (P-D 剩余,
 * docs/development-tasks.md §5d S7-E 决定 E5; docs/platform-admin-design.md §6.2) —
 * `set_platform_default_model` round-tripped through the 平台默认入口模型 select on
 * 模型与供应商 (`#/platform/models`, `components/platform/providers/DefaultModelControl.tsx`).
 * `list_platform_models` reads `models.json` directly (a kernel capability, not an llm-proxy
 * admin-API call), so this control works even though llm-proxy is never a long-lived service in
 * this workflow (.github/workflows/e2e.yml runs it once, to generate `models.json`, then never
 * starts it — the page's own provider table below it may show its own load error independently;
 * this spec does not depend on that table). `fake/fake-echo` is the fake provider's first
 * catalog entry (`config/llm-providers.fake.example.yaml`).
 *
 * Clears the default back to null at the end — a good-citizen cleanup, not a requirement of the
 * feature: `create_workspace` (and the console's 新建工作区 form) falls back to this platform
 * setting when no explicit entry model is picked, and other specs in this same continuous run
 * (e.g. `modules.spec.ts`'s second workspace) should not have to account for it being set.
 *
 * Requires `WEB_E2E_BASE_URL`, `WEB_E2E_ADMIN_LOGIN`/`WEB_E2E_ADMIN_INITIAL_PASSWORD` — the same
 * pre-created platform administrator `modules.spec.ts`/`runtime.spec.ts` use.
 */

const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';
const PI_DEFAULT = '__pi_default__';

/** Per-file copy — see `modules.spec.ts`'s own doc comment for why this is not a shared helper. */
async function signInAsAdmin(page: Page): Promise<void> {
  const login = ADMIN_LOGIN as string;
  const initialPassword = ADMIN_INITIAL_PASSWORD as string;
  const changedPassword = `${initialPassword}-changed`;

  const changePasswordHeading = page.getByRole('heading', { name: /需要更改密码/ });
  const shell = page.getByTestId('nav-platformModels');
  const badCredentials = page.getByText(BAD_CREDENTIALS_MESSAGE);

  await page.goto('/');
  await reachLoginForm(page);
  await loginWithPassword(page, login, initialPassword);
  await expect(changePasswordHeading.or(shell).or(badCredentials).first()).toBeVisible({
    timeout: 15_000,
  });

  if (await badCredentials.isVisible().catch(() => false)) {
    await page.locator('#login-password').fill(changedPassword);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(changePasswordHeading.or(shell).first()).toBeVisible({ timeout: 15_000 });
  }

  if (await changePasswordHeading.isVisible().catch(() => false)) {
    await page.locator('#cp-current-password').fill(initialPassword);
    await page.locator('#cp-new-password').fill(changedPassword);
    await page.locator('#cp-confirm-password').fill(changedPassword);
    await page.getByRole('button', { name: /更改密码/ }).click();
  }

  await expect(shell).toBeVisible({ timeout: 15_000 });
}

test.describe('S7-E acceptance: platform default entry model round-trips through set_platform_default_model', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD to run this suite (see README.md)',
  );

  test('picking a catalog model saves it and it survives a reload; clearing it back to pi default also survives', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.getByTestId('nav-platformModels').click();
    await expect(page.getByTestId('platform-models-page')).toBeVisible({ timeout: 15_000 });

    const select = page.getByTestId('platform-default-model-select');
    await expect(select).toBeVisible({ timeout: 15_000 });
    // Exact match on the option's `value` — the catalog also has `fake/fake-echo-alt`, which
    // `hasText: 'fake/fake-echo'` (a substring match) would also match, over-counting to 2.
    await expect(select.locator('option[value="fake/fake-echo"]')).toHaveCount(1);

    try {
      await select.selectOption('fake/fake-echo');
      await expect(page.getByTestId('platform-default-model-saved')).toBeVisible({
        timeout: 15_000,
      });
      await expect(select).toHaveValue('fake/fake-echo');

      // Reload: the select is re-seeded from a fresh get_platform_settings, not client state.
      await page.goto('/');
      await expect(page.getByTestId('nav-platformModels')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('nav-platformModels').click();
      const reloadedSelect = page.getByTestId('platform-default-model-select');
      await expect(reloadedSelect).toHaveValue('fake/fake-echo', { timeout: 15_000 });
    } finally {
      // Good-citizen cleanup (see this file's own doc comment) — always runs, pass or fail.
      const cleanupSelect = page.getByTestId('platform-default-model-select');
      if (await cleanupSelect.isVisible().catch(() => false)) {
        await cleanupSelect.selectOption(PI_DEFAULT);
        await expect(page.getByTestId('platform-default-model-saved')).toBeVisible({
          timeout: 15_000,
        });
      }
    }
  });
});
