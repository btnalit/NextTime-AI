import { type Page, expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/status.spec.ts: the S7-E-page acceptance for 运行状态 Status (`#/platform/status`,
 * docs/development-tasks.md §5d S7-E; docs/platform-admin-design.md §6.7). `platform_status`
 * probes `llm-proxy` and `worker-supervisor` over HTTP — neither runs as a long-lived service in
 * this workflow (.github/workflows/e2e.yml: llm-proxy is a one-off `docker compose run` only used
 * to generate `models.json`; worker-supervisor is never started at all, `AGENT_RUNTIME=fake`), so
 * both deterministically read `down` here — the honest signal an operator would also see from a
 * host with those services stopped, not a test artifact to work around. `kernel`/`postgres` are
 * always `ok` (the handler could not have run otherwise) and `egress-proxy` is always `unknown`
 * by design (loopback-only healthz, never probed). `backup.configured` is always `false` (遗留 6
 * has not landed). This spec asserts those deterministic facts and that the page's own controls
 * (刷新, the 30s auto-refresh) are present — not exact llm-usage/audit counts, which depend on
 * what earlier steps/specs in this same continuous run happened to do.
 *
 * Requires `WEB_E2E_BASE_URL`, `WEB_E2E_ADMIN_LOGIN`/`WEB_E2E_ADMIN_INITIAL_PASSWORD` — the same
 * pre-created platform administrator `modules.spec.ts`/`runtime.spec.ts` use.
 */

const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;

const BAD_CREDENTIALS_MESSAGE = '登录名或密码不正确';

/** Per-file copy — see `modules.spec.ts`'s own doc comment for why this is not a shared helper. */
async function signInAsAdmin(page: Page): Promise<void> {
  const login = ADMIN_LOGIN as string;
  const initialPassword = ADMIN_INITIAL_PASSWORD as string;
  const changedPassword = `${initialPassword}-changed`;

  const changePasswordHeading = page.getByRole('heading', { name: /需要更改密码/ });
  const shell = page.getByTestId('nav-platformStatus');
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

test.describe('S7-E acceptance: platform status page, honest service health in this CI environment', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD to run this suite (see README.md)',
  );

  test('renders health rows including the two services this workflow never starts as down', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.getByTestId('nav-platformStatus').click();
    await expect(page.getByTestId('platform-status-page')).toBeVisible({ timeout: 15_000 });

    const health = page.getByTestId('status-health');
    await expect(health).toBeVisible({ timeout: 15_000 });

    const chips = page.getByTestId('status-health-chip');
    await expect.poll(async () => chips.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(5); // kernel, postgres, llm-proxy, worker-supervisor, egress-proxy

    await expect(health).toContainText('kernel');
    await expect(health).toContainText('postgres');
    await expect(health).toContainText('llm-proxy');
    await expect(health).toContainText('worker-supervisor');
    await expect(health).toContainText('egress-proxy');

    // Neither service runs as a long-lived process in this workflow — down is the truth.
    const llmProxyRow = health.locator('span.row', { hasText: 'llm-proxy' });
    await expect(llmProxyRow.getByTestId('status-health-chip')).toHaveAttribute(
      'data-status',
      'down',
    );
    const supervisorRow = health.locator('span.row', { hasText: 'worker-supervisor' });
    await expect(supervisorRow.getByTestId('status-health-chip')).toHaveAttribute(
      'data-status',
      'down',
    );
    const egressRow = health.locator('span.row', { hasText: 'egress-proxy' });
    await expect(egressRow.getByTestId('status-health-chip')).toHaveAttribute(
      'data-status',
      'unknown',
    );

    // E4: honestly "not configured" until 遗留 6 lands — never a fabricated timer.
    await expect(page.getByTestId('status-backup')).toContainText('未配置');

    // 30-day usage and recent-audit cards render regardless of their exact values.
    await expect(page.getByTestId('status-llm-usage')).toBeVisible();
    await expect(page.getByTestId('status-refresh')).toBeVisible();
  });
});
