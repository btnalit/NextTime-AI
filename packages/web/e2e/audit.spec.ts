import { expect, test } from '@playwright/test';
import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/audit.spec.ts (S6-A A4 / C27 — console-completion-plan §5.5, §9): the 审计 Audit page
 * against a real kernel — the audit stream renders for an owner (the role rule lets an owner
 * call every auditor capability), the resource-type selector carries the kernel's enum, an
 * unknown node answers a coded error, and the `?resourceType=&resourceId=` entry pre-fills and
 * runs the filter (needs the router to accept the `?…` suffix on `#/govern/audit` — until then
 * the deep-link test below documents the expectation rather than passing). Requires
 * `WEB_E2E_BASE_URL` + `WEB_E2E_API_KEY` (owner).
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

async function login(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithApiKey(page, apiKey);
}

test.describe('audit page', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('renders the audit stream with structured rows and the filter selectors', async ({
    page,
  }) => {
    await login(page, API_KEY as string);
    await page.goto('/#/govern/audit');
    // Logging in and reading the workspace already wrote audit rows, so the list is expected;
    // the empty state is tolerated for a kernel that audits nothing on reads.
    await expect(page.getByTestId('audit-list').or(page.getByTestId('audit-empty'))).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('#audit-resource-type option[value="action_request"]')).toHaveCount(
      1,
    );
    await expect(page.getByTestId('audit-actor-select')).toBeVisible();
    await page.selectOption('#audit-resource-type', 'workspace');
    await page.getByTestId('audit-apply').click();
    await expect(page.getByTestId('audit-list').or(page.getByTestId('audit-empty'))).toBeVisible({
      timeout: 15_000,
    });
  });

  test('explain: an unknown node id shows the coded error banner', async ({ page }) => {
    await login(page, API_KEY as string);
    await page.goto('/#/govern/audit');
    await page.locator('#explain-node-id').fill('00000000-0000-0000-0000-000000000000');
    await page.getByRole('button', { name: /Explain/ }).click();
    const banner = page.getByTestId('explain-error');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toHaveAttribute('data-error-code', /not_found|invalid_params/);
  });

  test('deep link ?resourceType=workspace pre-fills and runs the filter', async ({ page }) => {
    await login(page, API_KEY as string);
    await page.goto('/#/govern/audit?resourceType=workspace');
    await expect(page.locator('#audit-resource-type')).toHaveValue('workspace', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('audit-list').or(page.getByTestId('audit-empty'))).toBeVisible();
  });
});
