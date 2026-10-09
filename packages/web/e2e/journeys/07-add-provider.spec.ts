import { type Page, type Route, expect, test } from '@playwright/test';
import { ADMIN_INITIAL_PASSWORD, ADMIN_LOGIN } from '../lib/auth.js';
import { asAdmin, goToByLabel } from './helpers.js';

/**
 * Journey ⑦: 接入一个 LLM 供应商并选好能用的模型
 *
 * 步骤:
 *   1. （平台管理员）打开 模型与供应商，点"新增供应商"。
 *   2. 点 DeepSeek 快速选择：API 种类、Base URL、鉴权头、id 一次填好，并显示代理实际请求的完整 URL。
 *   3. 只填 API 密钥。失焦后从供应商拉回模型列表，自动勾选并逐个探测（补全 + 工具调用）。
 *   4. 保存：先建供应商行，再写密钥，再跑一次"测试调用"，抽屉里给出一句话结论。
 * 状态覆盖:
 *   - 空: 从零新增本身。
 *   - 错: 中转站没有 `/v1/models`（404）时，给出原因并列出预设的常用模型，勾选即探测；只能补全、
 *     不能工具调用的模型标成"仅对话"，不拦保存。
 *   - 无权限: 模型与供应商只在平台侧栏出现，平台管理员以外看不到——不在本旅程范围。
 *   - 窄屏: 不单独重跑（`00-gates/` 的截图覆盖布局）。
 * 成功判据:
 *   - 管理员只输入一个密钥，就能得到一个配好、测过、可用的供应商；表单从不要求手抄 id、URL 或模型名。
 *
 * CI 的 fake 栈不常驻 llm-proxy（`.github/workflows/e2e.yml` 只用它生成一次 models.json），所以
 * 这里用 `page.route` 在浏览器里替身 `/api/llm-admin/**`（内核签发的管理 token 指向的同源路径）。
 * 被验证的是控制台这一侧的整条操作链和它发出的请求；llm-proxy 自己的行为由它的单元测试覆盖。
 */

const KEY = 'e2e-fake-key-not-real';

interface ProxyCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface StubOptions {
  /** `/model-discovery` answers 404 (a relay with no model list) instead of a list. */
  readonly noModelList?: boolean;
}

function providerRow(input: { id: string; displayName: string; models: Array<{ id: string }> }) {
  return {
    id: input.id,
    displayName: input.displayName,
    api: 'openai-completions',
    upstreamBaseUrl: 'https://api.deepseek.com',
    authHeader: 'authorization',
    authScheme: 'Bearer',
    apiKeyEnv: null,
    credentialPresent: false,
    credentialSource: 'none',
    enabled: true,
    source: 'store',
    overridesFile: false,
    models: input.models.map((m) => ({ id: m.id, displayName: null, cost: null })),
    lastTest: null,
    createdAt: null,
    updatedAt: null,
  };
}

/** A stateful stand-in for llm-proxy's admin API, recording every call the console makes. */
async function stubProxy(page: Page, options: StubOptions = {}): Promise<ProxyCall[]> {
  const calls: ProxyCall[] = [];
  let items: Array<ReturnType<typeof providerRow> & Record<string, unknown>> = [];
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/llm-admin/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace('/api/llm-admin', '');
    const raw = request.postData();
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    calls.push({ method, path, body });

    if (method === 'GET' && path === '/providers') {
      return json(route, 200, {
        items,
        modelsJsonWrittenAt: null,
        modelsJsonError: null,
        storeWritable: true,
      });
    }
    if (method === 'POST' && path === '/model-discovery') {
      if (options.noModelList) {
        return json(route, 502, {
          error: {
            code: 'upstream_error',
            message: 'upstream answered HTTP 404: Not Found',
            details: { status: 404 },
          },
        });
      }
      return json(route, 200, {
        models: [
          { id: 'deepseek-chat', displayName: null },
          { id: 'deepseek-reasoner', displayName: null },
        ],
        credentialSource: 'inline',
        truncated: false,
        latencyMs: 90,
      });
    }
    if (method === 'POST' && path === '/model-probe') {
      const models = (body as { models: string[] }).models;
      return json(route, 200, {
        credentialSource: 'inline',
        results: models.map((model) => {
          const chatOnly = model === 'deepseek-reasoner';
          return {
            model,
            completion: 'ok',
            toolCall: chatOnly ? 'error' : 'ok',
            latencyMs: 700,
            error: chatOnly ? 'tool_call: HTTP 400: tools are not supported by this model' : null,
          };
        }),
      });
    }
    if (method === 'POST' && path === '/providers') {
      const row = providerRow(body as Parameters<typeof providerRow>[0]);
      items = [...items, row];
      return json(route, 201, row);
    }
    const secret = /^\/providers\/([^/]+)\/secret$/.exec(path);
    if (method === 'PUT' && secret) {
      items = items.map((row) =>
        row.id === secret[1]
          ? { ...row, credentialPresent: true, credentialSource: 'console' }
          : row,
      );
      return json(
        route,
        200,
        items.find((row) => row.id === secret[1]),
      );
    }
    const tested = /^\/providers\/([^/]+)\/test$/.exec(path);
    if (method === 'POST' && tested) {
      return json(route, 200, {
        providerId: tested[1],
        model: 'deepseek-chat',
        completion: 'ok',
        toolCall: 'ok',
        latencyMs: 800,
        error: null,
        testedAt: new Date().toISOString(),
      });
    }
    return json(route, 404, { error: { code: 'not_found', message: `${method} ${path}` } });
  });
  return calls;
}

async function openNewProviderForm(page: Page) {
  await asAdmin(page);
  await goToByLabel(page, '模型与供应商');
  await page.getByTestId('provider-create').click();
  const form = page.getByTestId('provider-form');
  await expect(form).toBeVisible();
  return form;
}

test.describe('Journey ⑦: 接入一个 LLM 供应商并选好能用的模型', () => {
  test.skip(
    !ADMIN_LOGIN || !ADMIN_INITIAL_PASSWORD,
    'set WEB_E2E_ADMIN_LOGIN and WEB_E2E_ADMIN_INITIAL_PASSWORD (see README.md)',
  );

  test('preset + key only: models are listed, ticked and checked; save writes the key and tests', async ({
    page,
  }) => {
    test.slow();
    const calls = await stubProxy(page);
    const form = await openNewProviderForm(page);

    await form.getByTestId('provider-preset-deepseek').click();
    await expect(form.getByTestId('provider-id')).toHaveValue('deepseek');
    await expect(form.getByTestId('provider-base-url')).toHaveValue('https://api.deepseek.com');
    await expect(form.getByTestId('provider-base-url-preview')).toContainText(
      'https://api.deepseek.com/v1/chat/completions',
    );

    await form.getByTestId('provider-key').fill(KEY);
    await form.getByTestId('provider-key').blur();
    await expect(form.getByTestId('provider-model-picker')).toBeVisible();
    // Two listed models are few enough to tick both and check each one straight away.
    await expect(form.getByTestId('provider-model-probe')).toHaveCount(2);
    await expect(form.locator('[data-testid="provider-model-probe"][data-state="ok"]')).toHaveCount(
      1,
    );
    await expect(
      form.locator('[data-testid="provider-model-probe"][data-state="chat-only"]'),
    ).toHaveCount(1);

    await expect(form.getByTestId('provider-submit')).toBeEnabled();
    await form.getByTestId('provider-submit').click();
    const verdict = page.getByTestId('provider-test-verdict');
    await expect(verdict).toBeVisible({ timeout: 15_000 });
    await expect(verdict).toHaveAttribute('data-verdict', 'ok');

    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual([
      'POST /model-discovery',
      'POST /model-probe',
      'POST /providers',
      'PUT /providers/deepseek/secret',
      'POST /providers/deepseek/test',
    ]);
    const created = calls.find((c) => c.method === 'POST' && c.path === '/providers');
    expect(created?.body).toMatchObject({
      id: 'deepseek',
      upstreamBaseUrl: 'https://api.deepseek.com',
      models: [
        { id: 'deepseek-chat', displayName: null, cost: null },
        { id: 'deepseek-reasoner', displayName: null, cost: null },
      ],
    });
    // The key goes only in the secret call, never on the provider row.
    expect(JSON.stringify(created?.body)).not.toContain(KEY);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ key: KEY });
  });

  test('a relay with no model list: the reason is shown and preset suggestions are offered and checked', async ({
    page,
  }) => {
    test.slow();
    const calls = await stubProxy(page, { noModelList: true });
    const form = await openNewProviderForm(page);

    await form.getByTestId('provider-preset-deepseek').click();
    await form.getByTestId('provider-key').fill(KEY);
    await form.getByTestId('provider-key').blur();
    await expect(form.getByTestId('provider-discover-error')).toBeVisible();
    const suggestions = form.getByTestId('provider-model-suggestions');
    await expect(suggestions).toBeVisible();

    await suggestions.getByRole('checkbox', { name: 'deepseek-chat' }).check();
    await expect(form.locator('[data-testid="provider-model-probe"][data-state="ok"]')).toHaveCount(
      1,
    );
    expect(calls.find((c) => c.path === '/model-probe')?.body).toMatchObject({
      id: 'deepseek',
      key: KEY,
      models: ['deepseek-chat'],
    });
    await expect(form.getByTestId('provider-submit')).toBeEnabled();
  });
});
