import { expect, test } from '@playwright/test';
import { OWNER_API_KEY, asOwner, goToByLabel } from './helpers.js';

/**
 * Journey ②: 接入一个新系统 (development-tasks.md §5e F4; 系统接入页收敛 SY1–SY4/U5/L4, W3 波次)
 *
 * 步骤:
 *   1. 系统接入 → 新建（或 Onboarding wizard）→ 选择接入方式（docker / http / ssh / mcp / cli）。
 *   2. 填写连接信息，测试连通。
 *   3. 门注册成功后，看到它发现/声明的 Operation 列表。
 *   4. 挑选要发布的 Operation，逐个或批量发布。
 *   5. 回到 系统接入 列表，确认这个门状态健康、Operation 数量正确。
 * 状态覆盖:
 *   - 空: 还没有任何系统接入——空态要给出"新建"的入口，不是一句空表。
 *   - 错: 连接信息错误/端点不可达——测试连通要给出具体原因，不是泛化的"失败"。
 *   - 无权限: builder 以下角色打开这个页面——只读，看不到"新建"。
 *   - 窄屏: 向导的多步表单在 768px 下每一步都可完成。
 * 成功判据:
 *   - 一个人从"系统接入"空态开始，不碰 SQL/CLI，把一个系统的至少一个 Operation 发布出来，且这个
 *     Operation 出现在 能力目录 · Operation 里。
 *
 * 今天能做到哪一步：governance.spec.ts 已经证明"打开向导、走到步骤①"这一半（S3.11+）。向导后续步骤
 * （测试连通、看发现的 Operation、发布）在 fake 栈上没有可用的真实门可接（会触达真实网络/docker
 * socket，不是这个 e2e 套件的场景——P-B2a 的 gate-host + fixture-mcp 已经覆盖了"平台级 mcp 门实例"
 * 这一条独立路径，见 gate-host.spec.ts），所以这条旅程的"接入"步骤本身留给 W3 用一个专门的
 * fixture 系统去补，而不是在这里假装接了一个真实系统。
 */

test.describe('Journey ②: 接入一个新系统', () => {
  test.skip(!OWNER_API_KEY, 'set WEB_E2E_BASE_URL and WEB_E2E_API_KEY (see README.md)');

  test("step 1: 系统接入 page reaches the onboarding wizard's first step", async ({ page }) => {
    await asOwner(page);
    await goToByLabel(page, '系统接入');
    await page.getByRole('button', { name: /接入向导/ }).click();
    const drawer = page.getByTestId('onboarding-wizard-drawer');
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByTestId('wizard-step-kind')).toBeVisible();
    await expect(drawer.getByRole('radiogroup', { name: 'Kind' })).toBeVisible();
  });

  test.fixme(
    'steps 2-5: connect, discover Operations, publish, confirm in the catalog',
    async () => {
      // W3 — needs a fixture system this suite can actually reach and register a Gatekeeper
      // against (the current fake stack only has the platform-level fixture-mcp gate-host path,
      // gate-host.spec.ts — not a workspace-level Systems-page connection). See this file's own
      // doc comment.
    },
  );
});
