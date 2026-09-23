import { expect, test } from '@playwright/test';
import { OWNER_API_KEY, asOwner, goToByLabel } from './helpers.js';

/**
 * Journey ③: 审批一个执行类动作 (development-tasks.md §5e F4; S2.10 acceptance, same underlying
 * capability `approvals.spec.ts` already exercises directly — this file narrates the same
 * capability as a *journey*: what a person actually clicks, by visible label, start to finish)
 *
 * 步骤:
 *   1. 待我审批 队列里出现一张待批准的行（本旅程用两条专属种子行 `e2e-journey3-approve-a`/`-b`，见
 *      `.github/workflows/e2e.yml`"Seed pending ActionRequests" —— 每个视口一条，避免两次跑互相抢
 *      同一行；与 approvals.spec.ts 自己的两条种子行也分开，两个套件不会抢同一行）。
 *   2. 点开这一行，看到动作详情（谁、对什么、blast radius）。
 *   3. 批准。
 *   4. 队列里这一行消失；切到同一页的"历史 History" tab，这一行状态更新为已批准/执行中/已执行/失败
 *      之一（种子 Gatekeeper 没有可达端点，批准后 kernel 自己的执行会失败——这是"批准动作本身成立"
 *      之后的下一段，不是这条旅程的判据）。
 * 状态覆盖:
 *   - 空: 队列为空——governance.spec.ts 已覆盖（"approvals: queue renders, empty state is fine"）。
 *   - 错: 本旅程不覆盖（批准失败的路径——网络错误/并发决定——由 approvals.spec.ts 的 holder-isolation
 *     场景间接覆盖：B 在没有授权时看不到、看不了）。
 *   - 无权限: 本旅程用 owner；`list_pending`/`approve` 的 `minRole:'operator'` 边界由
 *     approvals.spec.ts 的 holder-isolation 场景覆盖，不重复。
 *   - 窄屏: 本文件的第二个 test 在 768px 下重跑同一条旅程——待我审批的行/抽屉在窄屏下仍可点开、
 *     仍可批准。
 * 成功判据:
 *   - 从"待我审批"这个侧栏标签点进去（不是硬编码 `#/work/approvals`），批准一张卡片，卡片从队列消
 *     失且状态可观察地变化——全程只看页面上的可见文字/角色，不读数据库。
 *
 * 今天可以整条走通：kernel 的 approve 能力、ApprovalQueuePage 的队列/历史 tab 都已经是 S2.10/S5.5
 * 起就有的稳定能力——不是 W2/W3 才补的东西，所以这是六条里 F4 点名"如果可行就做成真实通过"的那一条。
 *
 * 为什么第 4 步看"历史 History" tab（同一页），不看对话卡片：早期版本在批准后跳到 对话 页找带这张卡片
 * 的对话，找到了正确的对话，但卡片的 `data-status` 一直卡在 `pending_approval`，即使强制刷新页面也
 * 一样。拉 CI 的数据库快照对比才看清：这张卡片最初的 `system.action_pending` 消息落在种子创建时的那
 * 个对话里，但批准/失败之后写入的 `system.action_update` 消息却落进了*另外*一到两个不同的对话——
 * 同一个 `actionRequestId` 的更新消息分散在多个对话里，`resolveDefaultChat`（"最近一个对话"）在两次
 * 事件处理之间显然解析到了不同的对话。这是内核侧 linkage 的行为，不是这条旅程该踩的坑，也不在这条
 * 车道允许改的文件范围内（`packages/kernel/**` 不在允许列表）——见 PR 说明里的"范围外发现"。
 * ApprovalQueuePage 自己的"历史"tab（`list_action_requests`）在同一页读同一个 `ActionRequest` 的
 * 权威状态，不经过"对话卡片落在哪个对话"这一层，天然绕开了这个问题。
 */

const JOURNEY3_SCOPE_DESKTOP = 'e2e-journey3-approve-a';
const JOURNEY3_SCOPE_NARROW = 'e2e-journey3-approve-b';
const SEED_ACTION_REQUESTS = process.env.WEB_E2E_SEED_ACTION_REQUESTS === '1';

async function runJourney(page: import('@playwright/test').Page, scope: string): Promise<void> {
  await asOwner(page);

  // Step 1+2: navigate by the sidebar's own visible label, not the hash, then open the row.
  // `.press('Enter')`, not `.click()`: `DataRow`'s onClick (components/ui/DataList.tsx) bails out
  // when the click target is inside a `<button>` — this row's `meta` includes a `RefChip`, which
  // renders a copy `<button>` (`components/ui/CopyId.tsx`). At 768px that button can sit under
  // Playwright's default click point (the row's bounding-box centre), silently swallowing the
  // click; the row is a real, focusable, keyboard-activatable list item (`tabIndex`, Enter/Space
  // handling), so pressing Enter after Playwright's own auto-focus sidesteps the ambiguity
  // entirely instead of guessing a click position that dodges the button.
  await goToByLabel(page, '待我审批');
  const row = page.getByTestId('approval-row').filter({ hasText: scope }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.press('Enter');
  const drawer = page.getByTestId('approval-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Approve' })).toBeVisible();

  // Step 3: approve.
  await drawer.getByRole('button', { name: 'Approve' }).click();

  // Step 4: the row leaves the pending queue (still page-local — DataRow's own removal, not proof
  // by itself that the kernel's own approve() persisted); the same page's own 历史 History tab is
  // where the durable, authoritative state lives (`list_action_requests`, unrelated to which Chat
  // any card ended up in — see this file's own doc comment).
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: '历史 History' }).click();
  const historyRow = page.getByTestId('approval-history-row').filter({ hasText: scope }).first();
  await expect(historyRow).toBeVisible({ timeout: 15_000 });
  await expect(historyRow.locator('[data-status]').first()).toHaveAttribute(
    'data-status',
    /^(approved|executing|executed|failed)$/,
    { timeout: 15_000 },
  );
}

test.describe('Journey ③: 审批一个执行类动作', () => {
  test.skip(
    !OWNER_API_KEY || !SEED_ACTION_REQUESTS,
    'set WEB_E2E_BASE_URL, WEB_E2E_API_KEY and WEB_E2E_SEED_ACTION_REQUESTS=1 (see README.md)',
  );

  test('desktop: approve a pending action from the queue, see it in History', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await runJourney(page, JOURNEY3_SCOPE_DESKTOP);
  });

  test('narrow screen (768px): same journey', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await runJourney(page, JOURNEY3_SCOPE_NARROW);
  });
});
