import { type Page, expect } from '@playwright/test';
import { loginWithApiKey, loginWithPassword, reachLoginForm } from '../auth-helpers.js';

/**
 * e2e/lib/auth.ts: the two session-establishing flows the S8 W1-B gates (`e2e/00-gates/`) and
 * journeys (`e2e/journeys/`) both need, factored out once rather than re-derived per file the way
 * every pre-existing spec's own local `login()`/`signInAsAdmin()` does (see e.g.
 * workspaces.spec.ts's own doc comment on why *that* file keeps a local copy — those predate this
 * one and are left alone, S8 W1-B does not touch other spec files). `auth-helpers.ts` stays the
 * single place for the byte-identical low-level form interactions; this module adds the
 * higher-level "get me a signed-in owner/admin session" wrappers on top, shared by every file
 * under `00-gates/` and `journeys/`.
 */

export const OWNER_API_KEY = process.env.WEB_E2E_API_KEY;
export const ADMIN_LOGIN = process.env.WEB_E2E_ADMIN_LOGIN;
export const ADMIN_INITIAL_PASSWORD = process.env.WEB_E2E_ADMIN_INITIAL_PASSWORD;

/** Workspace owner, apiKey session — same shape as every existing spec's own `login()` helper
 *  (chat.spec.ts, governance.spec.ts, …). */
export async function loginAsOwner(
  page: Page,
  apiKey: string = OWNER_API_KEY as string,
): Promise<void> {
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithApiKey(page, apiKey);
}

/**
 * Platform administrator, cookie session — copied from workspaces.spec.ts's `signInAsAdmin`
 * (identical reasoning: tolerate both "still on the kernel-issued initial temporary password" and
 * "already forced through a change by an earlier attempt/run" so a CI retry of a gate test is
 * idempotent). `00-gates/` runs before every other spec file (its directory is prefixed `00-` on
 * purpose — see that directory's own README/doc comment), so in an un-retried run `admin` is
 * always still on its initial password here; the fallback exists only for a retried gate test.
 */
export async function loginAsAdmin(
  page: Page,
  login: string = ADMIN_LOGIN as string,
  initialPassword: string = ADMIN_INITIAL_PASSWORD as string,
): Promise<void> {
  const changedPassword = `${initialPassword}-changed`;
  const changePasswordHeading = page.getByRole('heading', { name: /Password change required/ });
  const shell = page.getByTestId('nav-platformWorkspaces');
  const badCredentials = page.getByText('登录名或密码不正确');

  await page.goto('/');
  await reachLoginForm(page);
  await loginWithPassword(page, login, initialPassword);
  await expect(changePasswordHeading.or(shell).or(badCredentials).first()).toBeVisible({
    timeout: 15_000,
  });

  if (await badCredentials.isVisible().catch(() => false)) {
    await page.getByLabel(/密码 Password/).fill(changedPassword);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(changePasswordHeading.or(shell).first()).toBeVisible({ timeout: 15_000 });
  }

  if (await changePasswordHeading.isVisible().catch(() => false)) {
    await page.getByLabel(/当前密码 Current password/).fill(initialPassword);
    await page.getByLabel(/新密码 New password/).fill(changedPassword);
    await page.getByLabel(/确认新密码 Confirm new password/).fill(changedPassword);
    await page.getByRole('button', { name: /Change password/ }).click();
  }

  await expect(shell).toBeVisible({ timeout: 15_000 });
}
