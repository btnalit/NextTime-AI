import { expect, test } from '@playwright/test';
import { loginWithApiKey, reachLoginForm } from './auth-helpers.js';

/**
 * e2e/approvals.spec.ts: the S2.10 acceptance flow (docs/development-tasks.md S2.10: "卡片出现 →
 * 批准 → 状态更新 → 对话里出现更新；用户 B 的界面看不到 A 的卡片；把 B 授予该动作范围后，卡片出现在 B
 * 自己的对话与队列里并可批准，A 的对话里只显示状态"). Opt-in only, same convention as
 * `e2e/chat.spec.ts` — `pnpm --filter @nexttime/web e2e`, never `pnpm test`/CI's `quality`/`test`
 * jobs.
 *
 * Unlike chat.spec.ts, this suite needs a *pending ActionRequest* already sitting in the database
 * before it runs — S2.10 owns `packages/web` only, not a capability that can conjure one from a
 * bare API key (a real one requires a real, reachable Gatekeeper, S2.13 scope). See this package's
 * README.md "端到端测试（Playwright）" section for the exact `psql` commands the *main session* runs
 * once before each of the two tests below. The approve flow's row uses the literal
 * `resource_scope` marker this file hardcodes (`E2E_APPROVE_SCOPE`); the isolation row is scoped to
 * its own gate like a real `request_action` (R-26 / D-14: the owner can only grant B a gate, and
 * I14 matches a gate grant against `resource_scope`), and that gate id arrives as
 * `WEB_E2E_ISOLATION_GATEKEEPER_ID`. Each test can then find its own row unambiguously even if a
 * previous run's (now-decided) rows are still present.
 *
 * `WEB_E2E_SEED_ACTION_REQUESTS=1` gates both scenarios below, in addition to their own API-key
 * checks — `.github/workflows/e2e.yml` now sets it: the workflow creates the second (operator)
 * principal and seeds both rows itself, running the same `psql` block as this package's README
 * against the CI postgres container, so both scenarios run in CI. Set this locally once you have
 * run the `psql` seed block(s) below (and, for the isolation scenario, created a second
 * principal) — the manual local setup is unchanged.
 *
 * Requires: `WEB_E2E_BASE_URL`, `WEB_E2E_API_KEY` (workspace owner — `grant_capability` is
 * `minRole:'owner'`), `WEB_E2E_API_KEY_B` (a second principal, role `operator` — `list_pending`/
 * `approve` are `minRole:'operator'`), and a kernel started `AGENT_RUNTIME=fake` (unused by this
 * suite directly, but S1.8's own convention — see chat.spec.ts).
 */

const API_KEY = process.env.WEB_E2E_API_KEY;
const API_KEY_B = process.env.WEB_E2E_API_KEY_B;
const SEED_ACTION_REQUESTS = process.env.WEB_E2E_SEED_ACTION_REQUESTS === '1';

/** Must match the `resource_scope` the README's seed commands are given for the approve flow. */
const E2E_APPROVE_SCOPE = 'e2e-approve-flow';
/** The isolation row's gate — also its `resource_scope`, so it is the text its chat card shows and
 *  its queue row's `data-gatekeeper-id` (the queue no longer prints a gate-scoped scope as text,
 *  L8a-10) (README "Seeding a pending ActionRequest"; `.github/workflows/e2e.yml` exports it). */
const E2E_ISOLATION_GATEKEEPER_ID = process.env.WEB_E2E_ISOLATION_GATEKEEPER_ID;

async function login(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.goto('/');
  // The isolation scenario below signs in as A, then B, then A again in the *same tab*. A previous
  // login survives in `sessionStorage` (`lib/session.ts`) and App.tsx auto-connects with it on
  // load, so `reachLoginForm` (e2e/auth-helpers.ts) may first resolve to `'shell'` rather than
  // `'login'` — sign the old session out through the product's own "清除密钥 / Forget key" (S8 W3
  // F1: now routed through `t()`, zh-CN default) button (clearing storage under an in-flight
  // connect is not enough — `connectApiKey()` re-saves the key once the WS authenticate resolves)
  // and re-resolve.
  if ((await reachLoginForm(page)) === 'shell') {
    await page.getByRole('button', { name: '清除密钥' }).click();
    await reachLoginForm(page);
  }
  await loginWithApiKey(page, apiKey);
  // Not a URL/hash assertion: a bare `/` load has no `location.hash` at all, and
  // `lib/router.ts`'s `routeFromHash('')` resolves straight to the default `chats` route without
  // ever calling `navigate()` (only a stray `#/login` hash triggers App.tsx's own redirect
  // effect) — so the URL stays hash-less through and after login (verified against a live kernel
  // via `.github/workflows/e2e.yml`; this suite's own stale `#/chats` assertion here predated
  // that and was never actually run). `loginWithApiKey` already waits on the signed-in shell's
  // connection indicator as the reliable "we're past the login screen" signal.
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

/** L8a-10: a gate-scoped request's queue row shows the gate by name, not its id — found by the
 *  row's `data-gatekeeper-id` attribute instead of visible text. */
function queueRowByGate(page: import('@playwright/test').Page, gatekeeperId: string) {
  return page
    .getByTestId('approval-row')
    .filter({ has: page.locator(`[data-gatekeeper-id="${gatekeeperId}"]`) })
    .first();
}

async function openQueueRow(page: import('@playwright/test').Page, marker: string) {
  // A plain centre click: console redesign P3-4 (V6) made the whole row a `kit/list-row` button
  // with no nested interactive element (the old `DataRow`'s meta-line `RefChip` copy button — the
  // reason a click here used to have to target `.data-row-title` specifically — is gone; the row
  // shows plain text, not chips). `data-testid="approval-drawer"` is the detail pane on a wide
  // viewport (≥1180px, this suite's default) or the sheet's content on a narrower one — either
  // way it opens on selection.
  return openRow(page, queueRowByMarker(page, marker));
}

async function openRow(
  page: import('@playwright/test').Page,
  row: ReturnType<typeof queueRowByMarker>,
) {
  await row.click();
  const drawer = page.getByTestId('approval-drawer');
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('S2.10 acceptance: approval card -> approve -> status update', () => {
  test.skip(
    !API_KEY || !SEED_ACTION_REQUESTS,
    'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY, seed a pending ActionRequest (see README.md), and set WEB_E2E_SEED_ACTION_REQUESTS=1 to run this suite',
  );

  test('card appears in the approval queue, approving it there updates the chat card in place and adds a status line', async ({
    page,
  }) => {
    const apiKey = API_KEY as string; // guarded by test.skip above
    await login(page, apiKey);

    // --- approval queue: the seeded request is a row; selecting it opens the drawer with
    //     Approve / Reject / "Always allow" ---
    await page.goto('/#/work/approvals');
    await expect(queueRowByMarker(page, E2E_APPROVE_SCOPE)).toBeVisible({ timeout: 15_000 });
    const drawer = await openQueueRow(page, E2E_APPROVE_SCOPE);
    await expect(drawer.getByRole('button', { name: '批准' })).toBeVisible();
    await expect(drawer.getByRole('checkbox', { name: /总是允许/ })).toBeVisible();

    // --- approve from the drawer; the row leaves the Pending tab optimistically and
    //     `list_pending` (pending rows only) confirms it on reconcile — the durable record of
    //     "this card, now decided" lives in the chat instead, checked below ---
    await drawer.getByRole('button', { name: '批准' }).click();
    await expect(queueRowByMarker(page, E2E_APPROVE_SCOPE)).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');

    // --- the same holder's chat (application/linkage writes to "the most recently created Chat")
    //     shows the *original* system.action_pending card with its buttons now gone (live
    //     `action.updated` push updating it in place, ChatPage.tsx `actionStatusOverrides`) and a
    //     new compact system.action_update status line ---
    await page.goto('/#/work/chats');
    await page.locator('.chat-row-item').first().click();
    const chatCard = cardByMarker(page, E2E_APPROVE_SCOPE);
    await expect(chatCard).toBeVisible({ timeout: 15_000 });
    // The status chip carries the raw kernel state in `data-status` (components/ui/StatusChip.tsx)
    // and a human label as text — assert on the state, not the label. The seeded row's
    // Gatekeeper is a bare `objects` row with no reachable endpoint, so right after `approved`
    // the kernel's own drainer tries to execute it and marks it `failed` — any post-decision
    // state proves the card left `pending_approval`; the `approved` status line below is the
    // durable record of the decision itself.
    await expect(chatCard.locator('.action-card-status')).toHaveAttribute(
      'data-status',
      /^(approved|executing|executed|failed)$/,
      { timeout: 15_000 },
    );
    await expect(chatCard.getByRole('button', { name: '批准' })).toHaveCount(0);
    // By test id, not the `.system-status-line` class: the chat card's own outcome row
    // (ActionRequestCard.tsx `action-outcome`) reuses that class and carries `data-status` itself,
    // so while the card sits on `approved` the class locator matches both (strict-mode violation).
    await expect(
      page
        .getByTestId('system-status-line')
        .filter({ has: page.locator('[data-status="approved"]') }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('S2.10 acceptance: holder isolation (G4) — B cannot see or act on A’s card until granted', () => {
  test.skip(
    !API_KEY || !API_KEY_B || !SEED_ACTION_REQUESTS || !E2E_ISOLATION_GATEKEEPER_ID,
    'set WEB_E2E_API_KEY and WEB_E2E_API_KEY_B, seed a second pending ActionRequest scoped to its own gate and set WEB_E2E_ISOLATION_GATEKEEPER_ID to that gate (see README.md), and set WEB_E2E_SEED_ACTION_REQUESTS=1 to run this suite',
  );

  test("B's queue is empty for A's ActionRequest until grant_capability, then B can approve it", async ({
    page,
    request,
  }) => {
    const apiKeyA = API_KEY as string;
    const apiKeyB = API_KEY_B as string;
    const isolationGate = E2E_ISOLATION_GATEKEEPER_ID as string;

    // --- A sees the row (isHolder: true — A is on_behalf_of and the sole initial holder) ---
    await login(page, apiKeyA);
    await page.goto('/#/work/approvals');
    await expect(queueRowByGate(page, isolationGate)).toBeVisible({ timeout: 15_000 });

    // --- B does not: neither the queue nor B's chat mentions this ActionRequest at all (§8.5 —
    //     an unrelated principal is not even in the requester/holder target set). Wait for the
    //     queue to settle (empty state or a list) before asserting absence. ---
    await login(page, apiKeyB);
    await page.goto('/#/work/approvals');
    await expect(
      page.getByTestId('approvals-empty').or(page.getByTestId('approvals-list')),
    ).toBeVisible({ timeout: 15_000 });
    await expect(queueRowByGate(page, isolationGate)).toHaveCount(0);

    // --- A grants B the request's gate (grant_capability, minRole:'owner' — done via a direct
    //     capability call, the same HTTP contract the console's own per-gate grant form uses).
    //     B's own principal id is not exposed by any capability call this test has made (every
    //     human-channel capability is scoped to the caller, and `get_action`/`list_pending` never
    //     echo it back either) — it is environment-provided, the same way a runbook would ask for
    //     it. ---
    const principalIdB = process.env.WEB_E2E_PRINCIPAL_ID_B;
    if (!principalIdB) {
      throw new Error(
        'set WEB_E2E_PRINCIPAL_ID_B (see README.md) — this test needs B’s principal id for grant_capability',
      );
    }

    const grantResponse = await request.post('/api/cap/grant_capability', {
      headers: { authorization: `Bearer ${apiKeyA}` },
      // `grant_capability` takes only a per-gate grant, `{principalId, resourceType: 'gatekeeper',
      // resourceId}` (packages/shared capabilities.ts, R-26 / D-14). A gate grant satisfies I14
      // for any action kind on a request whose `resource_scope` is that gate — exactly what I14
      // holder routing (governance/approval/routing.ts) and `list_pending` match.
      data: { principalId: principalIdB, resourceType: 'gatekeeper', resourceId: isolationGate },
    });
    expect(grantResponse.ok()).toBe(true);

    // --- B's queue now shows it, and B can approve; the card leaves B's queue once decided (same
    //     reasoning as the first test above — `list_pending` only lists `pending_approval` rows).
    //     A full reload, not another hash `goto`: the tab is already on `#/work/approvals`, so a
    //     same-hash navigation is a no-op for the SPA and `useCapability`'s cached (empty)
    //     `list_pending` page would stay on screen — a grant made out of band reaches an open
    //     queue only through the user's own Refresh/reload, exactly what a real operator does. ---
    await page.reload();
    await expect(queueRowByGate(page, isolationGate)).toBeVisible({ timeout: 15_000 });
    const drawerForB = await openRow(page, queueRowByGate(page, isolationGate));
    await drawerForB.getByRole('button', { name: '批准' }).click();
    await expect(queueRowByGate(page, isolationGate)).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');

    // --- A's chat shows only the status update, never Approve/Reject buttons for a decision B
    //     (not A) made — the original card A saw transitions to decided in place ---
    await login(page, apiKeyA);
    await page.goto('/#/work/chats');
    await page.locator('.chat-row-item').first().click();
    const chatCardForA = cardByMarker(page, isolationGate);
    await expect(chatCardForA).toBeVisible({ timeout: 15_000 });
    // Same post-decision reasoning as the first scenario: the seeded Gatekeeper cannot execute.
    await expect(chatCardForA.locator('.action-card-status')).toHaveAttribute(
      'data-status',
      /^(approved|executing|executed|failed)$/,
      { timeout: 15_000 },
    );
    await expect(chatCardForA.getByRole('button', { name: '批准' })).toHaveCount(0);
  });
});
