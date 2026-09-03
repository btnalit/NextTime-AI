import { expect, test } from '@playwright/test';

/**
 * e2e/chat.spec.ts: the S1.8 acceptance flow (docs/development-tasks.md S1.8: "Playwright：登录 →
 * 新对话 → 发消息 → 看到流式回复 → 刷新后历史完整"). Opt-in only — `pnpm --filter @nexttime/web e2e`
 * (never `pnpm test`/CI, which has no browser and no kernel; see README.md). Requires a kernel
 * reachable through `WEB_E2E_BASE_URL` started with `AGENT_RUNTIME=fake`
 * (packages/kernel/src/application/host-bridge/fake-runtime.ts echoes the prompt back as
 * `echo: <prompt>`, deterministically — this suite depends on that exact reply shape) and a valid
 * `WEB_E2E_API_KEY` for that kernel's workspace.
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

test.describe('S1.8 acceptance: login -> new chat -> send -> streamed reply -> reload -> full history', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('the full flow', async ({ page }) => {
    const apiKey = API_KEY as string; // guarded by test.skip above

    // --- login ---
    await page.goto('/');
    await page.getByPlaceholder('sk-...').fill(apiKey);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // --- chat list: new chat ---
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
    await page.getByRole('button', { name: 'New chat' }).click();

    // --- chat page: send a message (the header's back control is an icon button) ---
    await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible();
    const prompt = `e2e-${Date.now()}`;
    await page.getByPlaceholder('Message…').fill(prompt);
    await page.getByRole('button', { name: 'Send' }).click();

    // --- the product shell is up: sidebar connection indicator reads Connected ---
    await expect(page.getByTestId('ws-status')).toHaveText('Connected');

    // --- see the streamed reply settle (fake runtime: "echo: <prompt>") ---
    const expectedReply = `echo: ${prompt}`;
    await expect(page.locator('.turn-badge')).toHaveText('Turn completed', { timeout: 15_000 });
    // `.message-user .message-text` / `.message-assistant .message-text`: the bubble element
    // carries both classes (components/ChatPage.tsx `renderMessage`) — stable across the redesign.
    await expect(page.locator('.message-user .message-text')).toHaveText(prompt);
    await expect(page.locator('.message-assistant .message-text')).toHaveText(expectedReply);

    // --- reload: full history restored ---
    await page.reload();
    await expect(page.locator('.message-user .message-text')).toHaveText(prompt);
    await expect(page.locator('.message-assistant .message-text')).toHaveText(expectedReply);
  });
});
