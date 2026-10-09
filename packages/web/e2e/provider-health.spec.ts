import { execFileSync } from 'node:child_process';
import { type Page, expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/provider-health.spec.ts (console audit P0-2, #530): the provider status llm-proxy writes to
 * `provider-health.json` (next to `models.json`) reaches the overview and the model pickers.
 *
 * The workflow installs a synthetic file with the fake provider tested `ok` (.github/workflows/
 * e2e.yml "Provider health fixture") — the main path: both fake models count as available and the
 * pickers offer them without a status. This spec then corrupts and removes that file (review M1:
 * missing or unreadable is unknown, never available) and checks the overview and the platform
 * default-model picker say so; the kernel reads the file on every request, so no restart is
 * needed. The file is restored in `afterAll`, so later specs see the main path again.
 *
 * Requires `WEB_E2E_ADMIN_LOGIN`/`WEB_E2E_ADMIN_INITIAL_PASSWORD` and
 * `WEB_E2E_PROVIDER_HEALTH_FILE` (the host path; root-owned, so it is rewritten with `sudo -n`,
 * which the CI runner allows without a password).
 */

const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;
const HEALTH_FILE = process.env.WEB_E2E_PROVIDER_HEALTH_FILE;

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';

/** Per-file copy — see `modules.spec.ts`'s own doc comment for why this is not a shared helper. */
async function signInAsAdmin(page: Page): Promise<void> {
  const login = ADMIN_LOGIN as string;
  const initialPassword = ADMIN_INITIAL_PASSWORD as string;
  const changedPassword = `${initialPassword}-changed`;

  const changePasswordHeading = page.getByTestId('change-password-title');
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
    await page.getByTestId('login-submit').click();
    await expect(changePasswordHeading.or(shell).first()).toBeVisible({ timeout: 15_000 });
  }

  if (await changePasswordHeading.isVisible().catch(() => false)) {
    await page.locator('#cp-current-password').fill(initialPassword);
    await page.locator('#cp-new-password').fill(changedPassword);
    await page.locator('#cp-confirm-password').fill(changedPassword);
    await page.getByTestId('change-password-submit').click();
  }

  await expect(shell).toBeVisible({ timeout: 15_000 });
}

function sudo(args: readonly string[], input?: string): string {
  return execFileSync('sudo', ['-n', ...args], { input, encoding: 'utf8' });
}

async function openOverview(page: Page): Promise<void> {
  await page.goto('/#/platform/overview');
  await expect(page.getByTestId('platform-count-models')).toBeVisible({ timeout: 15_000 });
}

/** The 可用模型 tile's big number. */
function modelsTileValue(page: Page) {
  return page.getByTestId('platform-count-models').locator('.platform-tile-value');
}

test.describe('provider health reaches the overview and the model pickers (#530)', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD || !HEALTH_FILE,
    'set WEB_E2E_ADMIN_LOGIN, WEB_E2E_ADMIN_INITIAL_PASSWORD and WEB_E2E_PROVIDER_HEALTH_FILE to run this suite (see .github/workflows/e2e.yml)',
  );

  let original = '';
  /** Back to the fixture, with the owner and mode llm-proxy gives the file on a host. */
  function restore(): void {
    sudo(
      ['install', '-m', '0644', '-o', '10001', '-g', '10001', '/dev/stdin', HEALTH_FILE as string],
      original,
    );
  }
  test.beforeAll(() => {
    original = sudo(['cat', HEALTH_FILE as string]);
  });
  test.afterAll(() => {
    if (original) restore();
  });

  test('main path: the fake provider tested ok — both models available, offered without a status', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await openOverview(page);
    await expect(modelsTileValue(page)).toHaveText('2');
    await expect(page.getByTestId('platform-count-models-sub')).toHaveCount(0);
    await expect(page.getByTestId('platform-checklist')).toContainText('2 个可用模型');
    await expect(page.getByText('读不到模型供应商状态')).toHaveCount(0);

    await page.goto('/#/platform/models');
    const select = page.getByTestId('platform-default-model-select');
    await expect(select).toBeVisible({ timeout: 15_000 });
    await expect(select.locator('option[value="fake/fake-echo"]')).toHaveText('fake/fake-echo');
    await expect(select.locator('option[value="fake/fake-echo"]')).toBeEnabled();
    await expect(page.getByTestId('platform-default-model-health')).toHaveCount(0);
  });

  for (const [label, corrupt] of [
    ['a corrupt file', (file: string) => sudo(['tee', file], '{ not json')],
    ['a missing file', (file: string) => sudo(['rm', '-f', file])],
  ] as const) {
    test(`unknown state (${label}): nothing reads as available, and every place says so`, async ({
      page,
    }) => {
      corrupt(HEALTH_FILE as string);
      try {
        await signInAsAdmin(page);
        await openOverview(page);
        await expect(modelsTileValue(page)).toHaveText('—');
        await expect(page.getByTestId('platform-count-models-sub')).toHaveText(
          '已配置 2 个，状态未知',
        );
        await expect(page.getByTestId('platform-checklist')).toContainText('没读到供应商状态');
        await expect(page.getByTestId('checklist-test-provider')).toBeVisible();
        await expect(
          page.getByTestId('platform-attention-item').filter({ hasText: '读不到模型供应商状态' }),
        ).toHaveCount(1);

        await page.goto('/#/platform/models');
        const select = page.getByTestId('platform-default-model-select');
        await expect(select).toBeVisible({ timeout: 15_000 });
        await expect(select.locator('option[value="fake/fake-echo"]')).toHaveText(
          'fake/fake-echo · 状态未知',
        );
        const note = page.getByTestId('platform-default-model-health');
        await expect(note).toContainText('状态未知');
        await expect(page.getByTestId('platform-default-model-health-fix')).toHaveText(
          /去模型与供应商检查|去模型与供应商修复/,
        );
      } finally {
        restore();
      }
    });
  }
});
