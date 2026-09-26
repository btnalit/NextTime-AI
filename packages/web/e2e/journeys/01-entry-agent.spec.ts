import { expect, test } from '@playwright/test';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import {
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ①: 让入口 agent 能执行 (development-tasks.md §5e F4/决定, audit J1–J8/R1–R9)
 *
 * 步骤:
 *   1. （全新工作区）在 系统与授权 把 CI 已 announce 的 `ci-fixture-mcp` 门实例启用到本工作区——
 *      发布它的两个 Operation（`list_things` 观察类 / `restart_thing` 执行类）。这一个门是
 *      `gate-host.spec.ts`/`integrations.spec.ts`（P-B1）已经用过的同一个 CI fixture，不是本
 *      旅程新起的 fixture；平台侧的 `discovered → enabled` 由 integrations.spec.ts 的第一个测试
 *      完成——按文件名排序（g/gate-host、i/integrations 都在 j/journeys 之前，`playwright.config.
 *      ts` 的 `workers: 1`/`fullyParallel: false` 让整个套件按发现顺序顺序跑），本旅程运行时那一步
 *      已经做完，这里只做"本工作区自己的启用"（workspace-scope `enable_gate_instance`）。
 *   2. 在 系统与授权 把这个门授权给自己（新建工作区的 owner——入口 agent 以 owner 的身份委派）。
 *   3. 在 能力目录 · Worker "从模板创建（ops-runner）"，勾选这个门，保存草稿、发布。
 *   4. 在 对话 新建一个对话，给入口 agent 发一条消息。
 *   5. 观察回复；见下方"今天为什么走不到「委派」"——第 5 步在 CI 的 fake 栈上只能观察到入口 agent
 *      的（假）回复本身，不能观察到 invoke_worker 或一个 Task。
 *
 * 状态覆盖:
 *   - 空: 用 `createFreshWorkspace` 建一个全新工作区（不是每个 spec 共用、会不断累积状态的
 *     `ci-e2e`），第 1 步之前断言 系统与授权（`systems-empty`，`available-gate-ci-fixture-mcp`
 *     还没有"已启用"链接）、能力目录 · Worker（`catalog-empty`）都还是空的，以及 对话 上的状态条
 *     （console redesign P2-b，`execution-readiness-missing`）零系统时收成一行——"还没有可以作用
 *     的系统"（`no_enabled_gate`）——按可见的缘由文案断言，不断言内部 `code`（`packages/web/src/
 *     components/readiness/readiness-copy.ts`）。"没有可委派的 Worker"（`no_published_worker`）
 *     在这一刻没有意义（连一个系统都还没有），状态条不重复它——见下方第 1 步之后的中间状态，那时它
 *     才会出现。控制台重构 P2 把 访问 的授权半边并入 系统与授权（`components/systems/
 *     SystemsPage.tsx`），这一页不再重复渲染 `execution-prerequisite-bar`（能力目录 / 对话页各自
 *     还有一份）——本旅程相应地不再在这一页断言它，也不再把 访问 当成独立于 系统接入 的第三处空态。
 *   - 错: 产品今天没有"委派在提交前被挡住"这个机制（W1-C 的 `execution_readiness` 是读模型，没有接
 *     到对话的发送按钮上）；断言这一点不成立，会断言一个不存在的产品行为。退而求其次、但仍然真实的
 *     一件事：本旅程的步骤顺序天然会经过"门已授权、Worker 还未发布"这个中间状态（第 1、2 步之后，
 *     第 3 步之前）——在那一刻 能力目录 · Worker 仍是 `catalog-empty`，`execution-prerequisite-bar`
 *     和对话页的 readiness card 都只剩"没有可委派的 Worker"这一项缺口（门已启用/已授权那两条缺口
 *     消失了）——PR #273（`feat/s8-w2u3-overview-readiness`，已合并 `62a09a5`）把
 *     `execution_readiness` 接上页面后，这个"缺口收窄"的过程本身就是产品今天能验证的、最接近"错"
 *     状态原文设想的东西：不是拦下提交，是如实反映还差什么。
 *   - 无权限: 跳过——需要平台管理员再建一个 member 角色的第三个主体、登入、切工作区，是这条旅程
 *     已有的"建号 → 登入 → 强制改密 → 选工作区"链路（第 0 步）的又一整套重复，不 cheap；
 *     `governance.spec.ts`/`06-add-member.spec.ts` 已经从别的角度覆盖了"member 看不到治理分组"。
 *   - 窄屏: 768px 下重开 能力目录 · Worker 的"新建草稿"（空白表单，不是模板）走一遍到成功
 *     （`draft-proposed` 出现）——顺带走一次 `goToByLabel` 在 ≤960px 时打开 `NavDrawer` 的分支。
 *
 * 成功判据:
 *   - 从一个全新工作区、不碰 SQL/CLI，一个人凭页面上的信息能把"系统与授权（接入 → 授权）→ 发布
 *     Worker"走完，并在 对话 里发出一条消息、看到入口 agent 的回复。
 *   - 这条旅程测的不是"委派真的执行了"（见下），而是"委派的三个前置条件——门已启用、已授权给
 *     会说话的这个 owner、Worker 已发布——全部可以只凭 UI 完成"，加上"对话本身是通的"；发布 Worker
 *     后 `execution_readiness` 自己也认为"已就绪"（`execution-readiness-ready`，`对话` 页）、能力
 *     目录页的 `execution-prerequisite-bar` 也随之消失——见下方"执行就绪为什么在这里会变 ready"
 *     关于 `computeChildHandleScope` 的说明。
 *
 * 执行就绪为什么在这里会变 ready（读 `packages/kernel/src/application/gateway/
 * execution-readiness-handler.ts` + `application/task/handle-mint.ts` 后的结论）：
 *   `ready = workers.some(w => w.delegable)`；`delegable` 是 `computeChildHandleScope` 对这个
 *   WorkerDefinition 做的一次真实 dry run 不抛 `InvokeWorkerAttenuationError`。ops-runner 模板不显式
 *   声明 `capabilities`，落到 `defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES)`——"ceiling 去掉
 *   每一个 execute-class 名字"（`handle-mint.ts` 自己的注释），`request_action` 正是那个唯一的
 *   execute-class 名字（`EXECUTE_CLASS_CAPABILITY_NAMES`）。`computeChildHandleScope` 只在"声明了一个
 *   execute-class 能力、调用方没有"或"请求执行访问的门不在调用方范围内（且请求了 execute）"两种情况下
 *   才抛错——ops-runner 默认两者都不触发（`wantsExecute` 恒为 false），所以它勾选的门即使没被授权，
 *   `declaredGates` 里那个门也只是被静默丢弃（"observe-only 的门可以不经凭证"，同一份源码的注释），
 *   不会让整个调用失败。也就是说，只要发布了这个未改过 `capabilities` 的 ops-runner Worker，`ready`
 *   就会变真——门授权与否本身不是它变 ready 的必要条件，只是本旅程的步骤顺序里授权发生在发布之前，
 *   所以观察不到"发布了但没授权仍然 ready"这一半。这是从源码读出的真实结论，不是猜测——旅程的断言
 *   顺序（先授权、后发布）不会因此产生假阳性。
 *
 * 今天为什么走不到"委派"（比"Worker 容器起不来"更早一层的原因，读代码后的结论，不是猜测）：
 *   `.github/workflows/e2e.yml` 给这个 job 的是 `AGENT_RUNTIME=fake`（`deploy/ci/env.ci.
 *   template`）。`packages/kernel/src/application/host-bridge/fake-runtime.ts`
 *   （`FakeAgentRuntime.run`）对每一个 Turn 做的事只是把 prompt 原样回显（`echo: <prompt>`）——
 *   它完全不调用任何 LLM、不产生任何 `tool_calls`，`deploy/fake-llm/server.mjs` 的 S2.12
 *   `SCENARIOS`（`scripts/accept_s2.sh` 用来驱动 `invoke_worker`/`report_result` 的脚本化场景）
 *   在这个 job 里从来不会被触达——这个 job 唯一调用 fake-llm 的地方是一次性的 `llm-proxy
 *   gen-models.js`（生成 `models.json` 给模型选择器用），不是聊天路径。`docker-compose.ci.yml`/
 *   `env.ci.template` 自己的注释也直说：这就是"只需要三个常驻容器"的原因——
 *   agent-host/worker-supervisor/docker-socket-proxy/egress-proxy 在这个 job 里都不存在。也就是
 *   说，不是"Worker 容器起不来"（更下游的一层原因），而是"入口 agent 在这个 CI 栈上永远不会真的
 *   调用任何工具，包括 `invoke_worker`"——`chat.spec.ts` 自己的断言（回复严格等于
 *   `echo: <!--nexttime:turn_id=...-->\n<prompt>`）就是这件事的直接证据。给 fake-llm 加一个
 *   `invoke_worker` 脚本化场景不会让这条路走通（这个 job 从不请求它），所以本旅程没有加——加了是
 *   死代码，会误导下一个读这个文件的人以为"对话"这一步已经在验证委派。真正验证 `invoke_worker` →
 *   Worker → 结果这条链路的是 `scripts/accept_s2.sh`（`AGENT_RUNTIME=agent-host`，真实
 *   agent-host/pi/worker-supervisor），不是这个 Playwright 套件；`docs/runbooks/web-console.md`
 *   "CI（Playwright）"一节记录了同一个事实。要让这一步在这里也能验证，需要的是把这个 job 换成
 *   （或新增一个）`AGENT_RUNTIME=agent-host` 的栈，而不是给 fake-llm 加场景。
 */

const GATE_ID = 'ci-fixture-mcp';
const GATE_DISPLAY_NAME = 'CI fixture MCP';
const OBSERVE_OP = 'list_things';
const EXECUTE_OP = 'restart_thing';
const WORKER_TEMPLATE_NAME = 'ops-runner';

// The exact zh cause text `readiness-copy.ts`'s `missingCauseText` renders for each code — asserted
// on directly (never the raw `code`, per this lane's own dispatch instruction and the component's
// own doc comment "ui-audit S14 内部术语外泄").
const READINESS_NO_ENABLED_GATE_TEXT =
  '入口 agent 还没有任何可以作用的系统，先在系统接入启用一个门。';
const READINESS_NO_PUBLISHED_WORKER_TEXT =
  '入口 agent 委派任务时找不到可用的 Worker，先发布一个 Worker 定义（可从 ops-runner 模板开始）。';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('Journey ①: 让入口 agent 能执行', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('end to end: connect a system, authorize, publish a Worker, delegate from chat, see the result', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // --- 0. 全新工作区 + 登入自己的 owner（"空"状态覆盖：见本文件顶部说明） -------------------
    const { ownerLogin, ownerTemporaryPassword } = await createFreshWorkspace(page);
    await page.getByRole('button', { name: /登出/ }).click();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    // 新用户同时是平台默认工作区的 member（`create_user` 的默认行为，见 helpers.ts
    // `selectOwnedWorkspace` 的 doc comment）和这个新工作区的 owner——切到后者。
    await selectOwnedWorkspace(page);
    await expect(page.getByTestId('nav-chats')).toBeVisible();

    const availableRow = page.getByTestId(`available-gate-${GATE_ID}`);
    const enableButton = availableRow.getByTestId(`enable-gate-${GATE_ID}`);

    // --- 空: 两样都还没有（访问的授权半边已并入这一页，不再是第三处独立空态）-------------------
    await goToByLabel(page, '系统与授权');
    await expect(page.getByTestId('systems-empty')).toBeVisible();
    await expect(availableRow).toBeVisible();
    await expect(enableButton).toBeVisible();

    await goToByLabel(page, '能力目录');
    await page.getByRole('tab', { name: 'Worker', exact: true }).click();
    await expect(page.getByTestId('catalog-empty')).toBeVisible();

    // 对话页状态条（console redesign P2-b）：零系统时收成一行，只指向第一步——"还没有已发布的
    // Worker"在这一刻没有意义（连一个系统都还没有，delegation 无从谈起），状态条不再重复它。访问
    // 的空态已随控制台重构 P2 并入 系统与授权（上面已经断言过 `systems-empty`），不再单独断言。
    await goToByLabel(page, '对话');
    const readinessBody = page.getByTestId('execution-readiness-body');
    await expect(readinessBody).toBeVisible({ timeout: 15_000 });
    const readinessMissing = readinessBody.getByTestId('execution-readiness-missing');
    await expect(readinessMissing).toBeVisible();
    await expect(readinessMissing.getByTestId('execution-readiness-missing-item')).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(readinessMissing).toContainText(READINESS_NO_ENABLED_GATE_TEXT);

    // --- 1. 系统与授权: 启用 ci-fixture-mcp 到本工作区 ----------------------------------------
    await goToByLabel(page, '系统与授权');
    await enableButton.click();
    const enableConfirm = page.getByTestId(`enable-gate-${GATE_ID}-confirm`);
    await expect(enableConfirm).toBeVisible({ timeout: 15_000 });
    await enableConfirm.getByTestId('confirm-button').click();
    await expect(availableRow.getByRole('link', { name: /已启用/ })).toBeVisible({
      timeout: 15_000,
    });
    const gateCard = page.getByTestId('gatekeeper-card').filter({ hasText: GATE_DISPLAY_NAME });
    await expect(gateCard).toHaveCount(1, { timeout: 15_000 });

    // --- 2. 系统与授权: 把这个门授权给自己（同一张卡，不再是单独一页）-------------------------
    await gateCard.getByTestId('gatekeeper-grant-button').click();
    const grantDrawer = page.getByTestId('grant-gate-drawer');
    const grantForm = grantDrawer.getByTestId('grant-gate-form');
    await expect(grantForm).toBeVisible({ timeout: 15_000 });
    // Opened from the card: the gate is locked, no picker/checklist renders for it (GrantGateForm's
    // own `lockedGatekeeper` contract) — the covered-operations list populates immediately.
    const operationsList = grantForm.getByTestId('ggf-operations-list');
    await expect(operationsList).toContainText(OBSERVE_OP, { timeout: 15_000 });
    await expect(operationsList).toContainText(EXECUTE_OP);

    const memberSelect = grantForm.getByTestId('ggf-member-select');
    await expect(memberSelect).toBeEnabled({ timeout: 15_000 });
    const memberOption = memberSelect.locator('option:not([value=""])');
    // 全新工作区只有这一个人类成员——它自己。
    await expect(memberOption).toHaveCount(1);
    const memberId = await memberOption.getAttribute('value');
    expect(memberId ?? '').not.toBe('');
    await memberSelect.selectOption(memberId as string);

    await grantForm.getByTestId('ggf-submit').click();
    await expect(grantForm.getByTestId('ggf-granted-summary')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(grantDrawer).toBeHidden();
    await expect(gateCard.getByTestId('system-access-row')).toHaveCount(1, { timeout: 15_000 });

    // --- 错（部分覆盖，见本文件顶部说明）: 门已授权、Worker 还未发布 ---------------------------
    await goToByLabel(page, '能力目录');
    await page.getByRole('tab', { name: 'Worker', exact: true }).click();
    await expect(page.getByTestId('catalog-empty')).toBeVisible();
    // 门已启用/已授权那两项缺口消失了，只剩"没有已发布 Worker"——同一次页面加载上顺带断言
    // ExecutionPrerequisiteBar（不用额外导航）。
    const catalogPrereqBar = page.getByTestId('execution-prerequisite-bar');
    await expect(catalogPrereqBar).toBeVisible({ timeout: 15_000 });
    await expect(catalogPrereqBar).toContainText(READINESS_NO_PUBLISHED_WORKER_TEXT);
    await expect(catalogPrereqBar).not.toContainText(READINESS_NO_ENABLED_GATE_TEXT);

    await goToByLabel(page, '对话');
    const readinessBodyMid = page.getByTestId('execution-readiness-body');
    await expect(readinessBodyMid).toBeVisible({ timeout: 15_000 });
    const readinessMissingMid = readinessBodyMid.getByTestId('execution-readiness-missing');
    await expect(readinessMissingMid).toBeVisible();
    await expect(readinessMissingMid.getByTestId('execution-readiness-missing-item')).toHaveCount(
      1,
      { timeout: 15_000 },
    );
    await expect(readinessMissingMid).toContainText(READINESS_NO_PUBLISHED_WORKER_TEXT);
    await expect(readinessMissingMid).not.toContainText(READINESS_NO_ENABLED_GATE_TEXT);

    // 回到 能力目录 · Worker 继续第 3 步——上面为了读 readiness card 离开过一次页面。
    await goToByLabel(page, '能力目录');
    await page.getByRole('tab', { name: 'Worker', exact: true }).click();

    // --- 3. 能力目录 · Worker: 从模板创建（ops-runner），勾选这个门，保存草稿、发布 -------------
    await page.getByTestId('workers-template-button').click();
    const workerDrawer = page.getByTestId('worker-editor-drawer');
    const workerForm = workerDrawer.getByTestId('worker-definition-editor');
    await expect(workerForm).toBeVisible({ timeout: 15_000 });
    await expect(workerDrawer.getByTestId('worker-private-notice')).toBeVisible();

    const wdGateCheckbox = workerForm
      .getByTestId('wd-gates')
      .locator('label.checkbox')
      .filter({ hasText: GATE_DISPLAY_NAME })
      .locator('input[type="checkbox"]');
    await wdGateCheckbox.check();

    await workerForm.getByTestId('worker-submit').click();
    const draftProposed = workerDrawer.getByTestId('draft-proposed');
    await expect(draftProposed).toBeVisible({ timeout: 15_000 });
    await draftProposed.getByTestId('draft-publish').click();
    await expect(draftProposed.locator('[data-status="published"]')).toBeVisible({
      timeout: 15_000,
    });
    await draftProposed.getByTestId('draft-done').click();
    await expect(workerDrawer).toBeHidden();
    await expect(page.getByTestId('catalog-empty')).toHaveCount(0);
    await expect(
      page.getByTestId('catalog-list').getByText(WORKER_TEMPLATE_NAME, { exact: true }),
    ).toBeVisible();

    // --- 4/5. 对话: 发一条消息，看入口 agent 的回复（不是委派——见本文件顶部说明） --------------
    await goToByLabel(page, '对话');
    await page.locator('header').getByRole('button', { name: '新对话' }).click();
    await expect(page.getByRole('button', { name: '返回对话列表' })).toBeVisible();
    const prompt = `委派给 ${WORKER_TEMPLATE_NAME} 重启测试容器 ${Date.now().toString(36)}`;
    await page.getByPlaceholder('输入消息…').fill(prompt);
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'connected');
    await expect(page.locator('.turn-badge[data-status="completed"]')).toBeVisible({
      timeout: 15_000,
    });
    // fake runtime 的回显，不是委派的结果——见本文件顶部"今天为什么走不到「委派」"。
    const expectedReply = new RegExp(
      `^echo: <!--nexttime:turn_id=[^>]+-->\\n${escapeRegExp(prompt)}$`,
    );
    await expect(page.locator('.message-user .message-text')).toHaveText(prompt);
    await expect(page.locator('.message-assistant .message-text')).toHaveText(expectedReply);

    // --- 最强的诚实收尾: 委派的三个前置条件——启用/授权/已发布 Worker——全部可凭 UI 确认 ---------
    // 回到对话列表（离开当前这个具体对话的详情页）重新挂载一次，读一次新鲜的 execution_readiness——
    // 见本文件顶部"执行就绪为什么在这里会变 ready"：已发布的 ops-runner Worker 现在应该是 delegable
    // 的，`ready` 应该是 true。
    await goToByLabel(page, '对话');
    await expect(page.getByTestId('execution-readiness-body')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('execution-readiness-ready')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('execution-readiness-missing')).toHaveCount(0);

    // 系统与授权: the card's own "谁能用" row is the strongest honest signal here now — it went
    // from "用不了"（not_granted, before step 2）to "可直接调用" once granted and published,
    // console redesign P2's own acceptance criterion (docs/console-redesign-plan-2026-09-25.md
    // §6 P2: "授权后能力视图从「不可用」变「可直接调用」").
    await goToByLabel(page, '系统与授权');
    await expect(availableRow.getByRole('link', { name: /已启用/ })).toBeVisible();
    const readyGateCard = page
      .getByTestId('gatekeeper-card')
      .filter({ hasText: GATE_DISPLAY_NAME });
    await expect(
      readyGateCard.getByTestId('system-access-row').filter({ hasText: '可直接调用' }),
    ).toHaveCount(1, { timeout: 15_000 });

    await goToByLabel(page, '能力目录');
    await page.getByRole('tab', { name: 'Worker', exact: true }).click();
    await expect(
      page.getByTestId('catalog-list').getByText(WORKER_TEMPLATE_NAME, { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('execution-prerequisite-bar')).toHaveCount(0, {
      timeout: 15_000,
    });

    // --- 窄屏 (768px): Worker 的"新建草稿"（空白表单）在窄屏下也能走完 ------------------------
    await page.setViewportSize({ width: 768, height: 900 });
    await goToByLabel(page, '能力目录'); // 顺带走一次 NavDrawer 分支（helpers.ts openNavDrawerIfNarrow）
    await page.getByRole('tab', { name: 'Worker', exact: true }).click();
    await page.getByTestId('workers-new-draft').click();
    const narrowDrawer = page.getByTestId('worker-editor-drawer');
    const narrowForm = narrowDrawer.getByTestId('worker-definition-editor');
    await expect(narrowForm).toBeVisible({ timeout: 15_000 });
    await narrowForm.locator('#wd-system-prompt').fill('768px journey smoke test system prompt.');
    await narrowForm.getByTestId('worker-submit').click();
    await expect(narrowDrawer.getByTestId('draft-proposed')).toBeVisible({ timeout: 15_000 });
  });
});
