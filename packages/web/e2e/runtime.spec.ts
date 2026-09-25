import { type Page, expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/runtime.spec.ts: the S7-E-page acceptance for 运行层 Runtime (`#/platform/runtime`,
 * docs/development-tasks.md §5d S7-E; docs/platform-admin-design.md §6.5). This workflow
 * (.github/workflows/e2e.yml) never builds `nexttime-ai-worker-runtime` and never starts
 * `worker-supervisor` (`AGENT_RUNTIME=fake` — see that file's own header comment: no
 * agent-host/worker-supervisor/docker-in-docker is needed for the chat/approvals/governance paths
 * the rest of this suite exercises), so `runtime_inventory`'s own degrade rules
 * (`application/platform/runtime.ts`'s `tryListImages`/`resolveActiveImage`) put this page in its
 * honest **empty/unresolved** state, deterministically: no active image, no images in the
 * inventory, no resident containers, `pi_drift.status: "unknown"` (no CI-produced drift file
 * either). This spec asserts exactly that — it does not (and in this environment cannot)
 * exercise 设为活动/回滚/现在重建空闲的, all of which need at least one labelled image or a
 * resident container to act on; those mutations are covered by
 * `packages/kernel/src/application/gateway/platform-runtime.integration.test.ts` (fake supervisor
 * client) and `PlatformRuntimePage.test.tsx` (scripted `http`).
 *
 * Requires `WEB_E2E_BASE_URL`, `WEB_E2E_ADMIN_LOGIN`/`WEB_E2E_ADMIN_INITIAL_PASSWORD` — the same
 * pre-created platform administrator `modules.spec.ts`/`workspaces.spec.ts` use.
 */

const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';

/** Per-file copy — see `modules.spec.ts`'s own doc comment for why this is not a shared helper:
 *  it tolerates both password states the admin account can be in across a serial run of every
 *  e2e spec file. */
async function signInAsAdmin(page: Page): Promise<void> {
  const login = ADMIN_LOGIN as string;
  const initialPassword = ADMIN_INITIAL_PASSWORD as string;
  const changedPassword = `${initialPassword}-changed`;

  const changePasswordHeading = page.getByRole('heading', { name: /需要更改密码/ });
  const shell = page.getByTestId('nav-platformRuntime');
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

test.describe('S7-E acceptance: platform runtime page, honest empty state in this CI environment', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD to run this suite (see README.md)',
  );

  test('shows no active image, an empty image inventory, no resident containers, and pi_drift "unknown"', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.getByTestId('nav-platformRuntime').click();
    await expect(page.getByTestId('platform-runtime-page')).toBeVisible({ timeout: 15_000 });

    // No `activeRuntimeImage` platform setting and worker-supervisor unreachable — never guessed.
    await expect(page.getByTestId('runtime-active-image-unresolved')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('runtime-active-image')).toHaveCount(0);

    // No image ever built in this workflow (.github/workflows/e2e.yml never runs
    // `docker compose build worker-runtime`) — the honest empty state, not a fabricated row.
    await expect(page.getByTestId('runtime-images-empty')).toBeVisible({ timeout: 15_000 });

    // No entry container is ever spawned by this suite (AGENT_RUNTIME=fake).
    await expect(page.getByTestId('runtime-residents-empty')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('runtime-roll-entry-containers')).toBeDisabled();

    // pi_drift: no CI-produced drift file in this environment — status "unknown", not guessed.
    // S8 W1-A10: the chip is bilingual now (default zh-CN renders '未知'); `data-status` still
    // carries the raw wire value.
    const drift = page.getByTestId('pi-drift-body');
    await expect(drift).toBeVisible({ timeout: 15_000 });
    await expect(drift.getByTestId('pi-drift-status')).toHaveAttribute('data-status', 'unknown');
    await expect(drift.getByTestId('pi-drift-status')).toHaveText('未知');
  });
});
