import { expect, test } from '@playwright/test';
import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/tasks.spec.ts (S6-A C22 / B6 — console-completion-plan §9 "补齐今天零覆盖的任务 … e2e"):
 * CI smoke coverage for the 任务 Tasks page. A freshly bootstrapped workspace has no Task, so
 * the empty state is the expected outcome; the list is accepted too when an earlier scenario in
 * the same run delegated work. Requires `WEB_E2E_BASE_URL` + `WEB_E2E_API_KEY` (owner) — see
 * governance.spec.ts for the shared conventions.
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

async function login(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithApiKey(page, apiKey);
}

test.describe('CI smoke: tasks page', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('tasks: list renders (empty state is fine) with the bilingual header and filters', async ({
    page,
  }) => {
    await login(page, API_KEY as string);
    await page.goto('/#/work/tasks');
    await expect(page.getByTestId('tasks-empty').or(page.getByTestId('tasks-list'))).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { name: /任务/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /进行中/ })).toBeVisible();
  });

  test('tasks: a deep link to an unknown task shows the drawer without crashing', async ({
    page,
  }) => {
    await login(page, API_KEY as string);
    await page.goto('/#/work/tasks/00000000-0000-0000-0000-000000000000');
    // `get_task` answers 404 for an unknown id; the drawer stays on its skeleton / the list
    // reloads — either way the page itself must still be there.
    await expect(page.getByTestId('task-drawer')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('task-drawer')).toBeHidden();
    await expect(page.getByTestId('tasks-empty').or(page.getByTestId('tasks-list'))).toBeVisible();
  });
});
