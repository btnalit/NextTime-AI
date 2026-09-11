import { expect, test } from '@playwright/test';

/**
 * e2e/explorer.spec.ts: CI smoke coverage for the W7 Explorer session cookie
 * (`packages/kernel/src/interfaces/explorer-contract/session.ts`, `lib/explorer-session.ts`).
 * Same convention as `governance.spec.ts` — one fresh owner API key against a newly bootstrapped
 * workspace, no seeded rows required (the graph is allowed to be empty; these tests only check
 * the auth boundary, not graph content).
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_API_KEY` (workspace owner) and a kernel started with a
 * Handle signing key configured (`docs/runbooks/`) — see `governance.spec.ts`'s own doc comment
 * for the rest of the shared setup.
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

async function login(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.goto('/');
  // A key a previous login left in this tab's `sessionStorage` (`lib/session.ts`) would
  // auto-connect on load and leave the login form disabled — drop it and reload first, the same
  // way approvals.spec.ts's own login helper does.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByPlaceholder('sk-...').fill(apiKey);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Not a URL/hash assertion: a bare `/` load has no `location.hash` at all, and
  // `lib/router.ts`'s `routeFromHash('')` resolves straight to the default `chats` route without
  // ever calling `navigate()` (only a stray `#/login` hash triggers App.tsx's own redirect
  // effect) — so the URL stays hash-less through and after login. The signed-in shell (Sidebar's
  // connection indicator) is the reliable "we're past the login screen" signal instead.
  await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 15_000 });
}

test.describe('W7: Explorer session cookie', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('no credentials -> 401', async ({ request }) => {
    // `request` is a fresh context with no cookies — no console login has happened on it.
    const res = await request.get('/api/graph/nodes');
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(typeof body.detail).toBe('string');
  });

  test('console login installs the Explorer session; the same browser context reaches the graph', async ({
    page,
  }) => {
    const apiKey = API_KEY as string; // guarded by test.skip above
    await login(page, apiKey);

    // `page.request` shares the page's own cookie jar, so the cookie App.tsx's login installed
    // (lib/explorer-session.ts `createExplorerSession`) is sent here too. The install is
    // fire-and-forget behind the "Connected" signal `login()` waits for, so poll for it.
    await expect
      .poll(async () => (await page.request.get('/api/graph/nodes')).status(), { timeout: 10_000 })
      .toBe(200);
    const res = await page.request.get('/api/graph/nodes');
    const body = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);

    const explorerLink = page.getByTestId('nav-explorer');
    await expect(explorerLink).toHaveAttribute('href', '/explorer/');
  });

  test('Forget key clears the session -> 401 again', async ({ page }) => {
    const apiKey = API_KEY as string;
    await login(page, apiKey);
    await expect
      .poll(async () => (await page.request.get('/api/graph/nodes')).status(), { timeout: 10_000 })
      .toBe(200);

    await page.getByRole('button', { name: 'Forget key' }).click();
    await expect(page.getByPlaceholder('sk-...')).toBeVisible();

    // The DELETE is fire-and-forget (App.tsx `handleForgetKey`), so poll rather than assert once.
    await expect
      .poll(async () => (await page.request.get('/api/graph/nodes')).status(), { timeout: 10_000 })
      .toBe(401);
  });
});
