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
 *   4. 在 对话 新建一个对话，给入口 agent 发一条消息，观察（假）回显回复——证明对话本身是通的。
 *   5. STATUS 遗留 83（2026-09-27 收口）：再发一条带 CI 专用委派标记的消息，脚本化地代表入口 agent
 *      "决定调用 invoke_worker"这一步，真正走一次内核的 `invoke_worker` 核心路径；在 任务 页确认
 *      这次委派创建的 Task 到达 completed 终态。见下方"委派现在为什么能在这里验证"。
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
 *     SystemsPage.tsx`），这一页不再重复渲染 readiness 提示条（能力目录 / 对话页各自还有一份，
 *     P3-5 起两边共用同一个 `ExecutionReadinessCard`）——本旅程相应地不再在这一页断言它，也不再把
 *     访问 当成独立于 系统接入 的第三处空态。
 *   - 错: 产品今天没有"委派在提交前被挡住"这个机制（W1-C 的 `execution_readiness` 是读模型，没有接
 *     到对话的发送按钮上）；断言这一点不成立，会断言一个不存在的产品行为。退而求其次、但仍然真实的
 *     一件事：本旅程的步骤顺序天然会经过"门已授权、Worker 还未发布"这个中间状态（第 1、2 步之后，
 *     第 3 步之前）——在那一刻 能力目录 · Worker 仍是 `catalog-empty`，能力目录页与对话页现在共用
 *     同一个 `ExecutionReadinessCard`（`execution-readiness-body`，控制台重构 P3-5 把能力目录从
 *     它自己原来那条逐项列出的 `ExecutionPrerequisiteBar` 换成了这个），两边都只剩"没有可委派的
 *     Worker"这一项缺口（门已启用/已授权那两条缺口消失了）——PR #273
 *     （`feat/s8-w2u3-overview-readiness`，已合并 `62a09a5`）把 `execution_readiness` 接上页面后，
 *     这个"缺口收窄"的过程本身就是产品今天能验证的、最接近"错"状态原文设想的东西：不是拦下提交，是
 *     如实反映还差什么。
 *   - 无权限: 跳过——需要平台管理员再建一个 member 角色的第三个主体、登入、切工作区，是这条旅程
 *     已有的"建号 → 登入 → 强制改密 → 选工作区"链路（第 0 步）的又一整套重复，不 cheap；
 *     `governance.spec.ts`/`06-add-member.spec.ts` 已经从别的角度覆盖了"member 看不到治理分组"。
 *   - 窄屏: 768px 下重开 能力目录 · Worker 的"新建草稿"（空白表单，不是模板）走一遍到成功
 *     （`draft-proposed` 出现）——顺带走一次 `goToByLabel` 在 ≤960px 时打开 `NavDrawer` 的分支。
 *
 * 成功判据:
 *   - 从一个全新工作区、不碰 SQL/CLI，一个人凭页面上的信息能把"系统与授权（接入 → 授权）→ 发布
 *     Worker"走完，并在 对话 里发出一条消息、看到入口 agent 的回复。
 *   - "委派的三个前置条件——门已启用、已授权给会说话的这个 owner、Worker 已发布——全部可以只凭 UI
 *     完成"，加上"对话本身是通的"；发布 Worker 后 `execution_readiness` 自己也认为"已就绪"
 *     （`execution-readiness-ready`，`对话` 页）、能力目录页自己那份 `ExecutionReadinessCard` 的
 *     missing 列表也随之清空——见下方"执行就绪为什么在这里会变 ready"关于 `computeChildHandleScope`
 *     的说明。
 *   - STATUS 遗留 83 起，进一步验证"委派本身"：一次真实的 `invoke_worker` 调用创建 Task、按
 *     WorkerDefinition 的声明衰减铸造 Handle、一个（脚本化的）Worker 通过 `report_task_result`
 *     报告结果契约、Task 到达 completed 终态并在 任务 页可见——见下方"委派现在为什么能在这里验证"
 *     说清楚这条链路哪一段是真的、哪一段仍然是脚本触发的。
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
 * 委派现在为什么能在这里验证（STATUS 遗留 83，读代码后的结论，不是猜测）：
 *   `.github/workflows/e2e.yml` 给这个 job 的仍是 `AGENT_RUNTIME=fake`——入口 agent 的每一轮仍然是
 *   `packages/kernel/src/application/host-bridge/fake-runtime.ts`（`FakeAgentRuntime.run`）在内核
 *   进程内原样回显，不调用任何真实 LLM。这一步没有变；变的是 `FakeAgentRuntime` 新增了一个可选的
 *   `onDelegate` 钩子（`FAKE_DELEGATE_MARKER` 常量，见 fake-runtime.ts 自己的文档注释）：当且仅当
 *   prompt 里含有这个专用标记时，不再回显，而是脚本化地代表"入口 agent 决定调用 invoke_worker"这
 *   一个决策点，直接调用内核 `application/task` 的真实 `invokeWorker`（同一份 `invoke.integration.
 *   test.ts` 已经在用的核心函数）——`packages/kernel/src/fake-invoke-worker.ts`（这个组合根专用的
 *   胶水文件，不在任何分层目录下，`index.ts` 是唯一的调用方）把它接上，并把 `TaskSupervisorClientPort`
 *   换成 `FakeTaskSupervisorClient`：它的 `spawn()` 立刻返回一个假容器 id（同真实 spawn 一样快），
 *   随后异步地代表这个"Worker"，用刚为它铸造的 Capability Handle，真实调用一次
 *   `report_task_result`——走 `resolveCaller` + `dispatchCapability` 这条内核真实的校验 + 分派管
 *   线，同一个真实 Worker 的第一次回调会走的代码完全一样。从这一步往后——Task 创建、Handle 按
 *   WorkerDefinition 的声明衰减铸造、Task 到达 completed 终态、在 任务 页可见——全部是内核的真实生
 *   产代码路径；唯一被脚本代替的，是"要不要调用 invoke_worker"这一个决策本身（真实场景里由 LLM 的
 *   工具调用做出）。双重开关，生产环境不受影响：`FAKE_INVOKE_WORKER=1`（只有 `deploy/ci/
 *   env.ci.template` 设置，真实部署的 `.env` 从不设置；`docker-compose.yml` 默认值为空字符串）且
 *   `AGENT_RUNTIME=fake`（生产默认 `agent-host`）。
 *
 *   仍然验证不到、仍需一个真实 `AGENT_RUNTIME=agent-host` 栈的部分：一个真实模型自己"决定"调用
 *   invoke_worker（这一步的判断本身，而不是判断之后内核怎么处理），以及一个真实 Worker 容器的完整
 *   生命周期（起容器、跑 pi、真实产出结果，而不是脚本直接报一个结果契约）。那条链路仍然是
 *   `scripts/accept_s2.sh`（真实 agent-host/pi/worker-supervisor）与维护者在主机上的手工验收职责，
 *   `docs/runbooks/web-console.md`"CI（Playwright）"一节同步记录了这个边界——本旅程的这一步不假装
 *   验证了那两件事。
 */

const GATE_ID = 'ci-fixture-mcp';
const GATE_DISPLAY_NAME = 'CI fixture MCP';
const OBSERVE_OP = 'list_things';
const EXECUTE_OP = 'restart_thing';
const WORKER_TEMPLATE_NAME = 'ops-runner';

// STATUS leftover 83: the exact literal `packages/kernel/src/application/host-bridge/
// fake-runtime.ts` matches `input.prompt` against — trigger its scripted `onDelegate` path
// instead of echoing when found — see that file's own doc comment and this spec's own header
// comment ("委派现在为什么能在这里验证"). A plain string, not imported cross-package (kernel
// internals are not this package's dependency) — kept as one named constant so a reader
// searching this literal finds both sides of the contract.
const FAKE_DELEGATE_MARKER = '__nexttime_fake_delegate__';

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
    // Console redesign P3-3 (V5): "谁能用" no longer sits inline on the card — its summary button
    // opens a `kit/sheet` detail drawer with the full roster.
    await gateCard.getByTestId('system-access-summary').click();
    const accessDrawer = page.getByTestId('system-access-drawer');
    await expect(accessDrawer.getByTestId('system-access-row')).toHaveCount(1, {
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');
    await expect(accessDrawer).toBeHidden();

    // --- 错（部分覆盖，见本文件顶部说明）: 门已授权、Worker 还未发布 ---------------------------
    await goToByLabel(page, '能力目录');
    await page.getByRole('tab', { name: 'Worker', exact: true }).click();
    await expect(page.getByTestId('catalog-empty')).toBeVisible();
    // 门已启用/已授权那两项缺口消失了，只剩"没有已发布 Worker"——同一次页面加载上顺带断言能力目录
    // 页自己的 readiness 条（控制台重构 P3-5：与对话页共用同一个安静的 ExecutionReadinessCard，
    // 不再是逐条罗列的 ExecutionPrerequisiteBar，不用额外导航）。
    const catalogReadinessMid = page.getByTestId('execution-readiness-body');
    await expect(catalogReadinessMid).toBeVisible({ timeout: 15_000 });
    const catalogMissingMid = catalogReadinessMid.getByTestId('execution-readiness-missing');
    await expect(catalogMissingMid).toBeVisible();
    await expect(catalogMissingMid.getByTestId('execution-readiness-missing-item')).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(catalogMissingMid).toContainText(READINESS_NO_PUBLISHED_WORKER_TEXT);
    await expect(catalogMissingMid).not.toContainText(READINESS_NO_ENABLED_GATE_TEXT);

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

    // --- 4. 对话: 发一条消息，看入口 agent 的（假）回显回复——证明对话本身是通的 -------------------
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
    // fake runtime 的原样回显——本步骤只证明对话本身是通的，不是委派（下一步才是）。
    const expectedReply = new RegExp(
      `^echo: <!--nexttime:turn_id=[^>]+-->\\n${escapeRegExp(prompt)}$`,
    );
    await expect(page.locator('.message-user .message-text')).toHaveText(prompt);
    await expect(page.locator('.message-assistant .message-text')).toHaveText(expectedReply);

    // --- 5. 对话: 用 CI 专用委派标记，真正跑一次 invoke_worker（STATUS 遗留 83）------------------
    // 见本文件顶部"委派现在为什么能在这里验证"：这条消息触发 FakeAgentRuntime 的 onDelegate 钩子，
    // 脚本化地代表入口 agent"决定调用 invoke_worker"，往后 Task 创建/Handle 铸造/report_task_result/
    // Task 终态全是内核真实生产代码路径。同一个对话里发第二条消息——第一轮已经 completed，不会撞
    // TurnAlreadyRunningError。
    const delegatePrompt = `${FAKE_DELEGATE_MARKER} 委派给 ${WORKER_TEMPLATE_NAME} 重启测试容器`;
    await page.getByPlaceholder('输入消息…').fill(delegatePrompt);
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('.turn-badge[data-status="completed"]').last()).toBeVisible({
      timeout: 30_000,
    });

    // --- 任务: 这次委派创建的 Task 在 任务 页可见，且到达 completed 终态 ------------------------
    await goToByLabel(page, '任务');
    const taskRow = page.getByTestId('task-row').first();
    await expect(taskRow).toBeVisible({ timeout: 15_000 });
    await expect(taskRow.locator('[data-status]').first()).toHaveAttribute(
      'data-status',
      'completed',
      { timeout: 20_000 },
    );

    // --- 最强的诚实收尾: 委派的三个前置条件——启用/授权/已发布 Worker——全部可凭 UI 确认 ---------
    // 回到对话列表（离开当前这个具体对话的详情页）重新挂载一次，读一次新鲜的 execution_readiness——
    // 见本文件顶部"执行就绪为什么在这里会变 ready"：已发布的 ops-runner Worker 现在应该是 delegable
    // 的，`ready` 应该是 true。
    await goToByLabel(page, '对话');
    await expect(page.getByTestId('execution-readiness-body')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('execution-readiness-ready')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('execution-readiness-missing')).toHaveCount(0);

    // 系统与授权: the card's own "reachability for me" chip is the strongest honest signal here
    // now — "可直接调用" once the gate's observe Operations are published (since decision D4 was
    // revoked on 2026-09-27 — "只读调用不需要授权" — reads no longer wait for the grant in step 2;
    // console redesign P2's own acceptance criterion was docs/console-redesign-plan-2026-09-25.md
    // §6 P2: "授权后能力视图从「不可用」变「可直接调用」"). Console redesign P3-3
    // (V5) moved this chip onto the row itself (`gatekeeper-reachability`, driven straight by the
    // baseline `execution_readiness` gate's own `status`) — no drawer needed to see it.
    await goToByLabel(page, '系统与授权');
    await expect(availableRow.getByRole('link', { name: /已启用/ })).toBeVisible();
    const readyGateCard = page
      .getByTestId('gatekeeper-card')
      .filter({ hasText: GATE_DISPLAY_NAME });
    await expect(readyGateCard.getByTestId('gatekeeper-reachability')).toContainText('可直接调用', {
      timeout: 15_000,
    });

    await goToByLabel(page, '能力目录');
    await page.getByRole('tab', { name: 'Worker', exact: true }).click();
    await expect(
      page.getByTestId('catalog-list').getByText(WORKER_TEMPLATE_NAME, { exact: true }),
    ).toBeVisible();
    // 控制台重构 P3-5: 能力目录页也换成了 ExecutionReadinessCard；ready 时 missing 列表清空，
    // 同上面对话页自己的终态断言（execution-readiness-ready 那一段）。
    await expect(page.getByTestId('execution-readiness-body')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('execution-readiness-missing')).toHaveCount(0, {
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
