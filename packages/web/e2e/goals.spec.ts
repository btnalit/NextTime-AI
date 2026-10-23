import { expect, test } from '@playwright/test';
import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/goals.spec.ts (S11 GO6, read-only part): CI smoke coverage for the 目标 Goals pages against
 * a running kernel. Nothing can propose a goal from the console yet (`propose_goal` is GO5c), so a
 * freshly bootstrapped workspace has none: the empty state is the expected outcome, and the list
 * is accepted too once a later lane seeds one. A deep link to a goal the reader cannot see — here
 * one that does not exist — reads as not found. Requires `WEB_E2E_BASE_URL` + `WEB_E2E_API_KEY`
 * (owner) — see governance.spec.ts for the shared conventions.
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

async function login(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithApiKey(page, apiKey);
}

test.describe('CI smoke: goals pages', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('goals: the sidebar opens the list (empty state is fine) with its filters', async ({
    page,
  }) => {
    await login(page, API_KEY as string);
    await page.getByRole('link', { name: /目标/ }).first().click();
    await expect(page).toHaveURL(/#\/work\/goals$/);
    await expect(page.getByTestId('goals-empty').or(page.getByTestId('goals-list'))).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { name: '目标', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: /未结束/ })).toBeVisible();
  });

  test('goals: a deep link to an unknown goal reads as not found, with a way back', async ({
    page,
  }) => {
    await login(page, API_KEY as string);
    await page.goto('/#/work/goals/00000000-0000-4000-8000-000000000000');
    await expect(page.getByTestId('goal-not-found')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: '回到目标列表' }).click();
    await expect(page.getByTestId('goals-empty').or(page.getByTestId('goals-list'))).toBeVisible();
  });
});
