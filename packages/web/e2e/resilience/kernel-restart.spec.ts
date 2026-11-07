import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loginWithApiKey, loginWithPassword, reachLoginForm } from '../auth-helpers.js';
import { type Page, expect, test } from '../lib/test.js';

/**
 * e2e/resilience/kernel-restart.spec.ts — batch C (docs/test-coverage-gaps-2026-11-06.md §5.4,
 * gaps G2 / G16): a console page left open while the kernel restarts either recovers on its own
 * or says so; it never goes quietly dead. On 主机 an upgrade restarts the kernel under every open
 * browser tab, and green CI had never once exercised that (legacy 649 was found by hand).
 *
 * `E2E_RESTART_KERNEL_CMD` is a script `.github/workflows/e2e.yml` writes: it replaces the
 * kernel container (`--force-recreate`, as an upgrade does) and returns once `/api/health` answers 200 through caddy again. Unset (a local
 * run against a host you did not start yourself) skips the file — restarting someone's kernel is
 * not something a test does by default. playwright.config.ts runs this directory as its own
 * project, after every other one, so no other spec sees the restart.
 *
 * What "recovers" means here, from what a person sees: the sidebar's connection line leaves 已连接
 * while the kernel is down (重连中 / 已断开 — the page does not pretend), comes back to 已连接 by
 * itself, and the next message sent from the same, never-reloaded page gets its reply pushed —
 * the socket re-authenticated and re-subscribed. The cookie case also proves the console session
 * outlives the kernel process (it lives in Postgres, not in memory).
 */

const RESTART_KERNEL = process.env.E2E_RESTART_KERNEL_CMD;
/** Stops the kernel and returns once caddy no longer reaches it (`RESTART_KERNEL` brings it back). */
const STOP_KERNEL = process.env.E2E_STOP_KERNEL_CMD;
/** `<script> <login>`: expires every open console session of that login in Postgres. */
const EXPIRE_SESSIONS = process.env.E2E_EXPIRE_SESSIONS_CMD;
const API_KEY = process.env.WEB_E2E_API_KEY;
const OWNER_LOGIN = process.env.WEB_E2E_OWNER_LOGIN;
const OWNER_PASSWORD = process.env.WEB_E2E_OWNER_PASSWORD;

/** The kernel's restart plus its health wait (~20 s in CI), then up to the client's capped
 *  backoff (≤ 30 s, ws-client.ts `DEFAULT_MAX_RECONNECT_DELAY_MS`) before the page reconnects. */
const RECOVERY_MS = 60_000;

async function run(script: string, ...args: string[]): Promise<void> {
  await promisify(execFile)('sh', [script, ...args], { timeout: 120_000 });
}

async function restartKernel(): Promise<void> {
  await run(RESTART_KERNEL as string);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Sends `prompt` in the open chat and waits for the fake runtime's echo of it (chat.spec.ts's
 *  doc comment: the runtime sees the prompt behind a turn-id marker). */
async function sendAndSeeReply(page: Page, prompt: string): Promise<void> {
  await page.getByPlaceholder('输入消息…').fill(prompt);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.message-user .message-text').last()).toHaveText(prompt);
  await expect(page.locator('.message-assistant .message-text').last()).toHaveText(
    new RegExp(`^echo: <!--nexttime:turn_id=[^>]+-->\\n${escapeRegExp(prompt)}$`),
    { timeout: 20_000 },
  );
}

async function openNewChat(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '对话' })).toBeVisible();
  await page.locator('header').getByRole('button', { name: '新对话' }).click();
  await expect(page.getByRole('button', { name: '返回对话列表' })).toBeVisible();
}

/** Restarts the kernel under the open page: the connection line must leave 已连接 while it is
 *  down, saying so in words, and come back to 已连接 without a reload. */
async function restartUnderOpenPage(page: Page): Promise<void> {
  const status = page.getByTestId('ws-status');
  await expect(status).toHaveAttribute('data-status', 'connected');
  const sawDrop = expect(status).toHaveText(/重连中|已断开/, { timeout: RECOVERY_MS });
  await Promise.all([sawDrop, restartKernel()]);
  await expect(status).toHaveAttribute('data-status', 'connected', { timeout: RECOVERY_MS });
  await expect(status).toHaveText('已连接');
}

test.describe('batch C: an open console page across a kernel restart, an outage and an expired session', () => {
  test.skip(
    !RESTART_KERNEL,
    'set E2E_RESTART_KERNEL_CMD to a script that restarts the kernel and waits for /api/health (.github/workflows/e2e.yml writes one)',
  );
  // Two restarts' worth of waiting is longer than the default 30 s per test.
  test.slow();

  test('API-key session: the chat keeps working, no reload, history intact', async ({ page }) => {
    test.skip(!API_KEY, 'set WEB_E2E_API_KEY');
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithApiKey(page, API_KEY as string);
    await openNewChat(page);

    const before = `resilience-before-${Date.now()}`;
    await sendAndSeeReply(page, before);

    await restartUnderOpenPage(page);

    const after = `resilience-after-${Date.now()}`;
    await sendAndSeeReply(page, after);
    // Both turns, in order, on the same page — the reconnect re-read history without dropping or
    // doubling what was already shown.
    await expect(page.locator('.message-user .message-text')).toHaveText([before, after]);
  });

  test('password (cookie) session: still signed in after the restart, and a new chat works', async ({
    page,
  }) => {
    test.skip(
      !OWNER_LOGIN || !OWNER_PASSWORD,
      'set WEB_E2E_OWNER_LOGIN and WEB_E2E_OWNER_PASSWORD',
    );
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithPassword(page, OWNER_LOGIN as string, OWNER_PASSWORD as string);
    await page.goto('/#/work/chats');
    await expect(page.getByRole('heading', { name: '对话' })).toBeVisible();

    await restartUnderOpenPage(page);

    // The first write after the restart, from the page that was open through it.
    await openNewChat(page);
    await sendAndSeeReply(page, `resilience-cookie-${Date.now()}`);
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
  });

  test('pressing send while the kernel is down: a readable error, the draft kept, one turn after', async ({
    page,
  }) => {
    test.skip(!API_KEY || !STOP_KERNEL, 'set WEB_E2E_API_KEY and E2E_STOP_KERNEL_CMD');
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithApiKey(page, API_KEY as string);
    await openNewChat(page);
    const status = page.getByTestId('ws-status');
    await expect(status).toHaveAttribute('data-status', 'connected');

    try {
      await run(STOP_KERNEL as string);
      await expect(status).toHaveText(/重连中|已断开/, { timeout: RECOVERY_MS });

      // What a person does during an upgrade: types, presses send, and the page has to say why
      // nothing happened — in words — and keep what they typed.
      const prompt = `resilience-while-down-${Date.now()}`;
      const composer = page.getByPlaceholder('输入消息…');
      await composer.fill(prompt);
      await page.getByRole('button', { name: '发送' }).click();
      const outage = page.getByRole('alert').filter({ hasText: '连接已断开' });
      await expect(outage).toBeVisible();
      // Legacy 659: the page reconnects by itself, and a reload is what loses a draft — the alert
      // says it is reconnecting, never to reload.
      await expect(outage).toContainText('页面会自己重新连接');
      await expect(outage).not.toContainText('刷新');
      await expect(composer).toHaveValue(prompt);
      await expect(page.locator('.message-user .message-text')).toHaveCount(0);
    } finally {
      // Always bring the kernel back: every spec and step after this one needs it.
      await restartKernel();
    }

    await expect(status).toHaveAttribute('data-status', 'connected', { timeout: RECOVERY_MS });
    await expect(status).toHaveText('已连接');
    // The same draft, sent again, makes exactly one turn — the refused attempt left nothing behind.
    const prompt = await page.getByPlaceholder('输入消息…').inputValue();
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('.message-user .message-text')).toHaveText([prompt]);
    await expect(page.locator('.message-assistant .message-text').last()).toHaveText(
      new RegExp(`^echo: <!--nexttime:turn_id=[^>]+-->\\n${escapeRegExp(prompt)}$`),
      { timeout: 20_000 },
    );
  });

  test('the console session expires under an open chat: the next send lands on sign-in, not a dead page', async ({
    page,
  }) => {
    test.skip(
      !OWNER_LOGIN || !OWNER_PASSWORD || !EXPIRE_SESSIONS,
      'set WEB_E2E_OWNER_LOGIN, WEB_E2E_OWNER_PASSWORD and E2E_EXPIRE_SESSIONS_CMD',
    );
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithPassword(page, OWNER_LOGIN as string, OWNER_PASSWORD as string);
    await page.goto('/#/work/chats');
    await openNewChat(page);
    await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'connected');

    await run(EXPIRE_SESSIONS as string, OWNER_LOGIN as string);

    // The open socket authenticated before the expiry; the kernel re-checks the session on every
    // call (session-revocation.ts), so this send is refused as unauthorized and the console goes
    // back to sign-in.
    const draft = `resilience-expired-${Date.now()}`;
    await page.getByPlaceholder('输入消息…').fill(draft);
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByTestId('login-submit')).toBeVisible({ timeout: 15_000 });
    // Legacy 658: sign-in says why it is back.
    await expect(page.getByText('会话已过期')).toBeVisible();

    // And signing in again works: an expired session is not a locked account. The same chat
    // opens again (the address survived sign-in) with what was typed still in the box.
    await loginWithPassword(page, OWNER_LOGIN as string, OWNER_PASSWORD as string);
    await expect(page.getByPlaceholder('输入消息…')).toHaveValue(draft, { timeout: 15_000 });
    await expect(page.getByText('会话已过期')).toHaveCount(0);
    await page.goto('/#/work/chats');
    await expect(page.getByRole('heading', { name: '对话' })).toBeVisible();
  });
});
