import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  GateAddressChangeWire,
  GateInstanceWire,
  PlatformGateAddressChangeWire,
  SelfConnectionWire,
} from '@nexttime/shared';
import { loginWithPassword, reachLoginForm } from '../auth-helpers.js';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN, loginAsAdmin } from '../lib/auth.js';
import { type Locator, type Page, expect, test } from '../lib/test.js';
import {
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ⑬: 接入自己运行的门，换连接密钥；平台暂停与恢复它；平台采用门的新清单；把门换到新地址
 * （遗留 671、657、701）
 *
 * 步骤:
 *   1. 工作区所有者在「系统与授权」直接注册一个自己运行的门：表单打开时签出一把连接密钥，所有者把它放进
 *      门的 GATE_KERNEL_TOKEN_FILE，再填目标系统和门端点，注册（`create_connection`）。随后打开的
 *      「健康与操作」说门健康，清单导入成草稿。
 *   2. 所有者重新签发这个门的连接密钥（`rotate_connection_secret`）：旧密钥当场失效，「健康与操作」说
 *      未授权；把新密钥放进门之后，又说健康。
 *   3. 平台管理员在「集成 → 自己接入的门」暂停它，写上原因（`suspend_self_connection`）；所有者那边
 *      这个门的 Operation 全部不可用。
 *   4. 平台管理员恢复它（`resume_self_connection`）；所有者那边两个 Operation 又列出来了。
 *   5. 一个平台门实例公告了多一个 Operation 的新清单；平台管理员在「集成 → 门实例」审阅并采用
 *      （`confirm_gate_manifest`）。
 *   6. 所有者把门换到新地址（遗留 701）：「更换地址」先签出新地址用的连接密钥，所有者把它放进新地址上
 *      的门，填新地址、预览（内核用新密钥问那里的门，清单一致），提交给平台管理员审批
 *      （`preview_` / `propose_gate_address_change`）。第一次在「健康与操作」里撤回
 *      （`withdraw_`）；第二次平台管理员在「集成 → 自己接入的门」驳回并写原因（`reject_`）；第三次
 *      批准（`approve_`），门还是同一个 id，从此在新地址健康，Operation 原样保留。
 * 状态覆盖:
 *   - 空: 跳过——全新工作区本来就没有系统，`createFreshWorkspace` 之后第 1 步从空开始。
 *   - 错: 第 2 步就是一个：密钥换了、门还拿着旧的，「健康与操作」说未授权，不说健康。表单的字段级
 *     拒绝（端点是平台门、已接入过、带凭据）由 CompleteConnectionForm 的组件测试覆盖；换地址的
 *     拒绝（清单不一致、摘要过期、在途请求）由 GateAddressChangeSheet 的组件测试和内核集成测试覆盖。
 *   - 无权限: 第 3、4 步——暂停后所有者的「健康与操作」说平台暂停了它、原因，以及要找平台管理员
 *     恢复（遗留 674），这不是工作区能修的。非所有者看不到
 *     「重新签发连接密钥」由 SystemAccessCard 的组件测试覆盖。
 *   - 窄屏: 跳过——`00-gates/` 的截图门槛在 768 宽度下截过系统与授权和集成。
 * 成功判据:
 *   - 每个写操作都由真实内核答复，并从页面外读内核状态：所有者的 `get_gatekeeper`（健康、
 *     Operation、地址、待审批的换地址申请），平台的 `list_self_connections`（暂停的时间、人和原因，
 *     门的地址）、`get_gate_instance`（待采用的清单）与 `list_gate_address_changes`（驳回的原因、
 *     批准人）。
 *
 * 门是 CI 栈自己的 `ci-self-gate`（deploy/ci/self-gate/server.mjs）：它不持平台的门凭证，只认这个
 * 连接的密钥，并且每次请求都重新读密钥文件。把密钥放进门这一步是所有者在门那边做的事，不是控制台
 * 操作，这里由工作流给的脚本代劳（`E2E_SET_SELF_GATE_SECRET_CMD`，密钥走 stdin）。第 5 步的公告同样
 * 是门那边的事（`E2E_ANNOUNCE_GATE_CMD`，与 e2e.yml 给 ci-fixture-mcp 播种的公告是同一种调用）：
 * 新清单只有在管理员已经决定过的实例上才会被扣下待审，所以这个旅程公告自己的实例、在页面外把它设为
 * 停用，再公告一次多一个 Operation 的清单。第 6 步的新地址是同一个 `ci-self-gate` 在 CI 网络上的第二个
 * 名字（docker-compose.ci.yml 的 `ci-self-gate-moved`）：真实的搬迁是另起一个门，CI 里新旧地址背后是
 * 同一个进程、同一个密钥文件，所以给新地址放密钥的同时旧地址就答未授权了——测试在撤回和驳回之后把旧
 * 密钥放回去，批准之前让门拿着新密钥。测试按顺序跑，共享这一轮的工作区和门；重试时整组重来。
 */

const SET_SECRET_CMD = process.env.E2E_SET_SELF_GATE_SECRET_CMD;
const ANNOUNCE_CMD = process.env.E2E_ANNOUNCE_GATE_CMD;

const RUN = Date.now().toString(36);
const TARGET = `https://notes-${RUN}.example.test`;
const ENDPOINT = 'http://ci-self-gate:8090';
const IMPORTED = ['ci_self_archive_note', 'ci_self_list_notes'];
const SUSPENSION_REASON = `旅程⑬：核对这个门的用途（${RUN}）`;
const GATE_ID = `ci-journey13-${RUN}`;
const GATE_DISPLAY_NAME = `旅程⑬ 公告门 ${RUN}`;
const MOVED = 'http://ci-self-gate-moved:8090';
const REJECTION_REASON = `旅程⑬：先别换（${RUN}）`;

let workspaceName = '';
let ownerLogin = '';
let ownerPassword = '';
let gatekeeperId = '';
/** The secret the connection uses now — what the gate is given back after a move that did not
 *  happen (step 6). */
let connectionSecret = '';
/** The open proposal to move the gate, as the owner made it (step 6). */
let changeId = '';

interface CapResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface GatekeeperDetail {
  readonly id: string;
  readonly health: string;
  readonly operationCount: number;
  readonly operations: readonly { readonly name: string; readonly status: string }[];
  readonly platformSuspension?: { readonly suspendedAt: string; readonly reason?: string };
  readonly endpoint?: string;
  readonly pendingAddressChange?: GateAddressChangeWire;
}

/** A capability called from Node as whoever is signed in — setup and reads only. */
async function callCap<T>(page: Page, name: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api/cap/${name}`, {
    headers: { 'x-requested-with': 'nexttime' },
    data,
  });
  const body = (await res.json()) as CapResult;
  if (!body.ok) throw new Error(`capability ${name} failed: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** The owner's step on the gate's side: the secret into its GATE_KERNEL_TOKEN_FILE (stdin). */
function giveGateSecret(secret: string): void {
  expect(SET_SECRET_CMD, 'E2E_SET_SELF_GATE_SECRET_CMD (.github/workflows/e2e.yml)').toBeTruthy();
  expect(secret).not.toBe('');
  execFileSync('sh', [SET_SECRET_CMD as string], { input: secret, timeout: 30_000 });
}

/** A packaged gate's announcement of `GATE_ID`, made the way the gate makes it. */
function announce(operationNames: readonly string[]): void {
  expect(ANNOUNCE_CMD, 'E2E_ANNOUNCE_GATE_CMD (.github/workflows/e2e.yml)').toBeTruthy();
  const op = (name: string) => ({
    name,
    binding: { kind: 'mcp', tool_name: name },
    params_schema: { type: 'object', properties: {} },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    read_only_hint: true,
  });
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'journey13-')), 'announce.json');
  writeFileSync(
    file,
    JSON.stringify({
      gateId: GATE_ID,
      connector: 'fixture-mcp',
      transportKind: 'mcp',
      target: 'http://journey13-target.invalid:9000',
      endpoint: 'http://127.0.0.1:2',
      displayName: GATE_DISPLAY_NAME,
      operations: operationNames.map(op),
    }),
  );
  execFileSync('sh', [ANNOUNCE_CMD as string, file], { timeout: 60_000 });
}

async function signInAsOwner(page: Page): Promise<void> {
  await page.goto('/');
  await reachLoginForm(page);
  await loginWithPassword(page, ownerLogin, ownerPassword);
  await selectOwnedWorkspace(page);
}

async function ownerGatekeeper(page: Page): Promise<GatekeeperDetail> {
  return callCap<GatekeeperDetail>(page, 'get_gatekeeper', { gatekeeperId });
}

async function selfConnection(page: Page): Promise<SelfConnectionWire> {
  const { items } = await callCap<{ items: SelfConnectionWire[] }>(
    page,
    'list_self_connections',
    {},
  );
  const row = items.find((item) => item.gatekeeperId === gatekeeperId);
  expect(row, 'the journey’s self connection is listed').toBeDefined();
  return row as SelfConnectionWire;
}

/** The card's ⋯ → 健康与操作, then its health chip says `health`. */
async function openHealth(page: Page, health: string): Promise<void> {
  const card = page.getByTestId('gatekeeper-card').filter({ hasText: TARGET });
  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '健康与操作', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '健康与操作' });
  await expect(detail.getByTestId('gatekeeper-health')).toHaveText(health, { timeout: 15_000 });
}

async function closeDialog(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name })).toHaveCount(0);
}

async function openSelfConnections(page: Page) {
  await goToByLabel(page, '集成');
  await page.getByRole('tab', { name: '自己接入的门', exact: true }).click();
  const row = page.getByTestId(`self-connection-row-${gatekeeperId}`);
  await expect(row).toContainText(workspaceName, { timeout: 15_000 });
  return row;
}

/** Proposals to move a gate, as the platform lists them (`list_gate_address_changes`). */
async function addressChanges(
  page: Page,
  status: string,
): Promise<PlatformGateAddressChangeWire[]> {
  const { items } = await callCap<{ items: PlatformGateAddressChangeWire[] }>(
    page,
    'list_gate_address_changes',
    { status, limit: 200 },
  );
  return items.filter((item) => item.gatekeeperId === gatekeeperId);
}

/** A move's row in 「已结束的换地址申请」 under 自己接入的门, the history opened (legacy 717). */
async function endedMove(page: Page, changeId: string): Promise<Locator> {
  const history = page.getByTestId('gate-address-change-history');
  if ((await history.getAttribute('open')) === null) {
    await history.getByText('已结束的换地址申请', { exact: true }).click();
  }
  const row = page.getByTestId(`gate-address-change-history-row-${changeId}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

/**
 * The owner's three steps in 「更换地址」, from 系统与授权: ① the secret for the new address (put
 * into the gate there), ② the new address, previewed, ③ the proposal — left waiting for a
 * platform administrator. Returns the secret the proposal carries.
 */
async function proposeMove(page: Page): Promise<string> {
  await goToByLabel(page, '系统与授权');
  const card = page.getByTestId('gatekeeper-card').filter({ hasText: TARGET });
  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '更换地址', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /^更换「/ });
  await expect(sheet.getByTestId('gate-address-change-current')).toContainText(ENDPOINT, {
    timeout: 15_000,
  });
  await expect(sheet.getByText(/^这把连接密钥只显示一次/)).toBeVisible({ timeout: 15_000 });
  const secret = (await sheet.getByTestId('connection-secret-value').textContent())?.trim() ?? '';
  // --- 在新地址的门那边：放进新密钥（不是控制台操作） -------------------------------------------
  giveGateSecret(secret);

  await sheet.getByLabel('② 新地址').fill(MOVED);
  await sheet.getByRole('button', { name: '预览', exact: true }).click();
  // The kernel asked the gate at the new address, with the new secret: it describes the same
  // Operations (drafts only — nothing published yet), so nothing blocks the move.
  await expect(sheet.getByTestId('gate-address-change-manifest-match')).toBeVisible({
    timeout: 20_000,
  });
  const impact = sheet.getByTestId('gate-address-change-impact');
  // Nothing published yet reads as none, not as a count of 0 (UX acceptance of #1158).
  await expect(impact).toContainText('还没有已发布的 Operation');
  await expect(impact).toContainText('没有自动批准的 Operation');
  await sheet.getByRole('button', { name: '③ 提交给平台管理员审批', exact: true }).click();
  const pending = sheet.getByTestId('gate-address-change-pending');
  await expect(pending).toContainText(MOVED, { timeout: 15_000 });
  await expect(pending).toContainText(ENDPOINT);
  // The form is gone, replaced by the proposal: Escape closes without asking.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  return secret;
}

test.describe('Journey ⑬: 接入自己运行的门，换密钥，平台暂停、恢复与采用新清单', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('1. an owner connects a gate they run themselves', async ({ page }) => {
    test.setTimeout(120_000);
    const fresh = await createFreshWorkspace(page);
    workspaceName = fresh.workspaceName;
    ownerLogin = fresh.ownerLogin;
    await page.getByRole('button', { name: '登出', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible();
    ownerPassword = await signInAsFreshOwner(page, fresh.ownerLogin, fresh.ownerTemporaryPassword);
    await selectOwnedWorkspace(page);

    await goToByLabel(page, '系统与授权');
    await page.getByRole('button', { name: '更多接入方式', exact: true }).click();
    await page.getByRole('menuitem', { name: '直接注册门（旧路径）', exact: true }).click();
    const form = page.getByRole('dialog', { name: '直接注册门' });
    await expect(form.getByText(/^这把连接密钥只显示一次/)).toBeVisible({ timeout: 15_000 });
    const secret = (await form.getByTestId('connection-secret-value').textContent())?.trim() ?? '';
    // --- 在门那边：把密钥放进门（不是控制台操作） ------------------------------------------
    giveGateSecret(secret);

    await form.getByLabel('目标系统').fill(TARGET);
    await form.getByLabel('门端点').fill(ENDPOINT);
    await form.getByRole('button', { name: '注册门', exact: true }).click();
    await expect(form).toHaveCount(0, { timeout: 20_000 });
    const detail = page.getByRole('dialog', { name: '健康与操作' });
    await expect(detail.getByTestId('gatekeeper-health')).toHaveText('健康', { timeout: 15_000 });
    await closeDialog(page, '健康与操作');
    await expect(page.getByTestId('gatekeeper-card').filter({ hasText: TARGET })).toContainText(
      '自己接入',
    );

    const { items } = await callCap<{ items: { id: string; name: string }[] }>(
      page,
      'list_gatekeepers',
      {},
    );
    const connected = items.filter((gate) => gate.name === TARGET);
    expect(connected).toHaveLength(1);
    gatekeeperId = (connected[0] as { id: string }).id;
    const gate = await ownerGatekeeper(page);
    expect(gate.health).toBe('ok');
    expect(gate.operations.map((op) => op.name).sort()).toEqual(IMPORTED);
    expect(gate.operations.every((op) => op.status === 'draft')).toBe(true);
  });

  test('2. the owner rotates the secret; the gate answers only once it holds the new one', async ({
    page,
  }) => {
    expect(gatekeeperId, 'test 1 connected the gate').not.toBe('');
    await signInAsOwner(page);
    await goToByLabel(page, '系统与授权');

    const card = page.getByTestId('gatekeeper-card').filter({ hasText: TARGET });
    await card.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '重新签发连接密钥', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '重新签发连接密钥' });
    await expect(confirm).toContainText('旧密钥立即失效');
    await confirm.getByRole('button', { name: '签发', exact: true }).click();
    const reveal = page.getByRole('dialog', { name: '新的连接密钥' });
    await expect(reveal.getByText(/^这把连接密钥只显示一次/)).toBeVisible({ timeout: 15_000 });
    const rotated =
      (await reveal.getByTestId('connection-secret-value').textContent())?.trim() ?? '';
    connectionSecret = rotated;
    await reveal.getByRole('button', { name: '我已复制', exact: true }).click();
    await expect(reveal).toHaveCount(0);

    // The old secret stopped working the moment the rotation committed.
    await openHealth(page, '未授权');
    await closeDialog(page, '健康与操作');
    expect((await ownerGatekeeper(page)).health).toBe('unauthorized');

    // --- 在门那边：换上新密钥（不是控制台操作） ----------------------------------------------
    giveGateSecret(rotated);
    await openHealth(page, '健康');
    await closeDialog(page, '健康与操作');
    expect((await ownerGatekeeper(page)).health).toBe('ok');
  });

  test('3. a platform administrator suspends it; the owner’s operations are gone', async ({
    page,
  }) => {
    expect(gatekeeperId, 'test 1 connected the gate').not.toBe('');
    await loginAsAdmin(page);
    const row = await openSelfConnections(page);
    await expect(row).toContainText('使用中');
    await row.getByRole('button', { name: '暂停', exact: true }).click();
    const suspend = page.getByRole('dialog', { name: /^暂停「/ });
    await expect(suspend).toContainText(workspaceName);
    await suspend.getByLabel('原因（可选）').fill(SUSPENSION_REASON);
    await suspend.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(row).toContainText('已暂停', { timeout: 15_000 });
    await expect(row).toContainText(`原因：${SUSPENSION_REASON}`);

    const suspended = await selfConnection(page);
    expect(suspended.suspendedAt).not.toBeNull();
    expect(suspended.suspendedByLogin).toBe(ADMIN_LOGIN);
    expect(suspended.suspensionReason).toBe(SUSPENSION_REASON);
  });

  test('4. while suspended the owner is told so, why, and who lifts it', async ({ page }) => {
    expect(gatekeeperId, 'test 1 connected the gate').not.toBe('');
    await signInAsOwner(page);
    await goToByLabel(page, '系统与授权');
    await openHealth(page, '健康');
    // Legacy 674: not the generic empty state — the platform's suspension, the reason the
    // administrator gave and who lifts it, above the Operations it keeps.
    const detail = page.getByRole('dialog', { name: '健康与操作' });
    await expect(detail).toContainText('平台暂停了这个门');
    await expect(detail).toContainText(`原因：${SUSPENSION_REASON}`);
    await expect(detail).toContainText('请找平台管理员恢复它');
    await expect(detail).not.toContainText('这个门没有 Operation');
    for (const name of IMPORTED) await expect(detail).toContainText(name);
    const gate = await ownerGatekeeper(page);
    expect(gate.platformSuspension).toMatchObject({ reason: SUSPENSION_REASON });
    expect(gate.operations.map((op) => op.name).sort()).toEqual(IMPORTED);
    expect(gate.operationCount).toBe(2);
    // When and why, never who: who suspended it stays on the platform side.
    expect(Object.keys(gate.platformSuspension ?? {}).sort()).toEqual(['reason', 'suspendedAt']);
  });

  test('5. the administrator resumes it; the owner’s operations are back', async ({ page }) => {
    expect(gatekeeperId, 'test 1 connected the gate').not.toBe('');
    await loginAsAdmin(page);
    const row = await openSelfConnections(page);
    await expect(row).toContainText('已暂停');
    await row.getByRole('button', { name: '恢复', exact: true }).click();
    const resume = page.getByRole('dialog', { name: /^恢复「/ });
    await resume.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(row).toContainText('使用中', { timeout: 15_000 });
    await expect(row.getByRole('button', { name: '暂停', exact: true })).toBeVisible();

    const resumed = await selfConnection(page);
    expect(resumed).toMatchObject({
      suspendedAt: null,
      suspendedByLogin: null,
      suspensionReason: null,
    });
  });

  // Review of #1046 (test steward): resuming is for the owner — their operations come back, not
  // only the platform's fields clearing.
  test('5b. once resumed the owner’s operations are listed again', async ({ page }) => {
    expect(gatekeeperId, 'test 1 connected the gate').not.toBe('');
    await signInAsOwner(page);
    await goToByLabel(page, '系统与授权');
    await openHealth(page, '健康');
    const detail = page.getByRole('dialog', { name: '健康与操作' });
    await expect(detail).not.toContainText('这个门没有 Operation');
    await expect(detail).not.toContainText('平台暂停了这个门');
    for (const name of IMPORTED) await expect(detail).toContainText(name);
    const gate = await ownerGatekeeper(page);
    expect(gate.platformSuspension).toBeUndefined();
    expect(gate.operations.map((op) => op.name).sort()).toEqual(IMPORTED);
    expect(gate.operations.every((op) => op.status === 'draft')).toBe(true);
    expect(gate.operationCount).toBe(2);
  });

  test('6. the administrator adopts a gate instance’s new manifest', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdmin(page);

    // --- 准备（门那边与页面外）：一个已决定的实例，再公告多一个 Operation 的新清单 ------------
    announce(['journey13_list']);
    await callCap(page, 'update_gate_instance', { gateId: GATE_ID, status: 'disabled' });
    announce(['journey13_list', 'journey13_count']);
    const held = await callCap<GateInstanceWire>(page, 'get_gate_instance', { gateId: GATE_ID });
    expect(held.pendingManifest, 'the second announcement is held for review').not.toBeNull();

    await goToByLabel(page, '集成');
    await page.getByRole('tab', { name: '门实例', exact: true }).click();
    const instance = page.getByTestId(`gate-instance-row-${GATE_ID}`);
    await expect(instance).toContainText('新清单待采用', { timeout: 15_000 });
    await instance.getByRole('button', { name: '详情', exact: true }).click();
    const panel = page.getByRole('dialog', { name: GATE_DISPLAY_NAME });
    await expect(panel).toContainText('journey13_count');
    await panel.getByRole('button', { name: '审阅并采用', exact: true }).click();
    const adopt = page.getByRole('dialog', { name: '采用门的新清单' });
    await adopt.getByRole('button', { name: '采用', exact: true }).click();
    await expect(panel.getByRole('button', { name: '审阅并采用', exact: true })).toHaveCount(0, {
      timeout: 15_000,
    });

    const adopted = await callCap<GateInstanceWire>(page, 'get_gate_instance', { gateId: GATE_ID });
    expect(adopted.pendingManifest).toBeNull();
    expect(adopted.operationCount).toBe(2);
  });

  test('7. the owner proposes moving the gate, withdraws it, and proposes it again', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    expect(connectionSecret, 'test 2 gave the connection its secret').not.toBe('');
    await signInAsOwner(page);
    const spent = await proposeMove(page);
    expect(spent).not.toBe(connectionSecret);
    const proposed = await ownerGatekeeper(page);
    expect(proposed.endpoint).toBe(ENDPOINT);
    expect(proposed.pendingAddressChange).toMatchObject({
      status: 'proposed',
      fromEndpoint: ENDPOINT,
      toEndpoint: MOVED,
    });

    // Legacy 716: the gate's card says a move waits, without opening anything.
    const card = page.getByTestId('gatekeeper-card').filter({ hasText: TARGET });
    const mark = card.getByTestId('gatekeeper-address-change-pending');
    await expect(mark.getByTestId('gatekeeper-address-change-pending-label')).toHaveText(
      '换地址待审批',
      { timeout: 15_000 },
    );

    // --- 在门那边：放回现在的密钥（CI 里新旧地址背后是同一个门，见文件头） ------------------------
    giveGateSecret(connectionSecret);
    // Until a platform administrator decides, the gate works where it is; 健康与操作 says where
    // that is and what is waiting — and withdraws it.
    await openHealth(page, '健康');
    const detail = page.getByRole('dialog', { name: '健康与操作' });
    await expect(detail.getByTestId('gatekeeper-endpoint')).toHaveText(ENDPOINT);
    const pending = detail.getByTestId('gate-address-change-pending');
    await expect(pending).toContainText(MOVED);
    await pending.getByRole('button', { name: '撤回', exact: true }).click();
    const withdraw = page.getByRole('dialog', { name: '撤回换地址的申请' });
    await expect(withdraw).toContainText('这次用的连接密钥作废');
    await withdraw.getByRole('button', { name: '撤回', exact: true }).click();
    // The open confirm hides 健康与操作 from the accessibility tree, so `pending` (read through the
    // dialog's role) matches nothing until the confirm is gone; wait for it first, else Escape lands
    // on the confirm while the withdrawal is still in flight and the drawer stays open.
    await expect(withdraw).toHaveCount(0, { timeout: 15_000 });
    await expect(detail.getByTestId('gatekeeper-endpoint')).toHaveText(ENDPOINT);
    await expect(pending).toHaveCount(0);
    await closeDialog(page, '健康与操作');
    // Legacy 716: and the card no longer says a move waits.
    await expect(mark).toHaveCount(0, { timeout: 15_000 });
    const withdrawn = await ownerGatekeeper(page);
    expect(withdrawn.pendingAddressChange).toBeUndefined();
    expect(withdrawn.endpoint).toBe(ENDPOINT);
    expect(withdrawn.health).toBe('ok');

    // Again, for the platform administrator to decide: 更换地址 starts over with a new secret.
    const again = await proposeMove(page);
    expect(again).not.toBe(spent);
    changeId = (await ownerGatekeeper(page)).pendingAddressChange?.id ?? '';
    expect(changeId).not.toBe('');
    giveGateSecret(connectionSecret);
  });

  test('8. a platform administrator rejects the move, with a reason', async ({ page }) => {
    expect(changeId, 'test 7 proposed a move').not.toBe('');
    await loginAsAdmin(page);
    await openSelfConnections(page);
    const row = page.getByTestId(`gate-address-change-row-${changeId}`);
    await expect(row).toContainText(workspaceName);
    await expect(row).toContainText(ENDPOINT);
    await expect(row).toContainText(MOVED);
    await row.getByRole('button', { name: '驳回', exact: true }).click();
    const reject = page.getByRole('dialog', { name: `驳回换到 ${MOVED}` });
    await reject.getByLabel('原因（可选）').fill(REJECTION_REASON);
    await reject.getByRole('button', { name: '驳回', exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    // Legacy 717: it ended, so the history under the list has it, with how and why.
    const ended = await endedMove(page, changeId);
    await expect(ended).toContainText('已驳回');
    await expect(ended).toContainText(REJECTION_REASON);
    await expect(ended).toContainText(ADMIN_LOGIN as string);

    const rejected = (await addressChanges(page, 'rejected')).find((c) => c.id === changeId);
    expect(rejected).toMatchObject({
      toEndpoint: MOVED,
      rejectionReason: REJECTION_REASON,
      decidedByLogin: ADMIN_LOGIN,
    });
    expect((await selfConnection(page)).endpoint).toBe(ENDPOINT);
  });

  test('9. the owner proposes the move once more and leaves the gate the new secret', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    expect(changeId, 'test 7 proposed a move').not.toBe('');
    await signInAsOwner(page);
    const gate = await ownerGatekeeper(page);
    expect(gate.pendingAddressChange, 'the rejected move is no longer open').toBeUndefined();
    expect(gate.endpoint).toBe(ENDPOINT);
    // This time the gate keeps the secret the proposal carries: once the move is applied, it is
    // the connection's (and the old address, the same gate here, answers 未授权 meanwhile).
    connectionSecret = await proposeMove(page);
    changeId = (await ownerGatekeeper(page)).pendingAddressChange?.id ?? '';
    expect(changeId).not.toBe('');
  });

  test('10. the administrator approves; the gate keeps its id at the new address', async ({
    page,
  }) => {
    expect(changeId, 'test 9 proposed a move').not.toBe('');
    await loginAsAdmin(page);
    const connection = await openSelfConnections(page);
    const row = page.getByTestId(`gate-address-change-row-${changeId}`);
    await expect(row).toContainText(MOVED);
    await row.getByRole('button', { name: '批准', exact: true }).click();
    const approve = page.getByRole('dialog', { name: `批准换到 ${MOVED}` });
    await expect(approve).toContainText(workspaceName);
    await approve.getByRole('button', { name: '批准', exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 20_000 });
    await expect(connection).toContainText(MOVED, { timeout: 15_000 });
    await expect(await endedMove(page, changeId)).toContainText('已换址');

    const applied = (await addressChanges(page, 'applied')).find((c) => c.id === changeId);
    expect(applied).toMatchObject({
      fromEndpoint: ENDPOINT,
      toEndpoint: MOVED,
      decidedByLogin: ADMIN_LOGIN,
    });
    const moved = await selfConnection(page);
    expect(moved.gatekeeperId).toBe(gatekeeperId);
    expect(moved.endpoint).toBe(MOVED);
  });

  test('11. the owner finds the gate healthy at the new address, its Operations kept', async ({
    page,
  }) => {
    expect(gatekeeperId, 'test 1 connected the gate').not.toBe('');
    await signInAsOwner(page);
    await goToByLabel(page, '系统与授权');
    await openHealth(page, '健康');
    const detail = page.getByRole('dialog', { name: '健康与操作' });
    await expect(detail.getByTestId('gatekeeper-endpoint')).toHaveText(MOVED);
    await expect(detail.getByTestId('gate-address-change-pending')).toHaveCount(0);
    for (const name of IMPORTED) await expect(detail).toContainText(name);
    const gate = await ownerGatekeeper(page);
    expect(gate.id).toBe(gatekeeperId);
    expect(gate.health).toBe('ok');
    expect(gate.endpoint).toBe(MOVED);
    expect(gate.pendingAddressChange).toBeUndefined();
    expect(gate.operations.map((op) => op.name).sort()).toEqual(IMPORTED);
  });
});
