import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loginWithApiKey, loginWithPassword, reachLoginForm } from '../auth-helpers.js';
import { type Page, expect, test } from '../lib/test.js';

/**
 * e2e/resilience/network-and-switch.spec.ts — batch C3 (docs/test-coverage-gaps-2026-11-06.md
 * §5.4, gap G2 scenarios ② and ③): the network under an open page goes quiet, and a workspace
 * switch lands in a kernel outage. Same rule as kernel-restart.spec.ts: the page recovers or says
 * so, never goes quietly dead — and a write it reported as failed is not done twice.
 *
 * ② `E2E_CUT_NETWORK_CMD on|off` (.github/workflows/e2e.yml) drops every packet of every
 * connection to caddy, both ways, established ones included: no RST, no FIN, the way a laptop's
 * Wi-Fi or a VPN drops. Chromium's `setOffline` does not do this — it leaves an open WebSocket
 * working — so the cut happens below the browser. Before legacy 672 / 673 the connection line said
 * 已连接 for the whole cut, the send into it failed after the RPC deadline with 「检查网络后重试」,
 * and the request that timed out still ran once the network came back (on TCP's next
 * retransmission, tens of seconds later) — so pressing send again made a second, identical turn.
 * Now: the heartbeat (ws-client.ts) notices the dead socket and the line says 重连中; the send's
 * note says it may or may not have gone out and keeps the draft; once the network is back the page
 * reconnects by itself, 「再发一次」 sends the same message under the same idempotency key, and the
 * kernel holds the prompt once however the late request and the second try land — read from
 * outside the page once the late request has had its window.
 *
 * ③ The kernel stops (`E2E_STOP_KERNEL_CMD`) under a cookie session that belongs to two
 * workspaces (the CI owner, added as an owner of `ci-e2e-switch` — `E2E_SWITCH_WORKSPACE_CMD`
 * creates it when this case runs, last, so no spec before it sees it, and prints its owner's key),
 * and the person switches workspace.
 * On 主机 this was legacy 649: an upgrade under an open page, then a switch that did nothing. The
 * page must say it stayed where it was and offer a way in (R-64, #1003), and once the kernel is
 * back that way in must work — the first write in the new workspace included.
 */

const CUT_NETWORK = process.env.E2E_CUT_NETWORK_CMD;
const STOP_KERNEL = process.env.E2E_STOP_KERNEL_CMD;
const RESTART_KERNEL = process.env.E2E_RESTART_KERNEL_CMD;
const API_KEY = process.env.WEB_E2E_API_KEY;
const SWITCH_WORKSPACE = process.env.E2E_SWITCH_WORKSPACE_CMD;
const OWNER_LOGIN = process.env.WEB_E2E_OWNER_LOGIN;
const OWNER_PASSWORD = process.env.WEB_E2E_OWNER_PASSWORD;

/** ws-client.ts `DEFAULT_RPC_TIMEOUT_MS` (30 s) plus slack for the page to render the alert. */
const RPC_DEADLINE_MS = 45_000;
/** How long after the network is back a request stuck on the quiet socket can take to arrive:
 *  TCP's retransmission backoff, not the page's (~25 s seen on the CI stack). */
const LATE_DELIVERY_MS = 90_000;
/** As kernel-restart.spec.ts: restart and health wait, then up to the client's capped backoff. */
const RECOVERY_MS = 60_000;
/** Legacy 672 (ws-client.ts): a ping every 15 s, given up after 10 s unanswered — plus slack. */
const HEARTBEAT_MS = 35_000;
/** Legacy 672: after the network is back, the next connect attempt (one gives up after 10 s and
 *  the next follows after the base delay, not backed off) — plus slack. */
const RECONNECT_MS = 30_000;

async function run(script: string, ...args: string[]): Promise<void> {
  await promisify(execFile)('sh', [script, ...args], { timeout: 120_000 });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openNewChat(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '对话' })).toBeVisible();
  await page.locator('header').getByRole('button', { name: '新对话' }).click();
  await expect(page.getByRole('button', { name: '返回对话列表' })).toBeVisible();
}

async function sendAndSeeReply(page: Page, prompt: string): Promise<void> {
  await page.getByPlaceholder('输入消息…').fill(prompt);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.message-user .message-text').last()).toHaveText(prompt);
  await expect(page.locator('.message-assistant .message-text').last()).toHaveText(
    new RegExp(`^echo: <!--nexttime:turn_id=[^>]+-->\\n${escapeRegExp(prompt)}$`),
    { timeout: 20_000 },
  );
}

test.describe('batch C3: an open console page across a network cut and a switch during an outage', () => {
  test.slow();

  test('a silent network cut: the send that timed out says so, keeps the draft, and is never run twice', async ({
    page,
  }) => {
    test.skip(!CUT_NETWORK || !API_KEY, 'set E2E_CUT_NETWORK_CMD and WEB_E2E_API_KEY');
    // The cut runs the RPC deadline out, then waits out TCP's backoff.
    test.setTimeout(240_000);
    await page.goto('/');
    await reachLoginForm(page);
    await loginWithApiKey(page, API_KEY as string);
    await openNewChat(page);
    // A turn before the cut: the chat is open, subscribed and answered — nothing still in flight.
    const before = `cut-before-${Date.now()}`;
    await sendAndSeeReply(page, before);
    const composer = page.getByPlaceholder('输入消息…');
    const users = page.locator('.message-user .message-text');

    const during = `cut-during-${Date.now()}`;
    const status = page.getByTestId('ws-status');
    // Legacy 673: the page cannot know whether a send it got no answer to ran, so it says so.
    const uncertain = page.getByRole('alert').filter({ hasText: '不确定消息发出没有' });
    try {
      await run(CUT_NETWORK as string, 'on');
      await composer.fill(during);
      await page.getByRole('button', { name: '发送' }).click();
      // Legacy 672: the heartbeat notices the dead socket well inside the RPC deadline — the
      // status line stops saying 已连接 while the cut lasts.
      await expect(status).toHaveText('重连中', { timeout: HEARTBEAT_MS });
      // No answer came: the page says the message may or may not have gone out, keeps the draft
      // and does not show the message as sent. It does not ask for a retry.
      await expect(uncertain).toBeVisible({ timeout: RPC_DEADLINE_MS });
      await expect(uncertain).toContainText('可能已经发出，也可能没有');
      await expect(uncertain).not.toContainText('重试');
      await expect(composer).toHaveValue(during);
      await expect(users).toHaveText([before]);
      // 「再发一次」 waits for the connection.
      await expect(uncertain.getByRole('button', { name: '再发一次' })).toBeDisabled();
    } finally {
      // Always restore the network: every step and spec after this one needs it.
      await run(CUT_NETWORK as string, 'off');
    }

    // Legacy 672: the page is back on a new socket soon after the network, without a reload.
    await expect(status).toHaveText('已连接', { timeout: RECONNECT_MS });
    // The obvious next move, and what used to make a second identical turn (legacy 673): send it
    // again. The same idempotency key goes with it, so whether the first request ran (its packets
    // may still arrive late on the old socket) or not, the prompt runs once.
    await expect(uncertain).toBeVisible();
    await uncertain.getByRole('button', { name: '再发一次' }).click();
    await expect(users).toHaveText([before, during], { timeout: LATE_DELIVERY_MS });
    // The message is in the chat, so the note and the draft go by themselves.
    await expect(uncertain).toHaveCount(0);
    await expect(composer).toHaveValue('');
    await expect(page.locator('.message-assistant .message-text')).toHaveCount(2, {
      timeout: 20_000,
    });

    // The page works as before: a new message gets its reply pushed.
    const after = `cut-after-${Date.now()}`;
    await sendAndSeeReply(page, after);
    await expect(status).toHaveText('已连接');
    await expect(users).toHaveText([before, during, after]);

    // From outside the page: the kernel holds the prompt sent into the cut once — a late first
    // request and the second try made one message, not two. A first request still in flight on
    // the old socket gets the rest of its window (~25 s after the network on the CI stack) before
    // this is read: an absence has no event to wait for.
    await page.waitForTimeout(30_000);
    const chatId = decodeURIComponent(new URL(page.url()).hash.split('/').pop() ?? '');
    const history = await page.request.post('/api/cap/get_chat_history', {
      headers: { authorization: `Bearer ${API_KEY}` },
      data: { chatId, limit: 50 },
    });
    const body = (await history.json()) as {
      ok: boolean;
      result?: { items: { role: string; text: string }[] };
    };
    expect(body.ok, JSON.stringify(body)).toBe(true);
    const sentTexts = (body.result?.items ?? [])
      .filter((item) => item.role === 'user')
      .map((item) => item.text);
    expect(sentTexts).toEqual([before, during, after]);
    await expect(users).toHaveText([before, during, after]);
  });

  test('switching workspace while the kernel is down: it says it stayed, and the way in works once the kernel is back', async ({
    page,
  }) => {
    test.skip(
      !STOP_KERNEL || !RESTART_KERNEL || !SWITCH_WORKSPACE || !OWNER_LOGIN || !OWNER_PASSWORD,
      'set E2E_STOP_KERNEL_CMD, E2E_RESTART_KERNEL_CMD, E2E_SWITCH_WORKSPACE_CMD, WEB_E2E_OWNER_LOGIN and WEB_E2E_OWNER_PASSWORD',
    );
    // Setup outside the page: the second workspace (the workflow's script; a retry gets the same
    // one), and the CI owner joins it as an owner (its owner's key, from Node). A retry finds the
    // membership already there.
    const { stdout } = await promisify(execFile)('sh', [SWITCH_WORKSPACE as string], {
      timeout: 120_000,
    });
    const switchKey = stdout.trim();
    expect(switchKey, 'E2E_SWITCH_WORKSPACE_CMD printed a key').not.toBe('');
    const added = await page.request.post('/api/cap/add_member', {
      headers: { authorization: `Bearer ${switchKey}` },
      data: { login: OWNER_LOGIN, role: 'owner' },
    });
    const body = (await added.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok || body.error?.code === 'already_member', JSON.stringify(body)).toBe(true);

    await page.goto('/');
    await reachLoginForm(page);
    await loginWithPassword(page, OWNER_LOGIN as string, OWNER_PASSWORD as string);
    await page.goto('/#/work/chats');
    await expect(page.getByRole('heading', { name: '对话' })).toBeVisible();
    const switcher = page.getByRole('combobox', { name: '切换工作区' });
    await expect(switcher).toBeVisible({ timeout: 15_000 });
    const here = await switcher.inputValue();
    const target = await switcher
      .locator('option', { hasText: 'ci-e2e-switch' })
      .getAttribute('value');
    expect(target ?? '').not.toBe('');
    const status = page.getByTestId('ws-status');
    await expect(status).toHaveAttribute('data-status', 'connected');

    const reloadInto = page.getByRole('button', { name: '刷新页面并进入「ci-e2e-switch」' });
    try {
      await run(STOP_KERNEL as string);
      await expect(status).toHaveText(/重连中|已断开/, { timeout: RECOVERY_MS });
      await switcher.selectOption(target as string);
      // R-64 / legacy 649: it says, in words, that the switch did not happen and where the page
      // still is, and offers the way in — the page is not left looking switched but dead.
      await expect(page.getByText('没能切换到工作区「ci-e2e-switch」')).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText(/仍在当前工作区/)).toBeVisible();
      await expect(reloadInto).toBeVisible();
      await expect(switcher).toHaveValue(here);
    } finally {
      await run(RESTART_KERNEL as string);
    }

    // Back up: the page reconnects in the workspace it stayed in, and the offered way in opens the
    // one asked for — the first write there included.
    await expect(status).toHaveAttribute('data-status', 'connected', { timeout: RECOVERY_MS });
    await expect(status).toHaveText('已连接');
    await reloadInto.click();
    await expect(switcher).toHaveValue(target as string, { timeout: 15_000 });
    await expect(status).toHaveAttribute('data-status', 'connected', { timeout: 15_000 });
    await expect(reloadInto).toHaveCount(0);
    await openNewChat(page);
    await sendAndSeeReply(page, `switch-after-${Date.now()}`);
  });
});
