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
 * working — so the cut happens below the browser. What the page does today, seen on the CI stack:
 * the connection line keeps saying 已连接 for the whole cut (nothing on the socket notices it is
 * dead — legacy 672); a message sent during the cut is answered after the RPC deadline (30 s,
 * ws-client.ts) by a readable 内核没有响应 alert with the draft kept; when the network comes back
 * the request that timed out still reaches the kernel and runs (on TCP's next retransmission, tens
 * of seconds later), while the page keeps the alert and the draft — so the obvious next move,
 * pressing send again, makes a second, identical turn (legacy 673, reproduced by hand on the CI
 * stack). This case pins what is right today and what must hold whatever the fix: the prompt sent
 * into the cut never runs twice unless the person sends it twice, and the page works again
 * without a reload. When 672 / 673 are fixed, their assertions go into this case.
 *
 * ③ The kernel stops (`E2E_STOP_KERNEL_CMD`) under a cookie session that belongs to two
 * workspaces (the CI owner, added as an owner of `ci-e2e-switch` — the workflow creates it and
 * hands this file its owner's key, `WEB_E2E_SWITCH_API_KEY`), and the person switches workspace.
 * On 主机 this was legacy 649: an upgrade under an open page, then a switch that did nothing. The
 * page must say it stayed where it was and offer a way in (R-64, #1003), and once the kernel is
 * back that way in must work — the first write in the new workspace included.
 */

const CUT_NETWORK = process.env.E2E_CUT_NETWORK_CMD;
const STOP_KERNEL = process.env.E2E_STOP_KERNEL_CMD;
const RESTART_KERNEL = process.env.E2E_RESTART_KERNEL_CMD;
const API_KEY = process.env.WEB_E2E_API_KEY;
const SWITCH_API_KEY = process.env.WEB_E2E_SWITCH_API_KEY;
const OWNER_LOGIN = process.env.WEB_E2E_OWNER_LOGIN;
const OWNER_PASSWORD = process.env.WEB_E2E_OWNER_PASSWORD;

/** ws-client.ts `DEFAULT_RPC_TIMEOUT_MS` (30 s) plus slack for the page to render the alert. */
const RPC_DEADLINE_MS = 45_000;
/** How long after the network is back a request stuck on the quiet socket can take to arrive:
 *  TCP's retransmission backoff, not the page's (~25 s seen on the CI stack). */
const LATE_DELIVERY_MS = 90_000;
/** As kernel-restart.spec.ts: restart and health wait, then up to the client's capped backoff. */
const RECOVERY_MS = 60_000;

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
    try {
      await run(CUT_NETWORK as string, 'on');
      await composer.fill(during);
      await page.getByRole('button', { name: '发送' }).click();
      // No answer comes: within the RPC deadline the page says the platform did not respond, in
      // words, and keeps what was typed. It does not show the message as sent.
      const noResponse = page.getByRole('alert').filter({ hasText: '内核没有响应' });
      await expect(noResponse).toBeVisible({ timeout: RPC_DEADLINE_MS });
      await expect(noResponse).toContainText('检查网络后重试');
      await expect(composer).toHaveValue(during);
      await expect(users).toHaveText([before]);
    } finally {
      // Always restore the network: every step and spec after this one needs it.
      await run(CUT_NETWORK as string, 'off');
    }

    // Today (legacy 673) the socket the page kept is the one that went quiet; once TCP's next
    // retransmission gets through (~25 s after the network is back, on the CI stack) the request
    // that timed out reaches the kernel and runs, and the page shows it — with the alert and the
    // draft still up. Waiting for that keeps the next step from racing it; when 673 is fixed, this
    // is where the fixed behaviour is asserted instead.
    await expect(users).toHaveText([before, during], { timeout: LATE_DELIVERY_MS });
    // …and its turn finishes (a send while it runs is refused as turn_already_running).
    await expect(page.locator('.message-assistant .message-text')).toHaveCount(2, {
      timeout: 20_000,
    });

    // The page works again without a reload: a new message gets its reply pushed.
    const after = `cut-after-${Date.now()}`;
    await sendAndSeeReply(page, after);
    await expect(page.getByTestId('ws-status')).toHaveText('已连接');
    // The prompt sent into the cut ran once, never twice: nobody sent a second copy.
    await expect(users).toHaveText([before, during, after]);
  });

  test('switching workspace while the kernel is down: it says it stayed, and the way in works once the kernel is back', async ({
    page,
  }) => {
    test.skip(
      !STOP_KERNEL || !RESTART_KERNEL || !SWITCH_API_KEY || !OWNER_LOGIN || !OWNER_PASSWORD,
      'set E2E_STOP_KERNEL_CMD, E2E_RESTART_KERNEL_CMD, WEB_E2E_SWITCH_API_KEY, WEB_E2E_OWNER_LOGIN and WEB_E2E_OWNER_PASSWORD',
    );
    // Setup outside the page: the CI owner joins `ci-e2e-switch` as an owner (its owner's key, from
    // Node). A retry finds the membership already there.
    const added = await page.request.post('/api/cap/add_member', {
      headers: { authorization: `Bearer ${SWITCH_API_KEY}` },
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
