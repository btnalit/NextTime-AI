import type { GoalDetailWire, ProposeGoalResultWire, WorkerDefinitionWire } from '@nexttime/shared';
import { OWNER_API_KEY, loginAsOwner } from '../lib/auth.js';
import { type Page, expect, test } from '../lib/test.js';
import { SECOND_PRINCIPAL_API_KEY, goToByLabel } from './helpers.js';

/**
 * Journey ⑪: 确认目标、所有者锁定与解除、请求人修订计划（遗留 657，缺口 G5：控制台写操作走真实内核）
 *
 * 步骤:
 *   1. 请求人在「目标」里打开入口智能体替他提议的目标，选「不用目标规划器」，确认并开始
 *      （`confirm_goal`）。
 *   2. 工作区所有者打开这个别人的目标，暂停它——别人的目标，暂停就是锁定（`pause_goal`）；再在同一页
 *      解除锁定（`release_goal_hold`），目标仍然暂停。
 *   3. 请求人回到这个目标，修订计划：改验收要他确认的那句话，写上原因，提交（`revise_goal`）。
 * 状态覆盖:
 *   - 空: 跳过——goals.spec.ts 已覆盖目标列表的空态。
 *   - 错: 跳过——计划被拒的几种情况（凭据、遮蔽标记、版本过期）由 goal-detail.spec.ts 的替身覆盖，
 *     内核一侧由 goal-handlers 的集成测试覆盖。
 *   - 无权限: 所有者看别人的目标时，暂停按钮写的是「暂停并锁定」，确认框说明这是锁定；请求人不是所有者，
 *     看不到「解除锁定」。
 *   - 窄屏: 跳过——goal-detail.spec.ts 在 390 宽度下截过确认框、解除锁定与计划编辑器。
 * 成功判据:
 *   - 每一步都由真实内核答复：页面说出结果（「目标已确认」「目标已暂停并锁定」「锁定已解除」「计划已改为
 *     第 2 版」），从页面外读 `get_goal` 看到状态真的变了（运行起来；暂停且锁定；仍暂停、锁定解除；
 *     计划在第 2 版，验收那句话是新写的）。
 *
 * 准备工作在页面外做，不算控制台操作：所有者发布一个 Worker，请求人提议目标。提议目标在控制台没有入口
 * （入口智能体替人提议，`capability-matrix.yaml` 的 `propose_goal` 行），这里用请求人自己的 API key
 * 直接调用 `propose_goal`——人通道调用 Handle 通道的能力是允许的，请求人就是调用者本人。请求人是 CI
 * 栈的第二个 principal（operator），所有者是 CI 工作区的 owner：锁定只发生在所有者暂停别人的目标时。
 *
 * 步骤的 Worker 由 CI 的假 Worker 执行器跑（`FAKE_INVOKE_WORKER=1`，`fake-invoke-worker.ts`），
 * 很快报回结果；计划的验收是请求人确认，所以目标跑完步骤后停在验收中，等请求人——不会自己结束。
 * 三个测试按顺序跑（serial），共享同一个目标；重试时整组重来，提议用这一轮自己的 idempotencyKey。
 */

interface CapResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** A capability called with an API key from Node — setup and reads, never what the test checks
 *  a person can do. */
async function callAs<T>(page: Page, apiKey: string, name: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api/cap/${name}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    data,
  });
  const body = (await res.json()) as CapResult;
  if (!body.ok) throw new Error(`capability ${name} failed: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

const RUN = Date.now().toString(36);
const STATEMENT = `旅程⑪：整理本周的变更记录（${RUN}）`;
const CONFIRM_PROMPT = '变更记录已经整理好';
const REVISED_PROMPT = '变更记录已经整理好，并标出了需要回滚的项';

let goalRunId = '';

async function openGoal(page: Page): Promise<void> {
  await goToByLabel(page, '目标');
  await page
    .getByRole('list', { name: 'Goals' })
    .getByRole('button', { name: new RegExp(RUN) })
    .click({ timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(RUN) })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Journey ⑪: 确认目标、锁定与解除、修订计划', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !OWNER_API_KEY || !SECOND_PRINCIPAL_API_KEY,
    'set WEB_E2E_API_KEY and WEB_E2E_API_KEY_B (see README.md)',
  );

  test('1. the requester confirms the goal proposed for them', async ({ page }) => {
    const owner = OWNER_API_KEY as string;
    const requester = SECOND_PRINCIPAL_API_KEY as string;

    // --- 准备（页面外）: 一个已发布的 Worker，一个替请求人提议的目标 --------------------------
    const draft = await callAs<WorkerDefinitionWire>(page, owner, 'propose_worker_definition', {
      kind: 'worker',
      definition: {
        name: `journey-goal-worker-${RUN}`,
        description: 'Journey ⑪ fixture Worker: does one step of a goal.',
        systemPrompt: 'You do one step of a goal and report what you did.',
      },
    });
    await callAs(page, owner, 'publish_worker_definition', {
      definitionId: draft.id,
      version: draft.version,
    });
    const proposed = await callAs<ProposeGoalResultWire>(page, requester, 'propose_goal', {
      statement: STATEMENT,
      plan: {
        steps: [
          {
            key: 'collect',
            worker: { definitionId: draft.id, version: draft.version },
            input: { week: 'this' },
          },
        ],
        acceptance: [{ kind: 'requester_confirm', key: 'looks-right', prompt: CONFIRM_PROMPT }],
      },
      budget: { maxTokens: 100_000, maxSteps: 5, maxRevisions: 3, maxWallClockSeconds: 3600 },
      idempotencyKey: `journey-11-${RUN}-${test.info().retry}`,
    });
    goalRunId = proposed.goalRunId;
    expect(proposed.status).toBe('proposed');

    // --- 1. 请求人确认并开始 ------------------------------------------------------------------
    await loginAsOwner(page, requester);
    await openGoal(page);
    await page.getByRole('button', { name: '确认并开始', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '确认这个目标' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('执行 1 个步骤');
    await confirm.getByRole('radio', { name: /不用目标规划器/ }).check();
    await confirm.getByRole('button', { name: '确认并开始', exact: true }).click();
    await expect(page.getByText('目标已确认，开始执行', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const after = await callAs<GoalDetailWire>(page, requester, 'get_goal', { goalRunId });
    expect(['running', 'verifying']).toContain(after.status);
    expect(after.currentRevision).toBe(1);
  });

  test('2. an owner holds someone else’s goal, then lifts the hold', async ({ page }) => {
    const owner = OWNER_API_KEY as string;
    expect(goalRunId, 'test 1 proposed and confirmed the goal').not.toBe('');

    await loginAsOwner(page, owner);
    await openGoal(page);

    // --- 2a. 别人的目标：暂停就是锁定 ---------------------------------------------------------
    await page.getByRole('button', { name: '暂停并锁定', exact: true }).click();
    const pause = page.getByRole('dialog', { name: '暂停并锁定这个目标' });
    await expect(pause).toContainText('这是别人的目标，你的暂停是锁定');
    await pause.getByRole('button', { name: '暂停并锁定', exact: true }).click();
    await expect(page.getByText('目标已暂停并锁定', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const held = await callAs<GoalDetailWire>(page, owner, 'get_goal', { goalRunId });
    expect(held.status).toBe('paused');
    expect(held.pausedByAuthority).toBe('owner');

    // --- 2b. 解除锁定：目标仍然暂停，交回请求人 -------------------------------------------------
    await page.getByRole('button', { name: '解除锁定', exact: true }).click();
    const release = page.getByRole('dialog', { name: '解除锁定' });
    await expect(release).toContainText('目标仍然暂停');
    await release.getByRole('button', { name: '解除锁定', exact: true }).click();
    await expect(page.getByText('锁定已解除', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: '解除锁定', exact: true })).toHaveCount(0);
    const released = await callAs<GoalDetailWire>(page, owner, 'get_goal', { goalRunId });
    expect(released.status).toBe('paused');
    expect(released.pausedByAuthority).not.toBe('owner');
  });

  test('3. the requester revises the plan of the paused goal', async ({ page }) => {
    const requester = SECOND_PRINCIPAL_API_KEY as string;
    expect(goalRunId, 'test 1 proposed and confirmed the goal').not.toBe('');

    await loginAsOwner(page, requester);
    await openGoal(page);
    await page.getByRole('button', { name: '修订计划…', exact: true }).click();

    const prompt = page.getByRole('textbox', { name: '确认提示', exact: true });
    await expect(prompt).toHaveValue(CONFIRM_PROMPT, { timeout: 15_000 });
    await prompt.fill(REVISED_PROMPT);
    await page.getByRole('textbox', { name: '修订原因', exact: true }).fill('验收时要一并看回滚项');
    await page.getByRole('button', { name: '提交修订…', exact: true }).click();
    const send = page.getByRole('dialog', { name: '提交这次修订' });
    await send.getByRole('button', { name: '提交修订', exact: true }).click();
    await expect(page.getByText(/^计划已改为第 2 版。目标仍然暂停/)).toBeVisible({
      timeout: 15_000,
    });

    const revised = await callAs<GoalDetailWire>(page, requester, 'get_goal', { goalRunId });
    expect(revised.status).toBe('paused');
    expect(revised.currentRevision).toBe(2);
    expect(revised.planRevision?.plan.acceptance?.[0]).toMatchObject({
      kind: 'requester_confirm',
      key: 'looks-right',
      prompt: REVISED_PROMPT,
    });
  });
});
