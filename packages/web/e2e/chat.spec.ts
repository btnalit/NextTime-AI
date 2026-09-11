import { expect, test } from '@playwright/test';
import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/chat.spec.ts: the S1.8 acceptance flow (docs/development-tasks.md S1.8: "Playwright：登录 →
 * 新对话 → 发消息 → 看到流式回复 → 刷新后历史完整"). Opt-in only — `pnpm --filter @nexttime/web e2e`
 * (never `pnpm test`/CI, which has no browser and no kernel; see README.md). Requires a kernel
 * reachable through `WEB_E2E_BASE_URL` started with `AGENT_RUNTIME=fake`
 * (packages/kernel/src/application/host-bridge/fake-runtime.ts echoes back whatever prompt it is
 * handed, deterministically) and a valid `WEB_E2E_API_KEY` for that kernel's workspace.
 *
 * The echoed reply is `echo: <prompt as the runtime received it>`, not `echo: <prompt as typed>`:
 * `application/host-bridge/turn-started-consumer.ts` unconditionally prefixes every prompt with a
 * `<!--nexttime:turn_id=<id>-->\n` marker before calling `startTurn` (that module's own doc
 * comment — the real pi extension strips it back off; `FakeAgentRuntime` has no such extension and
 * echoes it as-is). Verified against a live kernel via `.github/workflows/e2e.yml`.
 */

const API_KEY = process.env.WEB_E2E_API_KEY;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('S1.8 acceptance: login -> new chat -> send -> streamed reply -> reload -> full history', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY to run this suite against a running kernel (see README.md)',
  );

  test('the full flow', async ({ page }) => {
    const apiKey = API_KEY as string; // guarded by test.skip above

    // --- login ---
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithApiKey(page, apiKey);

    // --- chat list: new chat ---
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
    // Scoped to the page `<header>` (components/ui/PageHeader.tsx): a fresh workspace with zero
    // chats also renders a second, identical "New chat" button inside the `chats-empty` state
    // (ChatListPage.tsx reuses the same button element in both places) — an unscoped
    // `getByRole('button', { name: 'New chat' })` matches both and Playwright's strict mode
    // rejects the ambiguity.
    await page.locator('header').getByRole('button', { name: 'New chat' }).click();

    // --- chat page: send a message (the header's back control is an icon button) ---
    await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible();
    const prompt = `e2e-${Date.now()}`;
    await page.getByPlaceholder('Message…').fill(prompt);
    await page.getByRole('button', { name: 'Send' }).click();

    // --- the product shell is up: sidebar connection indicator reads Connected ---
    await expect(page.getByTestId('ws-status')).toHaveText('Connected');

    // --- see the streamed reply settle (fake runtime: "echo: <prompt as the runtime received
    //     it>" — see this file's own doc comment for the turn_id marker prefix) ---
    const expectedReply = new RegExp(
      `^echo: <!--nexttime:turn_id=[^>]+-->\\n${escapeRegExp(prompt)}$`,
    );
    await expect(page.locator('.turn-badge')).toHaveText('Turn completed', { timeout: 15_000 });
    // `.message-user .message-text` / `.message-assistant .message-text`: the bubble element
    // carries both classes (components/ChatPage.tsx `renderMessage`) — stable across the redesign.
    // The user's own displayed message is the prompt as typed — the marker is only ever added to
    // what the runtime receives, never to the persisted/rendered user message.
    await expect(page.locator('.message-user .message-text')).toHaveText(prompt);
    await expect(page.locator('.message-assistant .message-text')).toHaveText(expectedReply);

    // --- reload: full history restored ---
    await page.reload();
    await expect(page.locator('.message-user .message-text')).toHaveText(prompt);
    await expect(page.locator('.message-assistant .message-text')).toHaveText(expectedReply);
  });
});
