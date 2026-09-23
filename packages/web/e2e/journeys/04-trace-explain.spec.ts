import { expect, test } from '@playwright/test';
import { OWNER_API_KEY, asOwner, goToByLabel } from './helpers.js';

/**
 * Journey ④: 追溯"agent 为什么这么说" (development-tasks.md §5e F4; 审计与溯源 AU1/J8/S11/PA1/L9,
 * W3 波次)
 *
 * 步骤:
 *   1. 在一次对话里，找到一句 agent 回复引用了某个 Fact/Object 的地方（RefChip 或类似的行内引用）。
 *   2. 点击引用，进入 审计 页的 explain（"为什么相信这个"）。
 *   3. 看到这个 Fact 的来源链：哪次观察/哪个 Worker/哪次 Operation 调用产生的它，什么时候记录的。
 *   4. 从来源链跳到对应的任务/审批（如果有），完成一次"从结论倒推到证据"的闭环。
 * 状态覆盖:
 *   - 空: 一句没有引用任何 Fact 的普通回复——不应该出现"追溯"入口，不能点出一个空的 explain。
 *   - 错: 引用的 Fact 已被上位事实取代（superseded）/失效（invalidated）——explain 要如实说明，不是
 *     显示过期数据当作当前事实。
 *   - 无权限: auditor 以下角色能不能看到 explain 里的敏感字段（审计页本身已经做了 redact，见
 *     audit.spec.ts）。
 *   - 窄屏: 审计页的溯源链在 768px 下仍可逐层展开、不需要横向滚动。
 * 成功判据:
 *   - 从对话里的一句具体回复出发，不手输 id，点击追溯到审计页并看到完整来源链——F4 原文"以后由这些
 *     测试去点，不再靠人工走查发现断点"要求的正是"从产品入口出发"而不是"直接打开审计页传 id"。
 *
 * 今天为什么整条走不通：审计页本身可以按 id/筛选做 explain/reconstruct 查询（audit.spec.ts 已覆盖
 * "直接打开审计页"这一半），但对话里的回复文本还没有把引用做成可点击的行内引用（RefChip 用在 id 展示
 * 上，W1-A1 波次；对话消息本身引用 Fact 的行内标记是 W3 的范围）——从"一句回复"点进"这句话为什么这么
 * 说"这条链路的*起点*还没有 UI。
 */

test.describe('Journey ④: 追溯"agent 为什么这么说"', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY (see README.md)');

  test('step 2 (reached directly, not yet from a chat reply): 审计 page opens and can query by id', async ({
    page,
  }) => {
    await asOwner(page);
    await goToByLabel(page, '审计');
    await expect(page.getByTestId('audit-list').or(page.getByTestId('audit-empty'))).toBeVisible({
      timeout: 15_000,
    });
  });

  test.fixme(
    'steps 1, 3-4: click an in-chat reference, follow the provenance chain, land on the source task/approval',
    async () => {
      // W3 — the chat reply has no clickable in-line Fact reference yet. See this file's own doc
      // comment.
    },
  );
});
