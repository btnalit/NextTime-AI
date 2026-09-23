import { expect, test } from '@playwright/test';
import { OWNER_API_KEY, asOwner, goToByLabel } from './helpers.js';

/**
 * Journey ③: 审批一个执行类动作 (development-tasks.md §5e F4; S2.10 acceptance, same underlying
 * capability `approvals.spec.ts` already exercises directly — this file narrates the same
 * capability as a *journey*: what a person actually clicks, by visible label, start to finish)
 *
 * 步骤:
 *   1. 待我审批 队列里出现一张待批准的行（本旅程用一条专属种子行 `e2e-journey3-approve`，见
 *      `.github/workflows/e2e.yml`"Seed pending ActionRequests" —— 与 approvals.spec.ts 自己的两条
 *      种子行分开，两个套件不会抢同一行）。
 *   2. 点开这一行，看到动作详情（谁、对什么、blast radius）。
 *   3. 批准。
 *   4. 队列里这一行消失；对应的对话卡片状态更新为已批准/执行中/已执行/失败之一（种子 Gatekeeper 没有
 *      可达端点，批准后kernel 自己的执行会失败——这是"批准动作本身成立"之后的下一段，不是这条旅程的
 *      判据）。
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
 * 今天可以整条走通：kernel 的 approve 能力、ApprovalQueuePage 的队列/抽屉都已经是 S2.10 起就有的
 * 稳定能力——不是 W2/W3 才补的东西，所以这是六条里 F4 点名"如果可行就做成真实通过"的那一条。
 */

const JOURNEY3_SCOPE = 'e2e-journey3-approve';
const SEED_ACTION_REQUESTS = process.env.WEB_E2E_SEED_ACTION_REQUESTS === '1';

async function runJourney(page: import('@playwright/test').Page): Promise<void> {
  await asOwner(page);

  // Step 1+2: navigate by the sidebar's own visible label, not the hash, then open the row.
  await goToByLabel(page, '待我审批');
  const row = page.getByTestId('approval-row').filter({ hasText: JOURNEY3_SCOPE }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const drawer = page.getByTestId('approval-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Approve' })).toBeVisible();

  // Step 3: approve.
  await drawer.getByRole('button', { name: 'Approve' }).click();

  // Step 4: the row leaves the pending queue; the linked chat card's status chip moves off
  // `pending_approval` (same post-decision reasoning as approvals.spec.ts's own S2.10 test — the
  // seeded Gatekeeper has no reachable endpoint, so kernel execution itself fails right after
  // approval; any post-decision state proves the *approval* succeeded).
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press('Escape');

  await goToByLabel(page, '对话');
  await page.locator('.chat-list-item').first().click();
  const chatCard = page.locator('.action-card', { hasText: JOURNEY3_SCOPE }).first();
  await expect(chatCard).toBeVisible({ timeout: 15_000 });
  await expect(chatCard.locator('.action-card-status')).toHaveAttribute(
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

  test('desktop: approve a pending action from the queue, see the chat card update', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await runJourney(page);
  });

  test('narrow screen (768px): same journey', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await runJourney(page);
  });
});
