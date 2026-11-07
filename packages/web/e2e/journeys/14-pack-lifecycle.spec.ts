import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PackWire } from '@nexttime/shared';
import { loginWithPassword, reachLoginForm } from '../auth-helpers.js';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import { type Page, expect, test } from '../lib/test.js';
import {
  asAdmin,
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ⑭: 能力包的一生——管理员提案应用后导出成包，放进部署，第二个工作区审阅权限边界后装上、
 * 升级、撤销（缺口 G9，批次 E；遗留 656）
 *
 * 步骤:
 *   1. 平台管理员建一个试验工作区、选一个常规工作区 A 为目标，让管理员智能体提一份管理员提案（⑨ 的
 *      CI 标记：A 一个新 Skill，平台一个门宿主实例），在平台面应用平台部分；A 的所有者在「能力目录 →
 *      管理员提案」应用 A 的部分（应用即核验一次）。
 *   2. 平台管理员在「平台 → 管理员提案」这份提案的 A 部分「导出成能力包…」，写简介、导出、下载 tar
 *      （`export_admin_proposal_pack`，包名是提案的来源名，版本 1）。
 *   3. 维护者按 operations.md §14.10 把 tar 解进 `config/packs/`（主机那边的事，不是控制台操作：
 *      `E2E_EXTRA_PACK_CMD tar`）。「平台 → 模块」的「本部署附加的能力包」列出它，没有被丢掉的包；
 *      A 的「能力包」里它直接是「已是最新」，不用再装（同一批 id）。
 *   4. 常规工作区 B 的所有者在「能力包」选它（标着「本部署附加」）、「安装 v1…」：审阅里这个 Skill
 *      是新增的，改变权限边界；没勾确认时「安装」不可点，并写着「还差：勾选 1 项权限边界确认」；勾上、
 *      安装，状态「已是最新」（遗留 656）。
 *   5. 维护者按 §14.1 给它加版本 2（同一个 Skill 改了正文：`E2E_EXTRA_PACK_CMD version`）。B 的
 *      「能力包」里它「有新版」，「升级到 v2…」：审阅同样要勾确认；升级后「已是最新」，装着 v2。
 *   6. B 的所有者在「安装历史」撤销这次升级：回到 v1，能力包又是「有新版」。
 * 状态覆盖:
 *   - 空: A 和 B 一开始都没有这个包（它还不在部署里）；跳过「能力包」页的空态——部署总带着自带包。
 *   - 错: 第 4、5 步——没勾权限边界确认时安装 / 升级按钮不可点，并说还差什么。导出被拒（未核验、
 *     重名等）由 ExportPack 的组件测试和内核集成测试覆盖。
 *   - 无权限: 跳过——非所有者只看到「安装和升级能力包由工作区所有者操作」，由 PacksTab 的组件测试
 *     覆盖；平台面看不到工作区部分的内容，由 ⑨ 覆盖。
 *   - 窄屏: 跳过——`00-gates/` 的截图门槛在 768 宽度下截过「能力目录」。
 * 成功判据:
 *   - 导出的 tar 能被维护者按 runbook 原样解进去，内核当场读到（不重启），`list_packs` 里它是
 *     `source: extra`。
 *   - 每一步页面说出的结果，和从页面外读的 `list_packs`（状态、装着的版本）一致。
 *
 * 维护者的两步由工作流给的脚本代劳（`E2E_EXTRA_PACK_CMD`，.github/workflows/e2e.yml）。包名固定是
 * 来源名 `ci-admin-journey`（fake-admin-propose.ts），一轮 CI 只能放进去一个：所以重试时先把上次放进去
 * 的移出（§14.10「撤掉一个附加包」），再从头走；之后的 spec 看得到它（modules.spec.ts 只要求没有被
 * 丢掉的包）。六个测试按顺序跑，共享这一轮的工作区和包；重试时整组重来。
 */

// fake-runtime.ts's `FAKE_ADMIN_PROPOSE_MARKER`, as ⑨ keeps it: the literal, so a search finds both
// sides of the contract.
const FAKE_ADMIN_PROPOSE_MARKER = '__nexttime_fake_admin_propose__';
/** fake-admin-propose.ts's `FAKE_ADMIN_PROPOSAL_SOURCE_NAME`: the exported pack's name. */
const PACK = 'ci-admin-journey';
const PROPOSED_REPLY =
  /propose_admin_proposal: proposed "(CI admin proposal ([a-z0-9]+))" \(([0-9a-f-]{36})\), now proposed\./;
const EXTRA_PACK_CMD = process.env.E2E_EXTRA_PACK_CMD;

const RUN = Date.now().toString(36);
const SUMMARY = `旅程⑭：检查知识库回答的方法（${RUN}）`;
const V2_LINE = `3. Say which passage each claim rests on (journey 14, ${RUN}).`;

let ownerA = { workspaceName: '', login: '', password: '' };
let ownerB = { workspaceName: '', login: '', password: '' };
let proposalId = '';
let skillName = '';
let exported = '';

/** The maintainer's side of the deployment, run by the workflow's script. */
function maintainer(...args: string[]): void {
  expect(EXTRA_PACK_CMD, 'E2E_EXTRA_PACK_CMD (.github/workflows/e2e.yml)').toBeTruthy();
  execFileSync('sh', [EXTRA_PACK_CMD as string, ...args], { timeout: 60_000, stdio: 'inherit' });
}

/** `list_packs` as whoever is signed in, from Node — a read, never what the page did. */
async function packState(page: Page): Promise<PackWire | undefined> {
  const res = await page.request.post('/api/cap/list_packs', {
    headers: { 'x-requested-with': 'nexttime' },
    data: {},
  });
  const body = (await res.json()) as { ok: boolean; result?: { items: PackWire[] } };
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return body.result?.items.find((pack) => pack.name === PACK);
}

async function signInAs(page: Page, owner: { login: string; password: string }): Promise<void> {
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithPassword(page, owner.login, owner.password);
  await selectOwnedWorkspace(page);
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible();
}

/** A fresh regular workspace and its owner, signed in once (the forced password change done). */
async function freshOwner(page: Page) {
  const fresh = await createFreshWorkspace(page);
  await signOut(page);
  const password = await signInAsFreshOwner(page, fresh.ownerLogin, fresh.ownerTemporaryPassword);
  await selectOwnedWorkspace(page);
  await signOut(page);
  return { workspaceName: fresh.workspaceName, login: fresh.ownerLogin, password };
}

/** 「能力目录 → 能力包」, this pack selected. */
async function openPack(page: Page) {
  await goToByLabel(page, '能力目录');
  await page.getByRole('tab', { name: /^能力包/ }).click();
  await page.getByRole('listitem').filter({ hasText: PACK }).click();
  const detail = page.getByTestId('catalog-pack-detail');
  await expect(detail.getByTestId('catalog-pack-title')).toHaveText(PACK, { timeout: 15_000 });
  return detail;
}

/** A review that moves an authority boundary: `confirmLabel` held, saying what is still needed,
 *  until its one confirmation is ticked (I-A4) — the install, the upgrade and the rollback alike. */
async function confirmBoundary(page: Page, dialogName: string, confirmLabel: string) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  const confirm = dialog.getByRole('button', { name: confirmLabel, exact: true });
  const tick = dialog.getByRole('checkbox', { name: /^我确认这会改变权限边界：/ });
  await expect(tick).toHaveCount(1, { timeout: 15_000 });
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByText('还差：勾选 1 项权限边界确认')).toBeVisible();
  await tick.check();
  await expect(dialog.getByText(/还差：/)).toHaveCount(0);
  await confirm.click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
}

test.describe('Journey ⑭: 能力包的一生：导出、放进部署、审阅后安装、升级、撤销', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('1. an admin proposal adds a Skill to workspace A, and its owner applies it', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // A retry starts from no exported pack: the last attempt's is moved out (§14.10).
    maintainer('remove', PACK);

    ownerA = await freshOwner(page);
    ownerB = await freshOwner(page);

    // --- 试验工作区、目标 A（同 ⑩） ---------------------------------------------------------------
    await asAdmin(page);
    const trialName = `journey14-trial-${RUN}`;
    await goToByLabel(page, '管理员智能体');
    await page.getByRole('link', { name: '新建试验工作区' }).click();
    const createDrawer = page.getByTestId('create-workspace-drawer');
    await createDrawer.getByRole('textbox', { name: '名称', exact: true }).fill(trialName);
    await expect(createDrawer.getByTestId('create-workspace-owner')).toHaveValue(
      new RegExp(`^${ADMIN_LOGIN} — `),
      { timeout: 15_000 },
    );
    await createDrawer.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page).toHaveURL(/#\/platform\/admin-agent\/[^/]+$/, { timeout: 20_000 });
    const card = page.getByTestId('admin-agent-workspace').filter({ hasText: trialName });
    await card.getByRole('button', { name: '选择目标工作区' }).click();
    const targets = page.getByRole('dialog').filter({ hasText: '选择目标工作区' });
    const targetBox = targets.getByRole('checkbox', { name: ownerA.workspaceName, exact: true });
    const search = targets.getByLabel('按名称筛选工作区');
    await expect(targetBox.or(search).first()).toBeVisible({ timeout: 15_000 });
    if (await search.isVisible()) await search.fill(ownerA.workspaceName);
    await targetBox.check();
    await targets.getByRole('button', { name: '保存目标' }).click();
    await expect(targets).toBeHidden({ timeout: 15_000 });

    // --- 管理员对话：提一份管理员提案（⑨ 的标记） ------------------------------------------------
    await card.getByRole('button', { name: '打开管理员对话' }).click();
    await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'connected', {
      timeout: 20_000,
    });
    await page.getByPlaceholder('输入消息…').fill(`${FAKE_ADMIN_PROPOSE_MARKER} 提一份管理员提案`);
    await page.getByRole('button', { name: '发送' }).click();
    const reply = page.locator('.message-assistant .message-text').last();
    await expect(reply).toHaveText(PROPOSED_REPLY, { timeout: 30_000 });
    const matched = PROPOSED_REPLY.exec((await reply.textContent()) ?? '');
    const title = matched?.[1] ?? '';
    skillName = `ci-admin-check-${matched?.[2] ?? ''}`;
    proposalId = matched?.[3] ?? '';
    expect(proposalId).not.toBe('');

    // --- 平台部分在平台面应用（工作区部分要等它） ------------------------------------------------
    await goToByLabel(page, '管理员提案');
    await page.getByRole('button', { name: new RegExp(title) }).click();
    const detail = page.getByTestId('platform-admin-proposal-detail');
    const review = detail.getByTestId('platform-segment-review');
    await expect(review.getByTestId('platform-segment-items')).toBeVisible({ timeout: 15_000 });
    const ticks = review.getByRole('checkbox');
    for (let index = 0; index < (await ticks.count()); index += 1) await ticks.nth(index).check();
    await review.getByRole('button', { name: '应用平台部分…' }).click();
    await page
      .getByRole('dialog', { name: '应用平台部分' })
      .getByRole('button', { name: '应用', exact: true })
      .click();
    await expect(detail.getByTestId('platform-admin-proposal-platform-status')).toHaveAttribute(
      'data-status',
      'applied',
      { timeout: 15_000 },
    );
    await signOut(page);

    // --- A 的所有者应用 A 的部分 -------------------------------------------------------------------
    await signInAs(page, ownerA);
    await goToByLabel(page, '能力目录');
    await page.getByRole('tab', { name: /^管理员提案/ }).click();
    await page.getByRole('button', { name: new RegExp(title) }).click();
    const part = page.getByTestId('catalog-proposal-detail');
    const items = part.getByTestId('catalog-proposal-items');
    await expect(items).toContainText(skillName, { timeout: 15_000 });
    const partTicks = items.getByRole('checkbox');
    for (let index = 0; index < (await partTicks.count()); index += 1) {
      await partTicks.nth(index).check();
    }
    await part.getByRole('button', { name: '应用…', exact: true }).click();
    await page
      .getByRole('dialog', { name: '应用这份管理员提案' })
      .getByRole('button', { name: '应用', exact: true })
      .click();
    await expect(part.getByTestId('catalog-proposal-status')).toHaveAttribute(
      'data-status',
      'applied',
      { timeout: 15_000 },
    );
    // Not in the deployment yet: neither A nor B has a pack by that name.
    expect(await packState(page)).toBeUndefined();
  });

  test('2. the platform administrator exports A’s part as a pack and downloads it', async ({
    page,
  }) => {
    expect(proposalId, 'test 1 made the proposal').not.toBe('');
    await asAdmin(page);
    await page.goto(`/#/platform/admin-proposals/${proposalId}`);
    const detail = page.getByTestId('platform-admin-proposal-detail');
    const part = detail
      .getByTestId(/^platform-admin-proposal-workspace-part-[0-9]+$/)
      .filter({ hasText: ownerA.workspaceName });
    await expect(part).toContainText('所有者已应用', { timeout: 15_000 });
    await part.getByRole('button', { name: '导出成能力包…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导出成能力包' });
    await dialog.getByRole('textbox', { name: '简介' }).fill(SUMMARY);
    await dialog.getByRole('button', { name: '导出', exact: true }).click();
    await expect(dialog.getByText(`已导出 ${PACK} v1`)).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toContainText(`${PACK}/1/pack.yaml`);
    await expect(dialog).toContainText(`${PACK}/1/skills/${skillName}.md`);

    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: `下载 ${PACK}-1.tar` }).click();
    const tar = path.join(mkdtempSync(path.join(tmpdir(), 'journey14-')), `${PACK}-1.tar`);
    await (await download).saveAs(tar);
    // What the console built is a tar a maintainer's `tar` reads: the files it listed, nothing else.
    const listed = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(listed).toContain(`${PACK}/1/pack.yaml`);
    expect(listed).toContain(`${PACK}/1/skills/${skillName}.md`);
    exported = tar;
  });

  test('3. a maintainer unpacks it into config/packs; the deployment and workspace A see it', async ({
    page,
  }) => {
    expect(exported, 'test 2 downloaded the tar').not.toBe('');
    // --- 在主机那边：按 §14.10 解进 config/packs/（不是控制台操作） ------------------------------
    maintainer('tar', exported);

    await asAdmin(page);
    await goToByLabel(page, '模块');
    const extra = page.getByTestId('extra-packs');
    await extra.getByRole('button', { name: '重新读取' }).click();
    await expect(extra.getByTestId(`extra-pack-${PACK}`)).toContainText('v1', { timeout: 15_000 });
    await expect(extra.getByTestId('extra-packs-skipped')).toHaveCount(0);
    await signOut(page);

    // A has it already: the same ids, the same content — up to date, nothing to install.
    await signInAs(page, ownerA);
    const detail = await openPack(page);
    await expect(detail).toContainText('本部署附加');
    await expect(detail).toContainText('已是最新');
    await expect(detail.getByRole('button', { name: /^安装 v/ })).toHaveCount(0);
    expect(await packState(page)).toMatchObject({
      source: 'extra',
      status: 'up_to_date',
      installedVersion: 1,
    });
  });

  test('4. workspace B installs it once its owner confirms the authority boundary (legacy 656)', async ({
    page,
  }) => {
    expect(exported, 'test 3 placed the pack').not.toBe('');
    await signInAs(page, ownerB);
    const detail = await openPack(page);
    await expect(detail).toContainText('未安装');
    await detail.getByRole('button', { name: '安装 v1…', exact: true }).click();
    await confirmBoundary(page, '安装 v1', '安装');
    await expect(detail).toContainText('已是最新', { timeout: 15_000 });
    expect(await packState(page)).toMatchObject({ status: 'up_to_date', installedVersion: 1 });
  });

  test('5. a maintainer adds version 2; B upgrades to it after the same review', async ({
    page,
  }) => {
    expect(exported, 'test 3 placed the pack').not.toBe('');
    // --- 在主机那边：按 §14.1 加一个新版本目录（不是控制台操作） ---------------------------------
    const work = mkdtempSync(path.join(tmpdir(), 'journey14-v2-'));
    execFileSync('tar', ['-xf', exported, '-C', work]);
    const v1 = path.join(work, PACK, '1');
    const v2 = path.join(work, PACK, '2');
    cpSync(v1, v2, { recursive: true });
    const manifest = path.join(v2, 'pack.yaml');
    const yaml = readFileSync(manifest, 'utf8');
    expect(yaml).toMatch(/^version: 1$/m);
    writeFileSync(manifest, yaml.replace(/^version: 1$/m, 'version: 2'));
    const [skillFile] = readdirSync(path.join(v2, 'skills'));
    const skillPath = path.join(v2, 'skills', skillFile as string);
    writeFileSync(skillPath, `${readFileSync(skillPath, 'utf8').trimEnd()}\n${V2_LINE}\n`);
    maintainer('version', work, `${PACK}/2`);

    await signInAs(page, ownerB);
    const detail = await openPack(page);
    await expect(detail).toContainText('有新版', { timeout: 15_000 });
    await detail.getByRole('button', { name: '升级到 v2…', exact: true }).click();
    await confirmBoundary(page, '升级到 v2', '升级');
    await expect(detail).toContainText('已是最新', { timeout: 15_000 });
    expect(await packState(page)).toMatchObject({ status: 'up_to_date', installedVersion: 2 });
  });

  test('6. B rolls the upgrade back under install history: v1 again, v2 offered again', async ({
    page,
  }) => {
    expect(exported, 'test 3 placed the pack').not.toBe('');
    await signInAs(page, ownerB);
    const detail = await openPack(page);
    await detail.getByRole('link', { name: '查看安装记录' }).click();
    const change = page.getByTestId('catalog-change-detail');
    await expect(change).toContainText(`能力包 ${PACK} v2`, { timeout: 15_000 });
    await change.getByRole('button', { name: '撤销这条安装记录…' }).click();
    // Back to v1's text is a change of what the Skill tells a Worker: confirmed like the upgrade.
    await confirmBoundary(page, '撤销这条安装记录', '撤销');
    await expect(change.getByTestId('catalog-change-status')).toHaveText('已撤销', {
      timeout: 15_000,
    });

    const back = await openPack(page);
    await expect(back).toContainText('有新版', { timeout: 15_000 });
    await expect(back.getByRole('button', { name: '升级到 v2…' })).toBeVisible();
    expect(await packState(page)).toMatchObject({ status: 'outdated', installedVersion: 1 });
  });
});
