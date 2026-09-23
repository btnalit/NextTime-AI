import type {
  LlmProviderInputWire,
  LlmProviderListWire,
  LlmProviderTestResultWire,
  LlmProviderWire,
} from '@nexttime/shared';
import { useCallback, useMemo, useState } from 'react';
import { useResource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { LlmAdminClient, type LlmAdminError, llmAdminErrorMessage } from '../../lib/llm-admin.js';
import { Button } from '../ui/Button.js';
import { ConfirmTier } from '../ui/ConfirmTier.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Notice } from '../ui/Notice.js';
import { PageHeader } from '../ui/PageHeader.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { useToast } from '../ui/Toast.js';
import { CredentialState } from './providers/CredentialState.js';
import { DefaultModelControl } from './providers/DefaultModelControl.js';
import { ProviderForm } from './providers/ProviderForm.js';
import { ProviderSecretForm } from './providers/ProviderSecretForm.js';
import { ProviderTestResult } from './providers/ProviderTestResult.js';

export interface PlatformModelsPageProps {
  readonly http: CapabilityCaller;
  /** Test seam: the `fetch` the llm-admin client uses for `/api/llm-admin/*`. */
  readonly fetchImpl?: typeof fetch;
}

type DrawerState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly provider: LlmProviderWire }
  | { readonly kind: 'detail'; readonly provider: LlmProviderWire };

type ConfirmState =
  | { readonly kind: 'none' }
  | { readonly kind: 'disable'; readonly provider: LlmProviderWire }
  | { readonly kind: 'enable'; readonly provider: LlmProviderWire }
  | { readonly kind: 'delete'; readonly provider: LlmProviderWire };

const API_LABEL: Readonly<Record<LlmProviderWire['api'], string>> = {
  'openai-completions': 'OpenAI 兼容 · completions',
  'openai-responses': 'OpenAI 兼容 · responses',
  'anthropic-messages': 'Anthropic · messages',
};

/**
 * components/platform/PlatformModelsPage: 模型与供应商 Models & providers (`#/platform/models`,
 * S6-B — docs/console-completion-plan.md §5.4; docs/platform-admin-design.md §6.2). The platform
 * side of the model catalog: every provider llm-proxy knows (the operator's `llm-providers.yaml`
 * plus the console-managed store), 新增 / 编辑 in a drawer, 测试调用 (one completion + one tool-call
 * round trip, the plan's acceptance), 停用 / 启用 behind a `high` confirm and 删除 (store rows only)
 * behind an `irreversible` one, and the honest credential state per row.
 *
 * Data path: `lib/llm-admin.ts` — `issue_llm_admin_token` for a 5-minute JWT, then llm-proxy's
 * admin endpoints directly through caddy `/api/llm-admin/*`. Nothing here goes through a kernel
 * capability except the token mint. The page shows the honest credential state
 * (`credentialPresent`/`credentialSource`) and lets an administrator set/replace/clear a
 * provider's key directly (S7-A, docs/STATUS.md 维护者决定 2026-09-22 ①: no approval flow —
 * `providers/ProviderSecretForm.tsx`, in the detail drawer) as an alternative to the operator step
 * of setting `apiKeyEnv` in `secrets/llm-proxy.env`; a console key always takes priority. The typed
 * key itself never round-trips back through this page — every response uses `LlmProviderWire`,
 * which has no field for one.
 *
 * The workspace side stays "只选不配": after a change here the proxy rewrites `models.json`, so
 * `list_platform_models` (工作区 page's model picker) and every new agent container see the new
 * provider's models; the workspace's own 模型与配额 page (`ModelsPage`) keeps choosing from that
 * projection. Uses `useResource` rather than `useCapability` because the list is not a
 * capability call (no `/api/cap` cache key to invalidate).
 */
export function PlatformModelsPage({ http, fetchImpl }: PlatformModelsPageProps) {
  const toast = useToast();
  const client = useMemo(() => new LlmAdminClient(http, { fetchImpl }), [http, fetchImpl]);
  const list = useResource<LlmProviderListWire>(
    useCallback(() => client.listProviders(), [client]),
  );
  const [drawer, setDrawer] = useState<DrawerState>({ kind: 'closed' });
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: 'none' });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, LlmProviderTestResultWire>>({});
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);

  const providers = list.state.status === 'ready' ? list.state.data.items : [];
  const meta = list.state.status === 'ready' ? list.state.data : null;

  function replaceRow(updated: LlmProviderWire): void {
    list.mutate((data) => ({
      ...data,
      items: data.items.some((row) => row.id === updated.id)
        ? data.items.map((row) => (row.id === updated.id ? updated : row))
        : [...data.items, updated],
    }));
  }

  async function save(
    input: LlmProviderInputWire,
    existing: LlmProviderWire | undefined,
  ): Promise<void> {
    const saved = existing
      ? await client.updateProvider(input)
      : await client.createProvider(input);
    replaceRow(saved);
    setDrawer({ kind: 'closed' });
    toast.push({
      tone: 'ok',
      title: existing ? `已保存 ${saved.displayName}` : `已新增 ${saved.displayName}`,
      description:
        'models.json 已重写；工作区"模型与配额"可勾选它的模型。 models.json rewritten — workspaces can now allow its models.',
    });
    void list.reload();
  }

  async function setEnabled(provider: LlmProviderWire, enabled: boolean): Promise<void> {
    const updated = await client.updateProvider({
      id: provider.id,
      displayName: provider.displayName,
      api: provider.api,
      upstreamBaseUrl: provider.upstreamBaseUrl,
      authHeader: provider.authHeader,
      authScheme: provider.authScheme,
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
      models: provider.models,
      enabled,
    });
    replaceRow(updated);
    void list.reload();
  }

  async function remove(provider: LlmProviderWire): Promise<void> {
    const result = await client.deleteProvider(provider.id);
    list.mutate((data) => ({ ...data, items: data.items.filter((row) => row.id !== provider.id) }));
    if (
      drawer.kind !== 'closed' &&
      drawer.kind !== 'create' &&
      drawer.provider.id === provider.id
    ) {
      setDrawer({ kind: 'closed' });
    }
    toast.push({
      tone: 'ok',
      title: result.restoredFileEntry
        ? `已删除覆盖记录，恢复为 yaml 里的 ${provider.id}`
        : `已删除 ${provider.displayName}`,
    });
    // P2 hotfix (post-v0.16.0 review): a deleted provider's console key is now also cleared
    // (llm-proxy's DELETE /providers/:id) — surface it separately so it is not lost inside the
    // delete toast's own title.
    if (result.secretCleared) {
      toast.push({ tone: 'ok', title: '已一并清除控制台密钥 · Console key cleared as well' });
    }
    void list.reload();
  }

  async function runTest(provider: LlmProviderWire): Promise<void> {
    setTesting(provider.id);
    setRowError(null);
    try {
      const result = await client.testProvider(provider.id);
      setTestResults((prev) => ({ ...prev, [provider.id]: result }));
      replaceRow({ ...provider, lastTest: result });
      toast.push({
        tone: result.completion === 'ok' && result.toolCall === 'ok' ? 'ok' : 'warn',
        title: `${provider.displayName}：补全 ${result.completion} · 工具调用 ${result.toolCall}`,
        description: result.error ?? `${result.latencyMs} ms`,
      });
    } catch (error) {
      setRowError({ id: provider.id, error });
    } finally {
      setTesting(null);
    }
  }

  const drawerProvider =
    drawer.kind === 'edit' || drawer.kind === 'detail'
      ? (providers.find((row) => row.id === drawer.provider.id) ?? drawer.provider)
      : undefined;

  return (
    <div className="page" data-testid="platform-models-page">
      <PageHeader
        breadcrumb={[{ label: '平台 Platform' }, { label: '模型与供应商' }]}
        title="模型与供应商 Models & providers"
        description="llm-proxy 里的供应商：名称、API 种类、Base URL、鉴权头、密钥环境变量、模型清单、启用；测试调用含一次工具调用往返。工作区侧只从这里的投影里选。 The providers llm-proxy routes to; workspaces only pick from this projection."
        primaryAction={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setDrawer({ kind: 'create' })}
            disabled={meta?.storeWritable === false}
            data-testid="provider-create"
          >
            新增供应商 Add provider
          </Button>
        }
        actions={
          <Button
            variant="ghost"
            icon="refresh"
            onClick={() => void list.reload()}
            loading={list.state.status === 'ready' && list.state.refreshing}
            data-testid="providers-refresh"
          >
            刷新 Refresh
          </Button>
        }
      />

      {meta && meta.storeWritable === false ? (
        <Notice tone="warn" testId="providers-store-unwritable">
          模型代理的状态目录不可写，新增 / 编辑 / 删除都会失败——请操作员在主机上运行
          scripts/host-llm-proxy-init.sh 后 docker compose up -d --force-recreate llm-proxy。 The
          proxy’s state directory is not writable; run scripts/host-llm-proxy-init.sh on the host,
          then recreate llm-proxy.
        </Notice>
      ) : null}
      {meta?.modelsJsonError ? (
        <Notice tone="warn" testId="providers-models-json-error">
          最近一次重写 models.json 失败（{meta.modelsJsonError}
          ）：代理已按新目录路由，但内核投影与新 容器仍看旧文件——操作员运行
          scripts/host-llm-proxy-init.sh（config/ 归 10001）后重建 llm-proxy，或手动 make
          gen-models。 The last models.json rewrite failed — the proxy routes the new catalog, but
          the kernel projection and new containers still see the old file; run
          scripts/host-llm-proxy-init.sh and recreate llm-proxy, or make gen-models.
        </Notice>
      ) : null}

      <DefaultModelControl http={http} />

      <section className="section" aria-labelledby="providers-title">
        <div className="section-header">
          <h2 id="providers-title">供应商 Providers</h2>
          {meta?.modelsJsonWrittenAt ? (
            <span className="text-small text-3" data-testid="providers-models-json-written">
              models.json 已于{' '}
              <time title={formatDateTime(meta.modelsJsonWrittenAt)}>
                {formatRelative(meta.modelsJsonWrittenAt)}
              </time>{' '}
              重写 rewritten
            </span>
          ) : null}
        </div>
        {list.state.status === 'loading' ? (
          <SkeletonRows count={3} label="Loading providers" testId="providers-loading" />
        ) : list.state.status === 'error' ? (
          llmAdminErrorMessage(list.state.error) !== null ? (
            <div className="stack-s">
              <div
                className="field-error"
                role="alert"
                data-testid="providers-error"
                data-error-code={(list.state.error as LlmAdminError).code}
              >
                {llmAdminErrorMessage(list.state.error)}
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="s"
                  icon="refresh"
                  onClick={() => void list.reload()}
                >
                  重试 Retry
                </Button>
              </div>
            </div>
          ) : (
            <ErrorBanner
              error={list.state.error}
              title="Could not load the providers"
              onRetry={() => void list.reload()}
              testId="providers-error"
            />
          )
        ) : providers.length === 0 ? (
          <EmptyState
            icon="cpu"
            title="还没有供应商 No providers yet"
            body="点“新增供应商”，或由操作员在主机 llm-providers.yaml 里配置。 Add one here, or have the operator configure llm-providers.yaml on the host."
            testId="providers-empty"
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="providers-table">
              <thead>
                <tr>
                  <th>供应商 Provider</th>
                  <th>API</th>
                  <th>Base URL</th>
                  <th>模型 Models</th>
                  <th>状态 Status</th>
                  <th>凭证 Credential</th>
                  <th>最近测试 Last test</th>
                  <th>来源 Source</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => {
                  const lastTest = testResults[provider.id] ?? provider.lastTest;
                  return (
                    <tr
                      key={provider.id}
                      data-testid={`provider-row-${provider.id}`}
                      data-provider-id={provider.id}
                    >
                      <td>
                        <span data-testid="provider-name">{provider.displayName}</span>
                        {provider.displayName !== provider.id ? (
                          <div className="mono text-3 text-small">{provider.id}</div>
                        ) : null}
                      </td>
                      <td className="text-small">{API_LABEL[provider.api]}</td>
                      <td className="mono text-small">{provider.upstreamBaseUrl}</td>
                      <td>
                        <span className="tag" title={provider.models.map((m) => m.id).join(', ')}>
                          {provider.models.length}
                        </span>
                      </td>
                      <td>
                        <StatusChip
                          machine="workspaceStatus"
                          status={provider.enabled ? 'active' : 'disabled'}
                          size="s"
                          testId="provider-enabled-chip"
                        />
                      </td>
                      <td>
                        <CredentialState provider={provider} />
                      </td>
                      <td>
                        {lastTest ? (
                          <StatusChip
                            machine="serviceHealth"
                            status={
                              lastTest.completion === 'ok' && lastTest.toolCall === 'ok'
                                ? 'ok'
                                : lastTest.completion === 'ok'
                                  ? 'degraded'
                                  : 'down'
                            }
                            size="s"
                            testId="provider-last-test-chip"
                          />
                        ) : (
                          <span className="text-3 text-small">未测试 untested</span>
                        )}
                      </td>
                      <td>
                        <span className="tag" data-testid="provider-source">
                          {provider.source === 'file'
                            ? 'yaml'
                            : provider.overridesFile
                              ? '覆盖 yaml override'
                              : '控制台 console'}
                        </span>
                      </td>
                      <td>
                        <div className="row">
                          <Button
                            variant="ghost"
                            size="s"
                            onClick={() => setDrawer({ kind: 'detail', provider })}
                            data-testid="provider-open"
                          >
                            详情 Details
                          </Button>
                          <Button
                            variant="secondary"
                            size="s"
                            onClick={() => void runTest(provider)}
                            loading={testing === provider.id}
                            disabled={testing !== null || !provider.enabled}
                            title={
                              provider.credentialPresent
                                ? undefined
                                : provider.apiKeyEnv
                                  ? `${provider.apiKeyEnv} 未配置 — 测试会被拒绝 not set, the test will be refused`
                                  : '没有配置任何凭证 — 测试会被拒绝 no credential configured, the test will be refused'
                            }
                            data-testid="provider-test"
                          >
                            测试调用 Test
                          </Button>
                          <Button
                            variant="ghost"
                            size="s"
                            onClick={() => setDrawer({ kind: 'edit', provider })}
                            disabled={meta?.storeWritable === false}
                            data-testid="provider-edit"
                          >
                            编辑 Edit
                          </Button>
                          {provider.enabled ? (
                            <Button
                              variant="ghost"
                              size="s"
                              onClick={() => setConfirm({ kind: 'disable', provider })}
                              disabled={meta?.storeWritable === false}
                              data-testid="provider-disable"
                            >
                              停用 Disable
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="s"
                              onClick={() => setConfirm({ kind: 'enable', provider })}
                              disabled={meta?.storeWritable === false}
                              data-testid="provider-enable"
                            >
                              启用 Enable
                            </Button>
                          )}
                          {provider.source === 'store' ? (
                            <Button
                              variant="ghost"
                              size="s"
                              onClick={() => setConfirm({ kind: 'delete', provider })}
                              disabled={meta?.storeWritable === false}
                              data-testid="provider-delete"
                            >
                              {provider.overridesFile ? '删除覆盖 Drop override' : '删除 Delete'}
                            </Button>
                          ) : null}
                        </div>
                        {rowError && rowError.id === provider.id ? (
                          <div
                            className="field-error"
                            role="alert"
                            data-testid="provider-row-error"
                          >
                            {llmAdminErrorMessage(rowError.error) ??
                              (rowError.error instanceof Error
                                ? rowError.error.message
                                : String(rowError.error))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Drawer
        open={drawer.kind === 'create'}
        title="新增供应商 Add provider"
        subtitle="保存后代理立即路由它，并重写 models.json。 Routed by the proxy and written to models.json on save."
        onClose={() => setDrawer({ kind: 'closed' })}
        wide
        testId="provider-create-drawer"
      >
        {drawer.kind === 'create' ? (
          <ProviderForm
            onSubmit={(input) => save(input, undefined)}
            onCancel={() => setDrawer({ kind: 'closed' })}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={drawer.kind === 'edit' && drawerProvider !== undefined}
        title={`编辑 ${drawerProvider?.displayName ?? ''}`}
        subtitle={drawerProvider?.id}
        onClose={() => setDrawer({ kind: 'closed' })}
        wide
        testId="provider-edit-drawer"
      >
        {drawer.kind === 'edit' && drawerProvider ? (
          <ProviderForm
            initial={drawerProvider}
            onSubmit={(input) => save(input, drawerProvider)}
            onCancel={() => setDrawer({ kind: 'closed' })}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={drawer.kind === 'detail' && drawerProvider !== undefined}
        title={drawerProvider?.displayName ?? ''}
        subtitle={drawerProvider?.id}
        onClose={() => setDrawer({ kind: 'closed' })}
        testId="provider-detail-drawer"
      >
        {drawer.kind === 'detail' && drawerProvider ? (
          <div className="stack">
            <dl className="definition-list">
              <dt>API</dt>
              <dd>{API_LABEL[drawerProvider.api]}</dd>
              <dt>Base URL</dt>
              <dd className="mono">{drawerProvider.upstreamBaseUrl}</dd>
              <dt>鉴权头 Auth header</dt>
              <dd className="mono">
                {drawerProvider.authHeader}
                {drawerProvider.authScheme ? `: ${drawerProvider.authScheme} <key>` : ': <key>'}
              </dd>
              <dt>密钥环境变量 Key env var</dt>
              <dd className="mono">
                {drawerProvider.apiKeyEnv ?? <span className="text-3">（未配置 none）</span>}
              </dd>
              <dt>来源 Source</dt>
              <dd>
                {drawerProvider.source === 'file'
                  ? 'llm-providers.yaml（主机，只读 host, read-only）'
                  : drawerProvider.overridesFile
                    ? '控制台覆盖 yaml 同名条目 console override of the yaml entry'
                    : '控制台 console store'}
              </dd>
              {drawerProvider.updatedAt ? (
                <>
                  <dt>更新 Updated</dt>
                  <dd>
                    <time title={formatDateTime(drawerProvider.updatedAt)}>
                      {formatRelative(drawerProvider.updatedAt)}
                    </time>
                  </dd>
                </>
              ) : null}
            </dl>
            <CredentialState provider={drawerProvider} withInstruction />
            <ProviderSecretForm provider={drawerProvider} client={client} onUpdated={replaceRow} />
            <div className="stack-s">
              <span className="section-title">模型 Models</span>
              <ul data-testid="provider-detail-models">
                {drawerProvider.models.map((model) => (
                  <li key={model.id}>
                    <span className="mono">
                      {drawerProvider.id}/{model.id}
                    </span>
                    {model.displayName ? (
                      <span className="text-2"> — {model.displayName}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
            {(testResults[drawerProvider.id] ?? drawerProvider.lastTest) ? (
              <div className="stack-s">
                <span className="section-title">最近测试 Last test</span>
                <ProviderTestResult
                  result={
                    (testResults[drawerProvider.id] ??
                      drawerProvider.lastTest) as LlmProviderTestResultWire
                  }
                  testId="provider-detail-test"
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <ConfirmTier
        tier="high"
        open={confirm.kind === 'disable'}
        title="停用供应商 Disable provider"
        description="代理立即对它返回 404，它会从 models.json 消失；已在工作区里被勾选的模型对话会失败，直到重新启用。 The proxy 404s it at once and it leaves models.json; chats on its models fail until re-enabled."
        target={confirm.kind === 'disable' ? confirm.provider.displayName : undefined}
        impact={
          confirm.kind === 'disable'
            ? [
                `${confirm.provider.models.length} 个模型不再可用 models become unavailable`,
                confirm.provider.source === 'file'
                  ? '在代理存储里建一条覆盖记录，yaml 不改 creates an override; the yaml is untouched'
                  : '保留记录，可随时启用 the record is kept and can be re-enabled',
              ]
            : undefined
        }
        confirmLabel="停用 Disable"
        danger
        onConfirm={() =>
          confirm.kind === 'disable' ? setEnabled(confirm.provider, false) : undefined
        }
        onClose={() => setConfirm({ kind: 'none' })}
        testId="provider-disable-confirm"
      />
      <ConfirmTier
        tier="medium"
        open={confirm.kind === 'enable'}
        title="启用供应商 Enable provider"
        target={confirm.kind === 'enable' ? confirm.provider.displayName : undefined}
        confirmLabel="启用 Enable"
        onConfirm={() =>
          confirm.kind === 'enable' ? setEnabled(confirm.provider, true) : undefined
        }
        onClose={() => setConfirm({ kind: 'none' })}
        testId="provider-enable-confirm"
      />
      <ConfirmTier
        tier="irreversible"
        open={confirm.kind === 'delete'}
        title={
          confirm.kind === 'delete' && confirm.provider.overridesFile
            ? '删除覆盖记录 Drop override'
            : '删除供应商 Delete provider'
        }
        description={
          confirm.kind === 'delete' && confirm.provider.overridesFile
            ? '恢复为主机 llm-providers.yaml 里的同名条目。 The host yaml entry becomes visible again.'
            : '从代理存储里删除这条记录并重写 models.json；工作区里对它模型的勾选会失效。 Removes the record from the proxy store and rewrites models.json; workspace selections of its models stop working.'
        }
        target={confirm.kind === 'delete' ? confirm.provider.id : undefined}
        impact={
          confirm.kind === 'delete'
            ? [
                `${confirm.provider.models.length} 个模型 models`,
                '写入平台审计 recorded in the platform audit',
              ]
            : undefined
        }
        confirmLabel="删除 Delete"
        onConfirm={() => (confirm.kind === 'delete' ? remove(confirm.provider) : undefined)}
        onClose={() => setConfirm({ kind: 'none' })}
        testId="provider-delete-confirm"
      />
    </div>
  );
}
