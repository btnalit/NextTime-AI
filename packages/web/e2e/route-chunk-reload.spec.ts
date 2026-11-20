import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';
import { expect, test } from './lib/test.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * e2e/route-chunk-reload.spec.ts — legacy 880. In run 44639456651 kernel-restart.spec.ts failed
 * twice the same way: the kernel answered `new_chat`, but the chat page never appeared — the page
 * area said 「页面加载失败」. The trace showed why: the chat page's script chunk was fetched just as
 * Chromium noticed the network change docker made recreating the kernel container, and every
 * request in flight failed with `net::ERR_NETWORK_CHANGED`. The browser keeps a failed module for
 * the page's lifetime, so nothing short of a reload brings that page back (lib/chunk-reload.ts).
 *
 * Here the chat page's chunk fails once, on purpose, the way it did there: the page reloads by
 * itself, once, and the new chat opens — no 「刷新页面」 for the person to find. A reload must not
 * cost a draft: the second case fails the one chunk a page loads while open (the chat's Markdown)
 * with an unsent draft in the composer — the reply shows as plain text, the page stays, the draft
 * is still there.
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

test('a page script that fails to load once: the page reloads by itself and opens', async ({
  page,
}) => {
  test.skip(!API_KEY, 'set WEB_E2E_API_KEY');
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithApiKey(page, API_KEY as string);
  await expect(page.getByRole('heading', { name: '对话' })).toBeVisible();

  // The built chunk is `assets/ChatPage-<hash>.js`; a dev server serves `src/components/ChatPage.tsx`.
  let aborted = 0;
  await page.route(/\/ChatPage[-.][^/]*$/, async (route) => {
    if (aborted === 0) {
      aborted += 1;
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });
  let loads = 0;
  page.on('load', () => {
    loads += 1;
  });

  await page.locator('header').getByRole('button', { name: '新对话' }).click();
  await expect(page.getByRole('button', { name: '返回对话列表' })).toBeVisible();
  await expect(page.getByTestId('route-load-error')).toHaveCount(0);
  expect(aborted).toBe(1);
  expect(loads).toBe(1);
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'connected');
});

test('the chat’s Markdown failing to load with a draft in the composer: no reload, the draft stays', async ({
  page,
}) => {
  test.skip(!API_KEY, 'set WEB_E2E_API_KEY');
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithApiKey(page, API_KEY as string);
  await page.locator('header').getByRole('button', { name: '新对话' }).click();
  await expect(page.getByRole('button', { name: '返回对话列表' })).toBeVisible();

  // Held until the draft is typed, then failed: the draft is in the composer when it fails.
  let draftTyped: () => void = () => {};
  const typed = new Promise<void>((resolve) => {
    draftTyped = resolve;
  });
  let aborted = 0;
  // Built: `assets/markdown-<hash>.js`; dev server: `src/components/kit/markdown.tsx`.
  await page.route(/\/markdown[-.][^/]*$/, async (route) => {
    await typed;
    aborted += 1;
    await route.abort('internetdisconnected');
  });
  let loads = 0;
  page.on('load', () => {
    loads += 1;
  });

  const prompt = `chunk-draft-${Date.now()}`;
  const composer = page.getByPlaceholder('输入消息…');
  await composer.fill(prompt);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.message-user .message-text').last()).toHaveText(prompt);
  // The reply shows as raw text while its Markdown chunk is held (MessageBody's Suspense
  // fallback); the composer opens again once the turn ends.
  await expect(page.locator('.message-assistant .message-text').last()).toHaveText(
    new RegExp(`^echo: <!--nexttime:turn_id=[^>]+-->\\n${escapeRegExp(prompt)}$`),
    { timeout: 20_000 },
  );
  const draft = `unsent-${Date.now()}`;
  await composer.fill(draft);
  draftTyped();

  await expect.poll(() => aborted).toBe(1);
  await expect(page.locator('[data-markdown="unavailable"]').last()).toBeVisible();
  await expect(composer).toHaveValue(draft);
  await expect(page.getByTestId('route-load-error')).toHaveCount(0);
  expect(loads).toBe(0);
});
