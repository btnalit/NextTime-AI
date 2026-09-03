import { expect, test } from '@playwright/test';

/**
 * e2e/approvals.spec.ts: the S2.10 acceptance flow (docs/development-tasks.md S2.10: "卡片出现 →
 * 批准 → 状态更新 → 对话里出现更新；用户 B 的界面看不到 A 的卡片；把 B 授予该动作范围后，卡片出现在 B
 * 自己的对话与队列里并可批准，A 的对话里只显示状态"). Opt-in only, same convention as
 * `e2e/chat.spec.ts` — `pnpm --filter @nexttime/web e2e`, never `pnpm test`/CI.
 *
 * Unlike chat.spec.ts, this suite needs a *pending ActionRequest* already sitting in the database
 * before it runs — S2.10 owns `packages/web` only, not a capability that can conjure one from a
 * bare API key (a real one requires a real, reachable Gatekeeper, S2.13 scope). See this package's
 * README.md "端到端测试（Playwright）" section for the exact `psql` commands the *main session* runs
 * once before each of the two tests below — they must use the literal `resource_scope` markers
 * this file also hardcodes (`E2E_APPROVE_SCOPE` / `E2E_ISOLATION_SCOPE`) so each test can find its
 * own row unambiguously even if a previous run's (now-decided) rows are still present.
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_API_KEY` (workspace owner — `grant_capability` is
 * `minRole:'owner'`), `WEB_E2E_API_KEY_B` (a second principal, role `operator` — `list_pending`/
 * `approve` are `minRole:'operator'`), and a kernel started `AGENT_RUNTIME=fake` (unused by this
 * suite directly, but S1.8's own convention — see chat.spec.ts).
 */

const API_KEY = process.env.WEB_E2E_API_KEY;
const API_KEY_B = process.env.WEB_E2E_API_KEY_B;

/** Must match the `resource_scope` the README's seed commands are given for each scenario. */
const E2E_APPROVE_SCOPE = 'e2e-approve-flow';
const E2E_ISOLATION_SCOPE = 'e2e-isolation-flow';
const E2E_ACTION_KIND = 'e2e.approval_card_test';

async function login(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('sk-...').fill(apiKey);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/#\/chats$/, { timeout: 15_000 });
}

/** Locates the inline chat card (or status-only line) whose scope text contains `marker` —
 *  resilient to other pending/decided rows from earlier runs coexisting on the page. */
function cardByMarker(page: import('@playwright/test').Page, marker: string) {
  return page.locator('.action-card', { hasText: marker }).first();
}

/** The Approvals page lists requests as rows (`data-testid="approval-row"`, components/
 *  ApprovalQueuePage.tsx); the decision controls live in the drawer that opens on selection. */
function queueRowByMarker(page: import('@playwright/test').Page, marker: string) {
  return page.getByTestId('approval-row').filter({ hasText: marker }).first();
}

async function openQueueRow(page: import('@playwright/test').Page, marker: string) {
  await queueRowByMarker(page, marker).click();
  const drawer = page.getByTestId('approval-drawer');
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('S2.10 acceptance: approval card -> approve -> status update', () => {
  test.skip(
    !API_KEY,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY, and seed a pending ActionRequest (see README.md) to run this suite',
  );

  test('card appears in the approval queue, approving it there updates the chat card in place and adds a status line', async ({
    page,
  }) => {
    const apiKey = API_KEY as string; // guarded by test.skip above
    await login(page, apiKey);

    // --- approval queue: the seeded request is a row; selecting it opens the drawer with
    //     Approve / Reject / "Always allow" ---
    await page.goto('/#/approvals');
    await expect(queueRowByMarker(page, E2E_APPROVE_SCOPE)).toBeVisible({ timeout: 15_000 });
    const drawer = await openQueueRow(page, E2E_APPROVE_SCOPE);
    await expect(drawer.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(drawer.getByRole('checkbox', { name: /Always allow/ })).toBeVisible();

    // --- approve from the drawer; the row leaves the Pending tab optimistically and
    //     `list_pending` (pending rows only) confirms it on reconcile — the durable record of
    //     "this card, now decided" lives in the chat instead, checked below ---
    await drawer.getByRole('button', { name: 'Approve' }).click();
    await expect(queueRowByMarker(page, E2E_APPROVE_SCOPE)).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');

    // --- the same holder's chat (application/linkage writes to "the most recently created Chat")
    //     shows the *original* system.action_pending card with its buttons now gone (live
    //     `action.updated` push updating it in place, ChatPage.tsx `actionStatusOverrides`) and a
    //     new compact system.action_update status line ---
    await page.goto('/#/chats');
    await page.locator('.chat-list-item').first().click();
    const chatCard = cardByMarker(page, E2E_APPROVE_SCOPE);
    await expect(chatCard).toBeVisible({ timeout: 15_000 });
    // The status chip carries the raw kernel state in `data-status` (components/ui/StatusChip.tsx)
    // and a human label as text — assert on the state, not the label.
    await expect(chatCard.locator('.action-card-status')).toHaveAttribute(
      'data-status',
      'approved',
      { timeout: 15_000 },
    );
    await expect(chatCard.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(
      page.locator('.system-status-line').filter({ has: page.locator('[data-status="approved"]') }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('S2.10 acceptance: holder isolation (G4) — B cannot see or act on A’s card until granted', () => {
  test.skip(
    !API_KEY || !API_KEY_B,
    'set WEB_E2E_API_KEY and WEB_E2E_API_KEY_B, and seed a second pending ActionRequest (see README.md) to run this suite',
  );

  test("B's queue is empty for A's ActionRequest until grant_capability, then B can approve it", async ({
    page,
    request,
  }) => {
    const apiKeyA = API_KEY as string;
    const apiKeyB = API_KEY_B as string;

    // --- A sees the row (isHolder: true — A is on_behalf_of and the sole initial holder) ---
    await login(page, apiKeyA);
    await page.goto('/#/approvals');
    await expect(queueRowByMarker(page, E2E_ISOLATION_SCOPE)).toBeVisible({ timeout: 15_000 });

    // --- B does not: neither the queue nor B's chat mentions this ActionRequest at all (§8.5 —
    //     an unrelated principal is not even in the requester/holder target set). Wait for the
    //     queue to settle (empty state or a list) before asserting absence. ---
    await login(page, apiKeyB);
    await page.goto('/#/approvals');
    await expect(
      page.getByTestId('approvals-empty').or(page.getByTestId('approvals-list')),
    ).toBeVisible({ timeout: 15_000 });
    await expect(queueRowByMarker(page, E2E_ISOLATION_SCOPE)).toHaveCount(0);

    // --- A grants B the matching action_kind scope (grant_capability, minRole:'owner' — done via
    //     a direct capability call, same HTTP contract the web app itself uses, since this PR does
    //     not ship a grant_capability UI — out of scope, see "Must NOT"). B's own principal id is
    //     not exposed by any capability call this test has made (every human-channel capability is
    //     scoped to the caller, and `get_action`/`list_pending` never echo it back either) — it is
    //     environment-provided, the same way a runbook would ask for it. ---
    const principalIdB = process.env.WEB_E2E_PRINCIPAL_ID_B;
    if (!principalIdB) {
      throw new Error(
        'set WEB_E2E_PRINCIPAL_ID_B (see README.md) — this test needs B’s principal id for grant_capability',
      );
    }

    const grantResponse = await request.post('/api/cap/grant_capability', {
      headers: { authorization: `Bearer ${apiKeyA}` },
      data: { principalId: principalIdB, capability: E2E_ACTION_KIND, scope: {} },
    });
    expect(grantResponse.ok()).toBe(true);

    // --- B's queue now shows it, and B can approve; the card leaves B's queue once decided (same
    //     reasoning as the first test above — `list_pending` only lists `pending_approval` rows) ---
    await page.goto('/#/approvals');
    await expect(queueRowByMarker(page, E2E_ISOLATION_SCOPE)).toBeVisible({ timeout: 15_000 });
    const drawerForB = await openQueueRow(page, E2E_ISOLATION_SCOPE);
    await drawerForB.getByRole('button', { name: 'Approve' }).click();
    await expect(queueRowByMarker(page, E2E_ISOLATION_SCOPE)).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');

    // --- A's chat shows only the status update, never Approve/Reject buttons for a decision B
    //     (not A) made — the original card A saw transitions to decided in place ---
    await login(page, apiKeyA);
    await page.goto('/#/chats');
    await page.locator('.chat-list-item').first().click();
    const chatCardForA = cardByMarker(page, E2E_ISOLATION_SCOPE);
    await expect(chatCardForA).toBeVisible({ timeout: 15_000 });
    await expect(chatCardForA.locator('.action-card-status')).toHaveAttribute(
      'data-status',
      'approved',
      { timeout: 15_000 },
    );
    await expect(chatCardForA.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  });
});
