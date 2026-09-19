import { expect, test } from '@playwright/test';
import { loginWithPassword, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/explorer.spec.ts: CI smoke coverage for the Explorer's cookie-based auth (S4.1 rewrite —
 * the old `POST /api/explorer/session` key-exchange, `lib/explorer-session.ts`, is gone). The
 * Explorer (`packages/kernel/src/interfaces/explorer-contract`) now reads the same console
 * session cookie the workspace console itself uses plus the `nexttime_workspace` selector cookie
 * `lib/auth-api.ts` `setWorkspaceCookie` sets — an API-key session has neither, so this suite must
 * log in with a password, not an API key (unlike every other spec in this directory).
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_OWNER_LOGIN`/`WEB_E2E_OWNER_PASSWORD` (a workspace owner
 * with a permanent console password — see `login.spec.ts`'s own doc comment for how CI sets this
 * up) and a kernel started with a Handle signing key configured (`docs/runbooks/`).
 */

const OWNER_LOGIN = process.env.WEB_E2E_OWNER_LOGIN;
const OWNER_PASSWORD = process.env.WEB_E2E_OWNER_PASSWORD;

async function login(
  page: import('@playwright/test').Page,
  loginName: string,
  password: string,
): Promise<void> {
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithPassword(page, loginName, password);
  // Not a URL/hash assertion — see chat.spec.ts's own doc comment on why: a bare `/` load has no
  // `location.hash`, and `routeFromHash('')` resolves straight to the default `chats` route. The
  // signed-in shell (Sidebar's connection indicator) is the reliable "we're past the login
  // screen" signal instead.
  await expect(page.getByTestId('ws-status')).toHaveText('Connected', { timeout: 15_000 });
}

test.describe('S4.1: Explorer cookie auth', () => {
  test.skip(
    !OWNER_LOGIN || !OWNER_PASSWORD,
    'set WEB_E2E_BASE_URL, WEB_E2E_OWNER_LOGIN and WEB_E2E_OWNER_PASSWORD to run this suite against a running kernel (see README.md)',
  );

  test('no credentials -> 401', async ({ request }) => {
    // `request` is a fresh context with no cookies — no console login has happened on it.
    const res = await request.get('/api/graph/nodes');
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(typeof body.detail).toBe('string');
  });

  test('password login installs the console + workspace-selector cookies; the same browser context reaches the graph', async ({
    page,
  }) => {
    const ownerLogin = OWNER_LOGIN as string; // guarded by test.skip above
    const ownerPassword = OWNER_PASSWORD as string;
    await login(page, ownerLogin, ownerPassword);

    // `page.request` shares the page's own cookie jar, so both cookies App.tsx's login installed
    // (the server-set `nexttime_console_session`, and `lib/auth-api.ts` `setWorkspaceCookie`'s
    // `nexttime_workspace`) are sent here too.
    const res = await page.request.get('/api/graph/nodes');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);

    // S6-C (§5.7): the sidebar hides the 图 entry when caddy serves the placeholder page
    // ("Explorer bundle not built" — `lib/explorer-probe.ts`). CI does not build the bundle, so
    // the entry is expected to be absent there once the shell wiring lands; a deployment with a
    // real bundle keeps the link. Until the Sidebar change is merged the placeholder case may
    // still show the link — both are accepted here, and the strict check is the fixme below.
    const explorerBody = await (await page.request.get('/explorer/')).text();
    const bundleBuilt = !explorerBody.includes('Explorer bundle not built');
    const explorerLink = page.getByTestId('nav-explorer');
    if (bundleBuilt) {
      await expect(explorerLink).toHaveAttribute('href', '/explorer/');
    } else if (await explorerLink.isVisible().catch(() => false)) {
      await expect(explorerLink).toHaveAttribute('href', '/explorer/');
    }
  });

  test('S6-C: the 图 Explorer entry is hidden while caddy serves the placeholder page', async ({
    page,
  }) => {
    // Strict form of the check above — flip `fixme` off once `AppShell` passes
    // `useExplorerAvailable()` to `Sidebar` (components/shell, another lane).
    test.fixme(true, 'sidebar wiring for useExplorerAvailable() has not landed yet (S6-C report)');
    const ownerLogin = OWNER_LOGIN as string;
    const ownerPassword = OWNER_PASSWORD as string;
    await login(page, ownerLogin, ownerPassword);
    const explorerBody = await (await page.request.get('/explorer/')).text();
    const bundleBuilt = !explorerBody.includes('Explorer bundle not built');
    const explorerLink = page.getByTestId('nav-explorer');
    if (bundleBuilt) await expect(explorerLink).toBeVisible();
    else await expect(explorerLink).toBeHidden();
  });

  test('Sign out clears both cookies -> 401 again', async ({ page }) => {
    const ownerLogin = OWNER_LOGIN as string;
    const ownerPassword = OWNER_PASSWORD as string;
    await login(page, ownerLogin, ownerPassword);
    expect((await page.request.get('/api/graph/nodes')).status()).toBe(200);

    await page.getByRole('button', { name: /登出 Sign out/ }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

    await expect
      .poll(async () => (await page.request.get('/api/graph/nodes')).status(), { timeout: 10_000 })
      .toBe(401);
  });
});
