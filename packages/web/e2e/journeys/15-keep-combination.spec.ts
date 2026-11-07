import type {
  CombinationCandidatesWire,
  GoalDetailWire,
  ProposeGoalResultWire,
  WorkerDefinitionWire,
} from '@nexttime/shared';
import { OWNER_API_KEY, loginAsOwner } from '../lib/auth.js';
import { type Page, expect, test } from '../lib/test.js';
import { SECOND_PRINCIPAL_API_KEY, goToByLabel } from './helpers.js';

/**
 * Journey ⑮: 把跑得好的组合沉淀为新的 Worker 定义（S11 GO16b）
 *
 * 步骤:
 *   1. 所有者在「能力目录 → Worker」打开一个已发布的 Worker，在「可沉淀的组合」里看到一份步骤调整：
 *      它在三个目标里都被请求人确认达成。
 *   2. 点「沉淀为定义…」：确认框先说这段内容会写进全工作区可见的定义草稿，再给预览；起个名字，
 *      「写成草稿」（`propose_definition_from_combination`）。
 *   3. 页面打开新草稿，「来历」写着它从哪个版本加一份步骤调整沉淀而来、当时的证据；所有者发布它。
 * 状态覆盖:
 *   - 空: 跳过——没有达到门槛的组合时那一句由 CombinationCandidates.test.tsx 覆盖。
 *   - 错: 跳过——条件不再满足（409）、读不到来源目标（404）由组件测试和
 *     combination-candidates-handler 的集成测试覆盖。
 *   - 无权限: 跳过——member 看不到这一节、读不到来源目标的 builder 只看到编号，由组件测试与集成测试
 *     覆盖；这里的所有者能读每个目标，所以看得到内容和按钮。
 *   - 窄屏: 跳过——交 UX 验收在 390 宽度下截。
 * 成功判据:
 *   - 写操作由真实内核答复：页面说「已写成草稿：<名字>。审核后由你发布」，打开的草稿有「来历」；发布后
 *     从页面外读 `list_worker_definitions`，新家族的 v1 已发布，`derivedFrom` 指向原 Worker 的 v1、证据
 *     是三次达成、三个目标；`get_combination_candidates` 里那份组合的「已经沉淀为」有新家族。
 *
 * 准备工作在页面外做，不算控制台操作（同旅程⑪）：所有者发布一个 Worker；请求人（CI 栈的第二个
 * principal）用自己的 API key 提议三个目标，每个只有一步，用这个 Worker 加同一份步骤调整
 * （`spec.instructions`），验收是请求人确认；请求人确认并开始，假 Worker 执行器（`FAKE_INVOKE_WORKER=1`）
 * 很快报回结果，目标停在验收中；请求人确认验收（`confirm_goal_acceptance`），目标结束为达成——平台
 * 判定加请求人确认，是 primary 档，所以三次都算。目标的确认和验收在控制台有入口，由旅程⑪和
 * goal-detail.spec.ts 覆盖；这里只是凑出组合的证据。
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

/** Reads the goal until `done` holds — the fake Worker and the advancer move it on their own. */
async function goalUntil(
  page: Page,
  apiKey: string,
  goalRunId: string,
  done: (goal: GoalDetailWire) => boolean,
): Promise<GoalDetailWire> {
  let goal: GoalDetailWire | null = null;
  await expect
    .poll(
      async () => {
        goal = await callAs<GoalDetailWire>(page, apiKey, 'get_goal', { goalRunId });
        return done(goal);
      },
      { timeout: 60_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return goal as unknown as GoalDetailWire;
}

const RUN = Date.now().toString(36);
const BASE_NAME = `journey-keep-worker-${RUN}`;
const KEPT_NAME = `journey-kept-${RUN}`;
const INSTRUCTIONS = '先读最近一小时的日志，再动手。';

test.describe('Journey ⑮: 把跑得好的组合沉淀为定义', () => {
  test.skip(
    !OWNER_API_KEY || !SECOND_PRINCIPAL_API_KEY,
    'set WEB_E2E_API_KEY and WEB_E2E_API_KEY_B (see README.md)',
  );

  test('an owner keeps a combination that kept working as a new Worker, and publishes it', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const owner = OWNER_API_KEY as string;
    const requester = SECOND_PRINCIPAL_API_KEY as string;
    const attempt = `${RUN}-${test.info().retry}`;

    // --- 准备（页面外）: 一个已发布的 Worker，三个用它加同一份步骤调整、被请求人确认达成的目标 ----
    const draft = await callAs<WorkerDefinitionWire>(page, owner, 'propose_worker_definition', {
      kind: 'worker',
      definition: {
        name: BASE_NAME,
        description: 'Journey ⑮ fixture Worker: fixes one thing a goal asks for.',
        systemPrompt: 'You fix one thing and report what you did.',
      },
    });
    await callAs(page, owner, 'publish_worker_definition', {
      definitionId: draft.id,
      version: draft.version,
    });
    for (const n of [1, 2, 3]) {
      const proposed = await callAs<ProposeGoalResultWire>(page, requester, 'propose_goal', {
        statement: `旅程⑮：修好第 ${n} 个服务（${attempt}）`,
        plan: {
          steps: [
            {
              key: 'fix',
              worker: { definitionId: draft.id, version: draft.version },
              spec: { instructions: INSTRUCTIONS },
              input: { service: `svc-${n}` },
            },
          ],
          acceptance: [{ kind: 'requester_confirm', key: 'fixed', prompt: '服务已经修好' }],
        },
        budget: { maxTokens: 100_000, maxSteps: 5, maxRevisions: 3, maxWallClockSeconds: 3600 },
        idempotencyKey: `journey-15-${attempt}-${n}`,
      });
      await callAs(page, requester, 'confirm_goal', {
        goalRunId: proposed.goalRunId,
        revision: 1,
      });
      await goalUntil(page, requester, proposed.goalRunId, (goal) => goal.status === 'verifying');
      await callAs(page, requester, 'confirm_goal_acceptance', {
        goalRunId: proposed.goalRunId,
        checkKey: 'fixed',
      });
      const ended = await goalUntil(
        page,
        requester,
        proposed.goalRunId,
        (goal) => goal.status === 'completed',
      );
      expect(ended.outcome).toBe('achieved');
    }

    // --- 1. 所有者打开这个 Worker，看到可沉淀的组合 ---------------------------------------------
    await loginAsOwner(page, owner);
    await goToByLabel(page, '能力目录');
    await page.getByRole('tab', { name: 'Worker', exact: true }).click();
    await page
      .getByTestId('catalog-list')
      .getByText(BASE_NAME, { exact: true })
      .click({ timeout: 15_000 });
    const candidates = page.getByTestId('combination-candidates');
    await expect(candidates).toContainText(
      '近 90 天达成 3 次，来自 3 个目标，达成率 100%（3 / 3）',
      {
        timeout: 15_000,
      },
    );
    await expect(candidates).toContainText('调整了职责说明');

    // --- 2. 沉淀为定义：先看提示和预览，起名，写成草稿 -----------------------------------------
    await candidates.getByRole('button', { name: '沉淀为定义…', exact: true }).click();
    const keep = page.getByRole('dialog', { name: '沉淀为新的 Worker 定义' });
    await expect(keep).toContainText(
      '这段内容会写进一份新的定义草稿；发布后，工作区里所有人都能看到它。',
    );
    await keep.getByText('要写进草稿的定义', { exact: true }).click();
    await expect(keep).toContainText(INSTRUCTIONS);
    await keep.getByRole('textbox', { name: '新定义的名称' }).fill(KEPT_NAME);
    await keep.getByRole('button', { name: '写成草稿', exact: true }).click();
    await expect(page.getByText(`已写成草稿：${KEPT_NAME}。审核后由你发布`)).toBeVisible({
      timeout: 15_000,
    });

    // --- 3. 新草稿打开，「来历」写着它从哪来；所有者发布它 ---------------------------------------
    const detail = page.getByTestId('worker-detail');
    await expect(detail).toHaveAttribute('data-worker-key', /.+/, { timeout: 15_000 });
    await expect(detail.getByTestId('worker-detail-derived-from')).toContainText(
      `${BASE_NAME} v1`,
      { timeout: 15_000 },
    );
    await expect(detail.getByTestId('worker-detail-derived-from')).toContainText(
      '当时：近 90 天达成 3 次，来自 3 个目标，达成率 100%（3 / 3）',
    );
    await detail.getByRole('button', { name: '发布', exact: true }).click();
    await expect(
      detail.getByTestId('worker-detail-stepper').locator('[aria-current="step"]'),
    ).toHaveText('已发布', { timeout: 15_000 });

    // --- 页面外核对：新家族已发布、来历指向原 Worker 的 v1，组合记着它 ----------------------------
    const listed = await callAs<{ items: WorkerDefinitionWire[] }>(
      page,
      owner,
      'list_worker_definitions',
      { kind: 'worker' },
    );
    const kept = listed.items.find((row) => row.definition.name === KEPT_NAME);
    expect(kept?.status).toBe('published');
    expect(kept?.id).not.toBe(draft.id);
    expect(kept?.derivedFrom).toMatchObject({
      definitionId: draft.id,
      version: 1,
      evidence: { achieved: 3, notAchieved: 0, goals: 3 },
    });
    const after = await callAs<CombinationCandidatesWire>(
      page,
      owner,
      'get_combination_candidates',
      { definitionId: draft.id },
    );
    expect(after.candidates[0]?.derivedAs).toContain(kept?.id);
  });
});
