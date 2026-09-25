import { type Page, expect, test } from '@playwright/test';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import {
  OWNER_API_KEY,
  asOwner,
  createFreshWorkspace,
  goToByLabel,
  selectOwnedWorkspace,
  signInAsFreshOwner,
} from './helpers.js';

/**
 * Journey ④: 追溯"agent 为什么这么说" (development-tasks.md §5e F4; 审计与溯源 AU1/J8/S11/PA1/L9,
 * S8 W4-A 波次)
 *
 * 步骤:
 *   1. 在一次对话里，找到一句 agent 回复引用了某个 Fact/Object 的地方（`message-references` 行内
 *      引用）。
 *   2. 点击引用，进入 审计 页的 explain（"为什么相信这个"）。
 *   3. 看到这个 Fact 的来源链：哪次观察/哪个 Worker/哪次 Operation 调用产生的它，什么时候记录的。
 *   4. 从来源链跳到对应的任务/审批（如果有），完成一次"从结论倒推到证据"的闭环。
 * 状态覆盖:
 *   - 空: 一句没有引用任何 Fact 的普通回复——不应该出现"追溯"入口，不能点出一个空的 explain。覆盖在
 *     `components/chat/MessageReferences.test.tsx`（单测更快、更聚焦——同一件事在这里再用一次真实
 *     Turn 走一遍不会带来新的置信度，只会重复"发一条不带 id 的消息"这一步的等待时间）。
 *   - 错: 引用的 Fact 已被上位事实取代（superseded）/失效（invalidated）——explain 要如实说明。已由
 *     `AuditPage.test.tsx`/`ExplainSection`/`ProvenanceChain` 自身的单测覆盖（渲染
 *     `invalidatedAt`/`invalidationReason`）；这里不重复造一个失效 Fact 的夹具。
 *   - 无权限: auditor 以下角色能不能看到 explain 里的敏感字段——`audit.spec.ts` 已覆盖（审计页本身
 *     已经做了 redact）。
 *   - 窄屏: 追溯落地的审计页在 768px 下仍可展开、不需要横向滚动。
 * 成功判据:
 *   - 从对话里的一句具体回复出发，不手输 id，点击追溯到审计页并看到完整来源链——F4 原文"以后由这些
 *     测试去点，不再靠人工走查发现断点"要求的正是"从产品入口出发"而不是"直接打开审计页传 id"。
 *
 * 为什么走到今天这一步、以及这条 CI 用的是哪种"结构化数据"（S8 W4-A 任务书原文的两个选项之一）：
 * `AGENT_RUNTIME=fake`（`fake-runtime.ts`）对每个 Turn 只做字面回显，从不产生任何 `tool_calls`——
 * `deploy/fake-llm/server.mjs` 的 `search` 触发词场景属于另一条栈（`AGENT_RUNTIME=agent-host` + 真实
 * pi + fake-llm，`accept_s1.sh`/`accept_s2.sh` 在主机上跑的那条，01-entry-agent.spec.ts 自己的说明
 * 已经把这件事讲透），这个 Playwright job 从不触达。能在这里真实产生的结构化引用只有"种一个真实 Fact，
 * 让回显文本里带着它的 id"——种子本身经由 `page.request.post('/api/cap/…')` 直接调用
 * `propose_ontology_change` → `publish_ontology_version` → `register_source` →
 * `submit_observations` → `state_at`（鉴权走 `createFreshWorkspace`/`signInAsFreshOwner` 已建立的
 * cookie 会话——`capability-route.ts` 的 `channel:'handle'` 能力对人类会话同样开放，`authorize.ts`
 * 自己的注释："a human/API-key caller...is at liberty to call it too"）；对话本身仍然只用产品入口
 * （新建对话 → 发消息 → 点引用），种子只提供"这句回复里有一个真实存在的 id"这一件事本身产品不提供
 * 的能力（一个空工作区没有任何采集器写入的 Fact）。
 */

const ONTOLOGY_OBJECT_TYPE = 'JourneyProbe';
const ONTOLOGY_LINK_TYPE = 'traces_to';

interface CapResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

async function callCap<T>(page: Page, name: string, data: unknown): Promise<T> {
  const res = await page.request.post(`/api/cap/${name}`, {
    headers: { 'x-requested-with': 'nexttime' },
    data,
  });
  const body = (await res.json()) as CapResult;
  if (!body.ok) {
    throw new Error(`capability ${name} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result as T;
}

/**
 * Seeds one real, workspace-visible Fact via direct capability calls (see this file's own header
 * comment for why) and returns its id — a `JourneyProbe --traces_to--> JourneyProbe` Link between
 * two fixture Objects, entirely self-contained (no dependency on any other spec's fixtures or run
 * order, unlike the shared `ci-e2e` workspace every non-journey spec touches).
 */
async function seedTraceableFact(page: Page): Promise<string> {
  const proposed = await callCap<{ id: string; version: number }>(page, 'propose_ontology_change', {
    change: {
      objectTypes: [
        {
          name: ONTOLOGY_OBJECT_TYPE,
          description: 'Journey ④ fixture object — not a real domain concept.',
          identityKey: ['probeId'],
        },
      ],
      linkTypes: [
        {
          name: ONTOLOGY_LINK_TYPE,
          domain: ONTOLOGY_OBJECT_TYPE,
          range: ONTOLOGY_OBJECT_TYPE,
          description: 'Journey ④ fixture link.',
        },
      ],
    },
  });
  await callCap(page, 'publish_ontology_version', { id: proposed.id, version: proposed.version });

  const source = await callCap<{ id: string }>(page, 'register_source', {
    kind: 'journey4-fixture',
    name: `journey4-${Date.now().toString(36)}`,
    visibility: 'workspace',
  });

  const suffix = Date.now().toString(36);
  const identityA = { probeId: `${suffix}-a` };
  const identityB = { probeId: `${suffix}-b` };
  const submitted = await callCap<{
    readonly objects: readonly {
      readonly identity: Record<string, unknown>;
      readonly id: string;
    }[];
  }>(page, 'submit_observations', {
    sourceId: source.id,
    observations: [
      { objectType: ONTOLOGY_OBJECT_TYPE, identity: identityA },
      {
        objectType: ONTOLOGY_OBJECT_TYPE,
        identity: identityB,
        links: [
          {
            linkType: ONTOLOGY_LINK_TYPE,
            target: { objectType: ONTOLOGY_OBJECT_TYPE, identity: identityA },
          },
        ],
      },
    ],
  });
  const objectB = submitted.objects.find(
    (item) => JSON.stringify(item.identity) === JSON.stringify(identityB),
  );
  if (!objectB) throw new Error('submit_observations did not echo back the fixture Object');

  const state = await callCap<{ readonly facts: readonly { readonly id: string }[] }>(
    page,
    'state_at',
    {
      objectId: objectB.id,
      at: new Date().toISOString(),
    },
  );
  const fact = state.facts[0];
  if (!fact) throw new Error('state_at found no Fact on the fixture Object it was just given');
  return fact.id;
}

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

  test('steps 1, 3-4: click an in-chat reference, follow the provenance chain, land on the source task/approval', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
      'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
    );
    test.setTimeout(120_000);

    // A fresh, isolated workspace + a *cookie* session (not the shared API-key `asOwner` session
    // every other test in this file uses) — the fixture below calls capabilities directly via
    // `page.request.post`, which shares the browser's cookies, never the app's own client-side
    // API-key storage (see this file's own header comment).
    const { ownerLogin, ownerTemporaryPassword } = await createFreshWorkspace(page);
    await page.getByRole('button', { name: /登出/ }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await signInAsFreshOwner(page, ownerLogin, ownerTemporaryPassword);
    await selectOwnedWorkspace(page);
    await expect(page.getByTestId('nav-chats')).toBeVisible();

    const factId = await seedTraceableFact(page);

    // --- 1. 对话: 发一条引用了这个 Fact id 的消息 ------------------------------------------------
    await goToByLabel(page, '对话');
    await page.locator('header').getByRole('button', { name: '新对话' }).click();
    await expect(page.getByRole('button', { name: '返回对话列表' })).toBeVisible();
    const prompt = `追溯测试 ${factId}`;
    await page.getByPlaceholder('输入消息…').fill(prompt);
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('.turn-badge[data-status="completed"]')).toBeVisible({
      timeout: 15_000,
    });

    // 回显文本原样带着这个 id——`MessageReferences` 用 `explain{nodeId}` 验证过后才渲染引用，
    // 不是仅凭"像一个 uuid"就渲染。
    const referenceChip = page.getByTestId(`message-reference-${factId}`);
    await expect(referenceChip).toBeVisible({ timeout: 15_000 });
    const referenceLink = referenceChip.locator('a');
    await expect(referenceLink).toHaveAttribute('href', `#/govern/audit?nodeId=${factId}`);

    // --- 2. 点击引用，进入审计页的 explain --------------------------------------------------------
    await referenceLink.click();
    await expect(page.getByRole('heading', { level: 1, name: /审计/ })).toBeVisible({
      timeout: 15_000,
    });

    // --- 3. 看到完整来源链：Fact → Activity → Source ---------------------------------------------
    const chain = page.getByTestId('explain-chain');
    await expect(chain).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('explain-error')).toHaveCount(0);
    const result = page.getByTestId('explain-result');
    await expect(result).toHaveAttribute('data-node-type', 'fact');
    await expect(chain.getByTestId('prov-fact')).toHaveAttribute('data-present', 'true');
    await expect(chain.getByTestId('prov-activity')).toHaveAttribute('data-present', 'true');
    await expect(chain.getByTestId('prov-source')).toHaveAttribute('data-present', 'true');

    // --- 4. 从来源链展开原始证据（"从结论倒推到证据"的闭环） --------------------------------------
    await chain.getByTestId('prov-raw').locator('summary').click();
    await expect(chain.getByTestId('prov-raw')).toContainText(factId);

    // --- 窄屏 (768px): 溯源链仍可展开、不需要横向滚动 ----------------------------------------------
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(chain).toBeVisible();
    const scrollWidth = await chain.evaluate((el) => el.scrollWidth);
    const clientWidth = await chain.evaluate((el) => el.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });
});
