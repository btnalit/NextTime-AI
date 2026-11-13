import type {
  EnableGateInstanceResultWire,
  ListDraftRejectionsResultWire,
  OperationSummaryWire,
  PreviewGateInstanceEnableResultWire,
  PrincipalWire,
  ProcedureSummaryWire,
  SkillSummaryWire,
  WorkerDefinitionWire,
} from '@nexttime/shared';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import { type Page, expect, test } from '../lib/test.js';
import {
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ⑮: 能力目录里一件内容的一生——写一个流程、发布、弃用；丢弃自己的草稿；拒绝别人的草稿；
 * 弃用一个 Skill 与一个 Worker；补写一个 Operation 的描述（遗留 657，缺口 G5：控制台写操作走真实内核）
 *
 * 步骤:
 *   1. 所有者在「能力目录 → 流程」新建草稿：名称、描述，添加一个审批步骤并写上说明，保存草稿
 *      （`propose_procedure`），在保存成功的那一屏直接发布（`publish_procedure`），完成。
 *   2. 打开这个已发布的流程，弃用它（`deprecate_procedure`）。
 *   3. 再写一个流程草稿，保存后不发布；打开它，写上丢弃原因，丢弃（`discard_draft`）。
 *   4. 「Skill」里有一份构建者提议的草稿：所有者打开它，写上拒绝原因，拒绝（`reject_draft`）。
 *   5. 打开一个已发布的 Skill，弃用它（`deprecate_skill`）。
 *   6. 「Worker」里打开一个已发布的 Worker 定义，弃用它（`deprecate_worker_definition`）。
 *   7. 「Operation」里打开门导入的一个 Operation，编辑描述、保存（`update_operation_description`）。
 * 状态覆盖:
 *   - 空: 第 1 步之前——全新工作区的「流程」说还没有流程。
 *   - 错: 跳过——发布被拒（模板问题、步骤引用未发布、草稿已变）、拒绝被拒（not_proposer）与描述里带
 *     凭据由 CatalogPage / ProcedureEditor 的组件测试覆盖，内核一侧由 repeat-call 与各 handler 的
 *     集成测试覆盖。
 *   - 无权限: 第 4 步——别人的草稿，所有者看到的是「拒绝」，没有「丢弃」（丢弃是提议人自己的事）。
 *   - 窄屏: 跳过——`00-gates/` 的截图门槛在 768 宽度下截过能力目录的各个分区。
 * 成功判据:
 *   - 七步都由真实内核答复：页面说出结果（「已发布 · 名称」「名称 已弃用」「名称 已丢弃」「已拒绝 名称 v1」
 *     「描述已更新」），并从页面外读内核状态确认真的变了：`list_procedures` 先列出已发布的流程、弃用和
 *     丢弃后不再列出；构建者自己的 `list_draft_rejections` 里有这次拒绝和原因；`list_skills` 不再列出
 *     被拒绝的草稿和被弃用的 Skill；`get_worker_definition` 说那个版本已弃用；`list_operations` 里
 *     这个 Operation 的描述是刚写的。
 *
 * 准备工作在页面外做，不算控制台操作：启用 CI 的 fixture 门（旅程 ① ② 在控制台里走过；它公告的
 * Operation 不带描述），所有者建一个构建者（`create_principal`，旅程 ⑥ 走过成员）并以它的 API key 提议
 * 一个 Skill 草稿——别人的草稿才有「拒绝」，而智能体或另一个人提议草稿不经过所有者的控制台；所有者自己
 * 提议并发布一个 Skill 和一个 Worker 定义（`propose_skill` / `publish_skill` 由 catalog.spec.ts 在控制台
 * 里走过，Worker 的提议与发布不是这条旅程要看的事）。只有页面发出的调用才算数（`lib/test.ts`），所以准备
 * 和核对都从 Node 调，七个动作都由页面发出。
 */

const GATE_ID = 'ci-fixture-mcp';
/** The fixture gate's observe Operation (`.github/workflows/e2e.yml`'s announce step). */
const OBSERVE_OP = 'list_things';

const RUN = Date.now().toString(36);
const PUBLISHED_PROCEDURE = `journey15-proc-a-${RUN}`;
const DISCARDED_PROCEDURE = `journey15-proc-b-${RUN}`;
const PROCEDURE_DESCRIPTION = `旅程⑮：一步审批的流程（${RUN}）`;
const APPROVAL_NOTE = '请所有者确认这次变更';
const DISCARD_REASON = '写错了，重新来';
const BUILDER_DRAFT = `journey15-draft-${RUN}`;
const BUILDER_DRAFT_V1 = `${BUILDER_DRAFT} v1`;
const REJECT_REASON = `和已有的 Skill 重复（${RUN}）`;
const SKILL = `journey15-skill-${RUN}`;
const WORKER = `journey15-worker-${RUN}`;
const OPERATION_DESCRIPTION = `列出这个系统里的条目，只读（${RUN}）`;

interface CapResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface ProposedDraft {
  readonly id: string;
  readonly version: number;
  readonly draftDigest: string;
}

async function capResult<T>(name: string, res: { json(): Promise<unknown> }): Promise<T> {
  const body = (await res.json()) as CapResult;
  if (!body.ok) throw new Error(`capability ${name} failed: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** A capability called as the signed-in owner from Node — setup and reads only. */
async function callCap<T>(page: Page, name: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api/cap/${name}`, {
    headers: { 'x-requested-with': 'nexttime' },
    data,
  });
  return capResult<T>(name, res);
}

/** A capability called with an API key from Node (the builder) — setup and reads only. The key
 *  is resolved before the owner's session cookie the same request carries. */
async function callAs<T>(page: Page, apiKey: string, name: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api/cap/${name}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    data,
  });
  return capResult<T>(name, res);
}

async function listedProcedure(
  page: Page,
  name: string,
): Promise<ProcedureSummaryWire | undefined> {
  const { items } = await callCap<{ items: ProcedureSummaryWire[] }>(page, 'list_procedures', {});
  return items.find((row) => row.name === name);
}

async function listedSkill(page: Page, id: string): Promise<SkillSummaryWire | undefined> {
  const { items } = await callCap<{ items: SkillSummaryWire[] }>(page, 'list_skills', {});
  return items.find((row) => row.id === id);
}

/** 「能力目录」's section tab. */
async function openSection(page: Page, label: string): Promise<void> {
  await page
    .getByRole('tablist', { name: 'Catalog section' })
    .getByRole('tab', { name: label, exact: true })
    .click();
}

/** 「流程 → 新建草稿」: one approval step, saved as a draft; leaves the editor on its success screen. */
async function proposeProcedure(page: Page, name: string) {
  await page.getByRole('button', { name: '新建草稿', exact: true }).click();
  const editor = page.getByTestId('procedure-editor-drawer');
  await expect(editor.getByRole('button', { name: '保存草稿', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await editor.getByLabel(/^名称/).fill(name);
  await editor.getByLabel(/^描述/).fill(PROCEDURE_DESCRIPTION);
  await editor.getByRole('button', { name: '添加步骤', exact: true }).click();
  await expect(editor.getByRole('combobox', { name: '类型', exact: true })).toHaveValue('approval');
  await editor.getByLabel(/^说明/).fill(APPROVAL_NOTE);
  await editor.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  return editor;
}

test.describe('Journey ⑮: 能力目录里一件内容的一生', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('write, publish and deprecate a procedure; discard, reject and deprecate the rest', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // --- 0. 全新工作区 + 它的所有者；门、构建者的草稿、要弃用的 Skill 与 Worker（页面外） --------
    const { ownerLogin, ownerTemporaryPassword } = await createFreshWorkspace(page);
    await page.getByRole('button', { name: '登出', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);

    // Legacy 311: an enable names the manifest digest its preview showed.
    const { manifestDigest } = await callCap<PreviewGateInstanceEnableResultWire>(
      page,
      'preview_gate_instance_enable',
      { gateId: GATE_ID },
    );
    const { gatekeeperId } = await callCap<EnableGateInstanceResultWire>(
      page,
      'enable_gate_instance',
      { gateId: GATE_ID, manifestDigest },
    );

    const builder = await callCap<{ principal: PrincipalWire; apiKey: string }>(
      page,
      'create_principal',
      { role: 'builder', displayName: `旅程⑮ 构建者 ${RUN}` },
    );
    const builderDraft = await callAs<ProposedDraft>(page, builder.apiKey, 'propose_skill', {
      skill: {
        name: BUILDER_DRAFT,
        description: '旅程⑮：构建者提议、等所有者审阅的草稿',
        markdown: '# 步骤\n\n1. 什么也不做。',
      },
    });

    const skill = await callCap<ProposedDraft>(page, 'propose_skill', {
      skill: {
        name: SKILL,
        description: '旅程⑮：这个 Skill 发布后再弃用',
        markdown: '# 步骤\n\n1. 什么也不做。',
      },
    });
    await callCap(page, 'publish_skill', {
      skillId: skill.id,
      version: skill.version,
      draftDigest: skill.draftDigest,
    });
    expect(await listedSkill(page, skill.id)).toMatchObject({ status: 'published' });
    expect(await listedSkill(page, builderDraft.id)).toMatchObject({
      status: 'draft',
      proposedBy: builder.principal.id,
    });

    const worker = await callCap<WorkerDefinitionWire>(page, 'propose_worker_definition', {
      kind: 'worker',
      definition: {
        name: WORKER,
        description: '旅程⑮：这个 Worker 发布后再弃用',
        systemPrompt: '你只做一件事，并说明做了什么。',
      },
    });
    await callCap(page, 'publish_worker_definition', {
      definitionId: worker.id,
      version: worker.version,
    });

    // --- 1. 流程：从空开始，写一个一步审批的流程，保存成草稿，当场发布 -------------------------
    await goToByLabel(page, '能力目录');
    await openSection(page, '流程');
    await expect(page.getByText('还没有流程', { exact: true })).toBeVisible({ timeout: 15_000 });

    const editor = await proposeProcedure(page, PUBLISHED_PROCEDURE);
    await editor.getByRole('button', { name: '发布', exact: true }).click();
    await expect(page.getByText(`已发布 · ${PUBLISHED_PROCEDURE}`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(editor.getByRole('button', { name: '发布', exact: true })).toHaveCount(0);
    await editor.getByRole('button', { name: '完成', exact: true }).click();
    await expect(editor).toBeHidden();

    const published = await listedProcedure(page, PUBLISHED_PROCEDURE);
    expect(published).toMatchObject({
      status: 'published',
      version: 1,
      description: PROCEDURE_DESCRIPTION,
      steps: [{ kind: 'approval', description: APPROVAL_NOTE }],
    });

    // --- 2. 打开它，弃用 ------------------------------------------------------------------------
    const procedures = page.getByRole('list', { name: 'Procedures', exact: true });
    await procedures
      .getByRole('button', { name: new RegExp(PUBLISHED_PROCEDURE) })
      .click({ timeout: 15_000 });
    const detail = page.getByTestId('catalog-detail');
    await detail.getByRole('button', { name: '弃用', exact: true }).click();
    const deprecateProcedure = page.getByRole('dialog', { name: `弃用 ${PUBLISHED_PROCEDURE}` });
    await deprecateProcedure.getByRole('button', { name: '弃用', exact: true }).click();
    await expect(page.getByText(`${PUBLISHED_PROCEDURE} 已弃用`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      procedures.getByRole('button', { name: new RegExp(PUBLISHED_PROCEDURE) }),
    ).toHaveCount(0);
    // list_procedures leaves deprecated Procedures out, and there is no get_procedure.
    expect(await listedProcedure(page, PUBLISHED_PROCEDURE)).toBeUndefined();

    // --- 3. 再写一个草稿，不发布；打开它，写上原因，丢弃 ------------------------------------------
    const second = await proposeProcedure(page, DISCARDED_PROCEDURE);
    await second.getByRole('button', { name: '完成', exact: true }).click();
    await expect(second).toBeHidden();
    expect(await listedProcedure(page, DISCARDED_PROCEDURE)).toMatchObject({ status: 'draft' });

    await procedures
      .getByRole('button', { name: new RegExp(DISCARDED_PROCEDURE) })
      .click({ timeout: 15_000 });
    await detail.getByRole('button', { name: '丢弃', exact: true }).click();
    const discard = page.getByRole('dialog', { name: `丢弃 ${DISCARDED_PROCEDURE}` });
    await discard.getByRole('textbox', { name: '丢弃原因', exact: true }).fill(DISCARD_REASON);
    await discard.getByRole('button', { name: '丢弃', exact: true }).click();
    await expect(page.getByText(`${DISCARDED_PROCEDURE} 已丢弃`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      procedures.getByRole('button', { name: new RegExp(DISCARDED_PROCEDURE) }),
    ).toHaveCount(0);
    expect(await listedProcedure(page, DISCARDED_PROCEDURE)).toBeUndefined();

    // --- 4. Skill：构建者的草稿——所有者能拒绝，不能丢弃；写上原因，拒绝 ---------------------------
    await openSection(page, 'Skill');
    const skills = page.getByRole('list', { name: 'Skills', exact: true });
    await skills
      .getByRole('button', { name: new RegExp(BUILDER_DRAFT) })
      .click({ timeout: 15_000 });
    await expect(detail.getByRole('button', { name: '拒绝', exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: '丢弃', exact: true })).toHaveCount(0);
    await detail.getByRole('button', { name: '拒绝', exact: true }).click();
    const reject = page.getByRole('dialog', { name: `拒绝 ${BUILDER_DRAFT_V1}` });
    await reject.getByRole('textbox', { name: '拒绝原因', exact: true }).fill(REJECT_REASON);
    await reject.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(page.getByText(`已拒绝 ${BUILDER_DRAFT_V1}`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(skills.getByRole('button', { name: new RegExp(BUILDER_DRAFT) })).toHaveCount(0);

    expect(await listedSkill(page, builderDraft.id)).toBeUndefined();
    const { items: rejections } = await callAs<ListDraftRejectionsResultWire>(
      page,
      builder.apiKey,
      'list_draft_rejections',
      { kind: 'skill' },
    );
    expect(rejections.find((item) => item.id === builderDraft.id)).toMatchObject({
      kind: 'skill',
      version: 1,
      name: BUILDER_DRAFT,
      reason: REJECT_REASON,
    });

    // --- 5. 已发布的 Skill，弃用 ------------------------------------------------------------------
    await skills.getByRole('button', { name: new RegExp(SKILL) }).click({ timeout: 15_000 });
    await detail.getByRole('button', { name: '弃用', exact: true }).click();
    const deprecateSkill = page.getByRole('dialog', { name: `弃用 ${SKILL}` });
    await deprecateSkill.getByRole('button', { name: '弃用', exact: true }).click();
    await expect(page.getByText(`${SKILL} 已弃用`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(skills.getByRole('button', { name: new RegExp(SKILL) })).toHaveCount(0);
    // list_skills, like list_procedures, leaves deprecated versions out.
    expect(await listedSkill(page, skill.id)).toBeUndefined();

    // --- 6. Worker：已发布的定义，弃用 -----------------------------------------------------------
    await openSection(page, 'Worker');
    const workers = page.getByRole('list', { name: 'Worker definitions', exact: true });
    await workers.getByRole('button', { name: new RegExp(WORKER) }).click({ timeout: 15_000 });
    await detail.getByRole('button', { name: '弃用', exact: true }).click();
    const deprecateWorker = page.getByRole('dialog', { name: `弃用 ${WORKER}` });
    await deprecateWorker.getByRole('button', { name: '弃用', exact: true }).click();
    await expect(page.getByText(`${WORKER} 已弃用`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(workers.getByRole('button', { name: new RegExp(WORKER) })).toHaveCount(0);
    const retired = await callCap<WorkerDefinitionWire | null>(page, 'get_worker_definition', {
      definitionId: worker.id,
      version: worker.version,
    });
    expect(retired).toMatchObject({ status: 'deprecated' });

    // --- 7. Operation：门导入的 Operation 没有描述，补写一个 -----------------------------------
    await openSection(page, 'Operation');
    const operations = page.getByRole('list', { name: 'Operations', exact: true });
    const operationRow = operations.getByRole('button', { name: new RegExp(OBSERVE_OP) });
    await expect(operationRow).toContainText('未填写描述', { timeout: 15_000 });
    await operationRow.click();
    await detail.getByRole('button', { name: '编辑描述', exact: true }).click();
    const editDescription = page.getByRole('dialog', { name: '编辑描述' });
    await editDescription
      .getByRole('textbox', { name: '描述', exact: true })
      .fill(OPERATION_DESCRIPTION);
    await editDescription.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('描述已更新', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(editDescription).toBeHidden();
    await expect(operationRow).toContainText(OPERATION_DESCRIPTION, { timeout: 15_000 });

    // Read right after the save: a workspace's Operation rows are written by enabling, aligning
    // and this edit only — the gate's heartbeat re-announce updates the platform's instance, not
    // them — so nothing else is expected to touch this description meanwhile.
    const { items } = await callCap<{ items: OperationSummaryWire[] }>(page, 'list_operations', {
      gatekeeperId,
    });
    const described = items.filter((op) => op.name === OBSERVE_OP && op.status === 'published');
    expect(described).toHaveLength(1);
    expect(described[0]).toMatchObject({ version: 1, description: OPERATION_DESCRIPTION });
  });
});
