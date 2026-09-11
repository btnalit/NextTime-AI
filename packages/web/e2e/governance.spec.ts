import { expect, test } from '@playwright/test';
import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/governance.spec.ts: CI smoke coverage for the S3.11/S3.12/S3.13/S3.14 governance surface
 * (`.github/workflows/e2e.yml`). Deliberately lighter than the full acceptance scenarios in
 * chat.spec.ts/approvals.spec.ts — every test here only needs a single fresh owner API key
 * against a newly bootstrapped workspace (no second principal, no seeded ActionRequest rows; see
 * approvals.spec.ts's own doc comment for why those two heavier scenarios stay local-only). Each
 * test asserts the page reaches a "ready" (or an explicitly-acceptable empty) state without a
 * 403/404/500 — a regression here means the console cannot even render the governance surface for
 * a workspace owner, independent of whatever data happens to be in the workspace.
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_API_KEY` (workspace owner — every capability exercised
 * below is `minRole: 'owner'` or lower, so an owner key satisfies all four scenarios), and a
 * kernel started `AGENT_RUNTIME=fake` (unused directly by these tests, same S1.8 convention as
 * chat.spec.ts). See README.md "End-to-end (Playwright)" and docs/runbooks/web-console.md "CI
 * （Playwright）" for how `.github/workflows/e2e.yml` provides these.
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

async function login(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.goto('/');
  // Not a URL/hash assertion: a bare `/` load has no `location.hash` at all, and
  // `lib/router.ts`'s `routeFromHash('')` resolves straight to the default `chats` route without
  // ever calling `navigate()` (only a stray `#/login` hash triggers App.tsx's own redirect
  // effect) — so the URL stays hash-less through and after login. The signed-in shell (Sidebar's
  // connection indicator) is the reliable "we're past the login screen" signal instead — checked
  // inside `loginWithApiKey`. `reachLoginForm` also tolerates an already-signed-in shell (see
  // `e2e/auth-helpers.ts`'s own doc comment).
  await reachLoginForm(page);
  await loginWithApiKey(page, apiKey);
}

test.describe('CI smoke: governance surface', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('approvals: queue renders (empty state is fine)', async ({ page }) => {
    const apiKey = API_KEY as string; // guarded by test.skip above
    await login(page, apiKey);

    await page.goto('/#/work/approvals');
    // A fresh workspace has no ActionRequests at all — `approvals-empty` is the expected state;
    // `approvals-list` is accepted too so this test keeps passing if some earlier scenario in the
    // same run left rows behind (see approvals.spec.ts's own local-only seeded scenarios).
    await expect(
      page.getByTestId('approvals-empty').or(page.getByTestId('approvals-list')),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('members: lists the owner, creating a member shows the API key once', async ({ page }) => {
    const apiKey = API_KEY as string;
    await login(page, apiKey);

    await page.goto('/#/govern/members');
    // The bootstrap-created owner principal is itself a row in `list_principals`.
    await expect(page.getByTestId('members-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('member-row').first()).toBeVisible();

    // P-A1: "Add member" now adds an existing platform user by login (`add_member`); the API-key
    // Principal this test creates comes from the relabelled service-credential form.
    await page.getByRole('button', { name: /Service credential/ }).click();
    const drawer = page.getByTestId('create-principal-drawer');
    await expect(drawer).toBeVisible();
    await drawer.locator('#cp-name').fill(`ci-e2e-member-${Date.now()}`);
    await drawer.getByRole('button', { name: 'Create' }).click();

    // Shown exactly once (CreatePrincipalForm.tsx) — must be non-empty before the drawer closes.
    const createdKey = page.getByTestId('created-api-key');
    await expect(createdKey).toBeVisible({ timeout: 15_000 });
    await expect(createdKey).not.toHaveText('');

    await drawer.getByRole('button', { name: /Done/ }).click();
    await expect(drawer).toBeHidden();
  });

  test('my agent: loads with the models list', async ({ page }) => {
    const apiKey = API_KEY as string;
    await login(page, apiKey);

    await page.goto('/#/me/agent');
    await expect(page.getByTestId('agent-profile-effective')).toBeVisible({ timeout: 15_000 });

    // The model select (AgentProfileForm.tsx `#ap-model`) always carries the "inherit" option;
    // asserting the CI stack's own seeded model (config/llm-providers.fake.example.yaml's
    // `fake` provider, `fake-echo` model — projected by the kernel's `list_models` as
    // `<provider>/<model>`) confirms `models.json` really made it through the CI stack's
    // `make gen-models` step, not just that the form rendered with an empty list.
    await expect(page.locator('#ap-model')).toBeVisible();
    await expect(page.locator('#ap-model option[value="fake/fake-echo"]')).toHaveCount(1);
  });

  test('systems: onboarding wizard opens to step ①', async ({ page }) => {
    const apiKey = API_KEY as string;
    await login(page, apiKey);

    await page.goto('/#/govern/systems');
    await page.getByRole('button', { name: /Onboarding wizard/ }).click();

    const drawer = page.getByTestId('onboarding-wizard-drawer');
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByTestId('wizard-step-kind')).toBeVisible();
    await expect(drawer.getByRole('radiogroup', { name: 'Kind' })).toBeVisible();
  });
});
