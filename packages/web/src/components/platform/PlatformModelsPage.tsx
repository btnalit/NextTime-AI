import type {
  LlmProviderListWire,
  LlmProviderTestResultWire,
  LlmProviderWire,
  PlatformWorkspaceWire,
} from '@nexttime/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { useResource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import type { ModelRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { LlmAdminClient, llmAdminErrorMessage } from '../../lib/llm-admin.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { explainUpstreamError } from '../../lib/provider-form.js';
import { providerStatus } from '../../lib/provider-status.js';
import { hrefs, readNewProviderPreset, readProviderPreset } from '../../lib/router.js';
import { Confirm } from '../kit/confirm.js';
import { DataTable, type DataTableColumn } from '../kit/data-table.js';
import { DrawerSection, DrawerSections } from '../kit/drawer-section.js';
import { InlineError } from '../kit/inline-error.js';
import { ModelHealthTag } from '../kit/model-health.js';
import { PageHeader } from '../kit/page-header.js';
import { DashboardCard } from '../kit/section.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Select } from '../ui/Field.js';
import { Icon } from '../ui/Icon.js';
import { Notice } from '../ui/Notice.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { useToast } from '../ui/Toast.js';
import { type DrawerState, useProviderActions } from './models/useProviderActions.js';
import { CredentialState } from './providers/CredentialState.js';
import { DefaultModelControl } from './providers/DefaultModelControl.js';
import { ProviderForm } from './providers/ProviderForm.js';
import { ProviderSecretForm } from './providers/ProviderSecretForm.js';
import { ProviderTestResult } from './providers/ProviderTestResult.js';

/** The statuses the provider's last test decided (`lib/provider-status`). */
const TEST_DECIDED_STATUSES: ReadonlySet<string> = new Set([
  'key_rejected',
  'test_failed',
  'tools_failed',
]);
export interface PlatformModelsPageProps {
  readonly http: CapabilityCaller;
  /** Test seam: the `fetch` the llm-admin client uses for `/api/llm-admin/*`. */
  readonly fetchImpl?: typeof fetch;
}

type ConfirmState =
  | { readonly kind: 'none' }
  | { readonly kind: 'disable'; readonly provider: LlmProviderWire }
  | { readonly kind: 'enable'; readonly provider: LlmProviderWire }
  | { readonly kind: 'delete'; readonly provider: LlmProviderWire };

const API_LABEL: Readonly<
  Record<LlmProviderWire['api'], { readonly zh: string; readonly en: string }>
> = {
  'openai-completions': {
    zh: 'OpenAI 兼容 · completions 接口',
    en: 'OpenAI-compatible · completions',
  },
  'openai-responses': { zh: 'OpenAI 兼容 · responses 接口', en: 'OpenAI-compatible · responses' },
  'anthropic-messages': { zh: 'Anthropic · messages', en: 'Anthropic · messages' },
};

/**
 * components/platform/PlatformModelsPage: 模型与供应商 Models & providers (`#/platform/models`,
 * S6-B — docs/console-completion-plan.md §5.4; docs/platform-admin-design.md §6.2). The platform
 * side of the model catalog: every provider llm-proxy knows (the operator's `llm-providers.yaml`
 * plus the console-managed store), 新增 / 编辑 in a drawer, 测试调用 (one completion + one tool-call
 * round trip, the plan's acceptance), 停用 / 启用 behind a `kit/confirm` `medium` popover (S8 W1-A7,
 * anchored to the row's own button) and 删除 (store rows only) behind an `irreversible` one, and
 * the honest credential state per row.
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
  const t = useT();
  const toast = useToast();
  const client = useMemo(() => new LlmAdminClient(http, { fetchImpl }), [http, fetchImpl]);
  const list = useResource<LlmProviderListWire>(
    useCallback(() => client.listProviders(), [client]),
  );
  const [drawer, setDrawer] = useState<DrawerState>(() =>
    readNewProviderPreset(window.location.hash) ? { kind: 'create' } : { kind: 'closed' },
  );
  // Audit P0-3: the overview's first-run step links straight to 新增供应商. The query is dropped
  // once read, so closing the drawer and reloading does not open it again; a link followed while
  // this page is already mounted opens it too.
  // A model picker's next step (kit/model-health) links here with `?provider=<id>`: that
  // provider's drawer opens once the list has loaded, on its 连通性测试 and 密钥 sections.
  const [providerPreset, setProviderPreset] = useState<string | null>(() =>
    readProviderPreset(window.location.hash),
  );
  useEffect(() => {
    function consume(): void {
      const presetProvider = readProviderPreset(window.location.hash);
      if (presetProvider) {
        setProviderPreset(presetProvider);
        window.history.replaceState(null, '', hrefs.platformModels());
        return;
      }
      if (!readNewProviderPreset(window.location.hash)) return;
      setDrawer({ kind: 'create' });
      window.history.replaceState(null, '', hrefs.platformModels());
    }
    consume();
    window.addEventListener('hashchange', consume);
    return () => window.removeEventListener('hashchange', consume);
  }, []);
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: 'none' });
  const { testing, testResults, rowError, replaceRow, save, setEnabled, remove, runTest } =
    useProviderActions(client, drawer, list, setDrawer, toast, t);

  const providers = list.state.status === 'ready' ? list.state.data.items : [];
  const meta = list.state.status === 'ready' ? list.state.data : null;
  useEffect(() => {
    if (providerPreset === null || list.state.status !== 'ready') return;
    const target = list.state.data.items.find((row) => row.id === providerPreset);
    if (target) setDrawer({ kind: 'detail', provider: target });
    setProviderPreset(null);
  }, [providerPreset, list.state]);

  const drawerProvider =
    drawer.kind === 'edit' || drawer.kind === 'detail'
      ? (providers.find((row) => row.id === drawer.provider.id) ?? drawer.provider)
      : undefined;

  // S8 W1-A4 (audit S3: "1440 下供应商表也溢出" — too many columns to ever fit one screen, even
  // wide). `layout="sticky"`: 供应商/状态/操作 pin left at every width; the rest scrolls
  // horizontally underneath. Defined inline (not a top-level `xColumns(...)` factory like the
  // Users/Workspaces pages use) — this table's cells close over enough page state
  // (testResults/rowError/testing/meta/setDrawer/setConfirm/runTest) that a factory's parameter
  // list would be longer than the columns themselves.
  const providerColumns: readonly DataTableColumn<LlmProviderWire>[] = [
    {
      id: 'provider',
      header: t('供应商', 'Provider'),
      priority: 'primary',
      width: 200,
      cell: (provider) => (
        <>
          <span data-testid="provider-name">{provider.displayName}</span>
          {provider.displayName !== provider.id ? (
            <div className="mono text-3 text-small">{provider.id}</div>
          ) : null}
        </>
      ),
    },
    {
      id: 'status',
      header: t('状态', 'Status'),
      priority: 'high',
      width: 140,
      cell: (provider) => {
        const lastTest = testResults[provider.id] ?? provider.lastTest;
        const status = providerStatus(provider, lastTest);
        return (
          <span
            className={`chip chip-s chip-${status.tone}`}
            data-testid="provider-enabled-chip"
            data-status={status.kind}
            data-tone={status.tone}
            title={[
              t(status.detailZh, status.detailEn),
              status.adminNextZh ? t(status.adminNextZh, status.adminNextEn ?? '') : null,
              // Only a status the last test decided gets that test's reason, and in the
              // viewer's language — "untested" after an edit must not quote an old 401.
              TEST_DECIDED_STATUSES.has(status.kind)
                ? explainUpstreamError(lastTest?.error ?? null, t)
                : null,
            ]
              .filter(Boolean)
              .join(' — ')}
          >
            {t(status.zh, status.en)}
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      priority: 'high',
      hideInCard: true,
      width: 340,
      cell: (provider) => (
        <>
          <div className="row">
            <Button
              variant="ghost"
              size="s"
              onClick={() => setDrawer({ kind: 'detail', provider })}
              data-testid="provider-open"
            >
              {t('详情', 'Details')}
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
                    ? t(
                        `${provider.apiKeyEnv} 未配置 — 测试会被拒绝`,
                        `${provider.apiKeyEnv} not set, the test will be refused`,
                      )
                    : t(
                        '没有配置任何凭证 — 测试会被拒绝',
                        'no credential configured, the test will be refused',
                      )
              }
              data-testid="provider-test"
            >
              {t('测试调用', 'Test')}
            </Button>
            <Button
              variant="ghost"
              size="s"
              onClick={() => setDrawer({ kind: 'edit', provider })}
              disabled={meta?.storeWritable === false}
              data-testid="provider-edit"
            >
              {t('编辑', 'Edit')}
            </Button>
            {provider.enabled ? (
              <Confirm
                tier="medium"
                open={confirm.kind === 'disable' && confirm.provider.id === provider.id}
                onOpenChange={(open) =>
                  setConfirm(open ? { kind: 'disable', provider } : { kind: 'none' })
                }
                anchor={
                  <Button
                    variant="ghost"
                    size="s"
                    onClick={() => setConfirm({ kind: 'disable', provider })}
                    disabled={meta?.storeWritable === false}
                    data-testid="provider-disable"
                  >
                    {t('停用', 'Disable')}
                  </Button>
                }
                title={t('停用供应商', 'Disable provider')}
                description={t(
                  '模型代理会立即停止转发它，它的模型从模型目录里消失；用到这些模型的对话会失败，直到重新启用。',
                  'The proxy 404s it at once and it leaves models.json; chats on its models fail until re-enabled.',
                )}
                target={provider.displayName}
                impact={[
                  t(
                    `${provider.models.length} 个模型不再可用`,
                    `${provider.models.length} model(s) become unavailable`,
                  ),
                  provider.source === 'file'
                    ? t(
                        '在代理存储里建一条覆盖记录，yaml 不改',
                        'creates an override; the yaml is untouched',
                      )
                    : t('保留记录，可随时启用', 'the record is kept and can be re-enabled'),
                ]}
                confirmLabel={t('停用', 'Disable')}
                danger
                onConfirm={() => setEnabled(provider, false)}
                testId="provider-disable-confirm"
              />
            ) : (
              <Confirm
                tier="medium"
                open={confirm.kind === 'enable' && confirm.provider.id === provider.id}
                onOpenChange={(open) =>
                  setConfirm(open ? { kind: 'enable', provider } : { kind: 'none' })
                }
                anchor={
                  <Button
                    variant="ghost"
                    size="s"
                    onClick={() => setConfirm({ kind: 'enable', provider })}
                    disabled={meta?.storeWritable === false}
                    data-testid="provider-enable"
                  >
                    {t('启用', 'Enable')}
                  </Button>
                }
                title={t('启用供应商', 'Enable provider')}
                target={provider.displayName}
                confirmLabel={t('启用', 'Enable')}
                onConfirm={() => setEnabled(provider, true)}
                testId="provider-enable-confirm"
              />
            )}
            {provider.source === 'store' ? (
              <Confirm
                tier="irreversible"
                open={confirm.kind === 'delete' && confirm.provider.id === provider.id}
                onOpenChange={(open) =>
                  setConfirm(open ? { kind: 'delete', provider } : { kind: 'none' })
                }
                anchor={
                  <Button
                    variant="ghost"
                    size="s"
                    onClick={() => setConfirm({ kind: 'delete', provider })}
                    disabled={meta?.storeWritable === false}
                    data-testid="provider-delete"
                  >
                    {provider.overridesFile ? t('删除覆盖', 'Drop override') : t('删除', 'Delete')}
                  </Button>
                }
                title={
                  provider.overridesFile
                    ? t('删除覆盖记录', 'Drop override')
                    : t('删除供应商', 'Delete provider')
                }
                description={
                  provider.overridesFile
                    ? t(
                        '恢复为主机 llm-providers.yaml 里的同名条目。',
                        'The host yaml entry becomes visible again.',
                      )
                    : t(
                        '从模型代理里删除这个供应商，它的模型也从模型目录里移除；工作区里对这些模型的勾选会失效。',
                        'Removes the record from the proxy store and rewrites models.json; workspace selections of its models stop working.',
                      )
                }
                target={provider.id}
                impact={[
                  t(`${provider.models.length} 个模型`, `${provider.models.length} model(s)`),
                  t('写入平台审计', 'recorded in the platform audit'),
                ]}
                confirmLabel={t('删除', 'Delete')}
                onConfirm={() => remove(provider)}
                testId="provider-delete-confirm"
              />
            ) : null}
          </div>
          {rowError && rowError.id === provider.id ? (
            <InlineError error={rowError.error} testId="provider-row-error" />
          ) : null}
        </>
      ),
    },
    {
      id: 'api',
      header: 'API',
      cellClassName: 'text-small',
      cell: (provider) => t(API_LABEL[provider.api].zh, API_LABEL[provider.api].en),
    },
    {
      id: 'baseUrl',
      header: 'Base URL',
      cellClassName: 'mono text-small',
      cell: (provider) => provider.upstreamBaseUrl,
    },
    {
      id: 'models',
      header: t('模型', 'Models'),
      cell: (provider) => (
        <span className="tag" title={provider.models.map((m) => m.id).join(', ')}>
          {provider.models.length}
        </span>
      ),
    },
    {
      id: 'credential',
      header: t('凭证', 'Credential'),
      cell: (provider) => <CredentialState provider={provider} />,
    },
    {
      id: 'lastTest',
      header: t('最近测试', 'Last test'),
      cell: (provider) => {
        const lastTest = testResults[provider.id] ?? provider.lastTest;
        return lastTest ? (
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
          <span className="text-3 text-small">{t('未测试', 'untested')}</span>
        );
      },
    },
    {
      id: 'source',
      header: t('来源', 'Source'),
      cell: (provider) => (
        <span className="tag" data-testid="provider-source">
          {provider.source === 'file'
            ? 'yaml'
            : provider.overridesFile
              ? t('覆盖', 'yaml override')
              : t('控制台', 'console')}
        </span>
      ),
    },
  ];

  return (
    <div className="page" data-testid="platform-models-page">
      <PageHeader
        breadcrumb={breadcrumbFor('platformModels')}
        title={t('模型与供应商', 'Models & providers')}
        description={t(
          '模型代理里配置的供应商：名称、API 种类、Base URL、鉴权头、密钥、模型清单和是否启用；「测试调用」会做一次对话和一次工具调用。工作区只能从这里列出的模型里选。',
          'The providers llm-proxy routes to; workspaces only pick from this projection.',
        )}
        primaryAction={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setDrawer({ kind: 'create' })}
            disabled={meta?.storeWritable === false}
            data-testid="provider-create"
          >
            {t('新增供应商', 'Add provider')}
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
            {t('刷新', 'Refresh')}
          </Button>
        }
      />

      {meta && meta.storeWritable === false ? (
        <Notice tone="warn" testId="providers-store-unwritable">
          {t(
            '模型代理的状态目录不可写，新增 / 编辑 / 删除都会失败——请操作员在主机上运行 scripts/host-llm-proxy-init.sh 后 docker compose up -d --force-recreate llm-proxy。',
            'The proxy’s state directory is not writable; run scripts/host-llm-proxy-init.sh on the host, then recreate llm-proxy.',
          )}
        </Notice>
      ) : null}
      {meta?.modelsJsonError ? (
        <Notice tone="warn" testId="providers-models-json-error">
          {t(
            `最近一次重写 models.json 失败（${meta.modelsJsonError}）：代理已按新目录路由，但内核投影与新容器仍看旧文件——操作员运行 scripts/host-llm-proxy-init.sh（config/ 归 10001）后重建 llm-proxy，或手动 make gen-models。`,
            `The last models.json rewrite failed (${meta.modelsJsonError}): the proxy routes the new catalog, but the kernel projection and new containers still see the old file; run scripts/host-llm-proxy-init.sh and recreate llm-proxy, or make gen-models.`,
          )}
        </Notice>
      ) : null}

      <DefaultModelControl http={http} />

      <section className="section" aria-labelledby="providers-title">
        <div className="section-header">
          <h2 id="providers-title">{t('供应商', 'Providers')}</h2>
          {meta?.modelsJsonWrittenAt ? (
            <span className="text-small text-3" data-testid="providers-models-json-written">
              {t('models.json 重写于 ', 'models.json rewritten ')}
              <time title={formatDateTime(meta.modelsJsonWrittenAt)}>
                {formatRelative(meta.modelsJsonWrittenAt)}
              </time>
            </span>
          ) : null}
        </div>
        {list.state.status === 'loading' ? (
          <SkeletonRows count={3} label="Loading providers" testId="providers-loading" />
        ) : list.state.status === 'error' ? (
          llmAdminErrorMessage(list.state.error, t) !== null ? (
            <div className="stack-s">
              <InlineError error={list.state.error} testId="providers-error" />
              <div>
                <Button
                  variant="secondary"
                  size="s"
                  icon="refresh"
                  onClick={() => void list.reload()}
                >
                  {t('重试', 'Retry')}
                </Button>
              </div>
            </div>
          ) : (
            <ErrorBanner
              error={list.state.error}
              title={t('无法加载供应商', 'Could not load the providers')}
              onRetry={() => void list.reload()}
              testId="providers-error"
            />
          )
        ) : providers.length === 0 ? (
          <EmptyState
            icon="cpu"
            title={t('还没有供应商', 'No providers yet')}
            body={t(
              '点“新增供应商”，或由操作员在主机 llm-providers.yaml 里配置。',
              'Add one here, or have the operator configure llm-providers.yaml on the host.',
            )}
            testId="providers-empty"
          />
        ) : (
          <DataTable
            columns={providerColumns}
            data={providers}
            getRowId={(provider) => provider.id}
            ariaLabel="Providers"
            layout="sticky"
            testId="providers-table"
            rowTestId={(provider) => `provider-row-${provider.id}`}
            rowDataAttrs={(provider) => ({ 'data-provider-id': provider.id })}
          />
        )}
      </section>

      <WorkspaceModelMatrix http={http} />

      <Drawer
        open={drawer.kind === 'create'}
        title={t('新增供应商', 'Add provider')}
        subtitle={t(
          '保存后模型代理立即开始转发它，它的模型出现在模型目录里。',
          'Routed by the proxy and written to models.json on save.',
        )}
        onClose={() => setDrawer({ kind: 'closed' })}
        wide
        testId="provider-create-drawer"
      >
        {drawer.kind === 'create' ? (
          <ProviderForm
            client={client}
            existingIds={providers.map((row) => row.id)}
            onSubmit={(input, extras) => save(input, undefined, extras)}
            onCancel={() => setDrawer({ kind: 'closed' })}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={drawer.kind === 'edit' && drawerProvider !== undefined}
        title={t(
          `编辑 ${drawerProvider?.displayName ?? ''}`,
          `Edit ${drawerProvider?.displayName ?? ''}`,
        )}
        subtitle={drawerProvider?.id}
        onClose={() => setDrawer({ kind: 'closed' })}
        wide
        testId="provider-edit-drawer"
      >
        {drawer.kind === 'edit' && drawerProvider ? (
          <ProviderForm
            initial={drawerProvider}
            client={client}
            onSubmit={(input, extras) => save(input, drawerProvider, extras)}
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
          // S8 W1-A11 (audit L8): the drawer's fixed sections — metadata / edit form (no
          // related-object links here; a provider references nothing else in the console).
          <DrawerSections>
            <DrawerSection title={t('元数据', 'Metadata')}>
              <dl className="definition-list">
                <dt>API</dt>
                <dd>{t(API_LABEL[drawerProvider.api].zh, API_LABEL[drawerProvider.api].en)}</dd>
                <dt>Base URL</dt>
                <dd className="mono">{drawerProvider.upstreamBaseUrl}</dd>
                <dt>{t('鉴权头', 'Auth header')}</dt>
                <dd className="mono">
                  {drawerProvider.authHeader}
                  {drawerProvider.authScheme ? `: ${drawerProvider.authScheme} <key>` : ': <key>'}
                </dd>
                <dt>{t('密钥环境变量', 'Key env var')}</dt>
                <dd className="mono">
                  {drawerProvider.apiKeyEnv ?? (
                    <span className="text-3">{t('（未配置）', '(none)')}</span>
                  )}
                </dd>
                <dt>{t('来源', 'Source')}</dt>
                <dd>
                  {drawerProvider.source === 'file'
                    ? t('llm-providers.yaml（主机，只读）', 'llm-providers.yaml (host, read-only)')
                    : drawerProvider.overridesFile
                      ? t('控制台覆盖 yaml 同名条目', 'console override of the yaml entry')
                      : t('控制台', 'console store')}
                </dd>
                {drawerProvider.updatedAt ? (
                  <>
                    <dt>{t('更新', 'Updated')}</dt>
                    <dd>
                      <time title={formatDateTime(drawerProvider.updatedAt)}>
                        {formatRelative(drawerProvider.updatedAt)}
                      </time>
                    </dd>
                  </>
                ) : null}
              </dl>
              <CredentialState provider={drawerProvider} withInstruction />
              <div className="stack-s">
                <span className="section-title">{t('模型', 'Models')}</span>
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
            </DrawerSection>

            <DrawerSection title={t('连通性测试', 'Connectivity test')}>
              <ProviderTestPanel
                provider={drawerProvider}
                result={testResults[drawerProvider.id] ?? drawerProvider.lastTest}
                testing={testing === drawerProvider.id}
                busy={testing !== null}
                error={rowError && rowError.id === drawerProvider.id ? rowError.error : null}
                onTest={(model) => void runTest(drawerProvider, model)}
              />
            </DrawerSection>

            <DrawerSection title={t('密钥', 'Key')}>
              <ProviderSecretForm
                provider={drawerProvider}
                client={client}
                onUpdated={replaceRow}
              />
            </DrawerSection>
          </DrawerSections>
        ) : null}
      </Drawer>
    </div>
  );
}

/**
 * The detail drawer's 连通性测试 section: pick which of the provider's models to test (the proxy's
 * `POST /providers/:id/test {model}`; it defaults to the first one), run it, and read the outcome
 * in words (`ProviderTestResult`). A test that cannot start (no credential, a disabled provider)
 * says why next to the button instead of only in a tooltip.
 */
function ProviderTestPanel({
  provider,
  result,
  testing,
  busy,
  error,
  onTest,
}: {
  readonly provider: LlmProviderWire;
  readonly result: LlmProviderTestResultWire | null;
  readonly testing: boolean;
  readonly busy: boolean;
  readonly error: unknown;
  readonly onTest: (model: string) => void;
}) {
  const t = useT();
  const [model, setModel] = useState(result?.model ?? provider.models[0]?.id ?? '');
  const blocked = !provider.enabled
    ? t('供应商已停用，启用后才能测试。', 'The provider is disabled — enable it to test.')
    : !provider.credentialPresent
      ? t('还没有可用的密钥：先在下方设置。', 'No key yet — set one below first.')
      : provider.credentialInvalid
        ? t(
            '密钥含非法字符，测试一定失败：先在下方重新填写。',
            'The key has invalid characters, so the test would fail — re-enter it below first.',
          )
        : null;
  return (
    <div className="stack-s" data-testid="provider-test-panel">
      <div className="row-wrap">
        {provider.models.length > 1 ? (
          <Select
            aria-label={t('测试哪个模型', 'Model to test')}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={busy}
            data-testid="provider-test-model"
          >
            {provider.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName ? `${m.displayName} (${m.id})` : m.id}
              </option>
            ))}
          </Select>
        ) : null}
        <Button
          variant="secondary"
          size="s"
          onClick={() => onTest(model)}
          loading={testing}
          disabled={busy || blocked !== null}
          data-testid="provider-detail-run-test"
        >
          {result ? t('重新测试', 'Test again') : t('测试', 'Test')}
        </Button>
        {blocked ? <span className="text-small text-3">{blocked}</span> : null}
      </div>
      {testing ? (
        <p className="text-small text-2" aria-live="polite">
          {t(
            '正在测试：一次补全 + 一次工具调用，通常几秒到二十几秒…',
            'Testing — one completion and one tool call, usually a few seconds…',
          )}
        </p>
      ) : null}
      {error ? <InlineError error={error} testId="provider-detail-test-error" /> : null}
      {result && !testing ? (
        <ProviderTestResult result={result} testId="provider-detail-test" />
      ) : !testing && !error ? (
        <p className="text-small text-3">{t('还没测试过。', 'Not tested yet.')}</p>
      ) : null}
    </div>
  );
}

/**
 * S8 W4-C (ui-audit PMo1 "缺基线的'工作区 × 模型矩阵'（现只在单个工作区抽屉里配）"): §5.9's own
 * page prototype for 模型与供应商 calls for a workspace × model matrix; today the only way to see
 * which models a workspace allows is opening that one workspace's own drawer
 * (`WorkspaceDetailPanel`'s `AllowedModelsChecklist`) — there was no page that showed every
 * workspace's choice at once. Read-only here (editing stays in that drawer, the one place
 * `set_allowed_models`'s validation against the workspace's own entry model is actually checked);
 * `layout="sticky"` pins the workspace name and lets one column per catalog model scroll
 * underneath, the same shape the providers table above already uses for "too many columns".
 *
 * `list_workspaces{status:'active', includeExpired:false}` — the same default (residue-hidden)
 * filter the workspaces page itself defaults to (ui-audit O3 "计数与列表同口径"): an accept-*
 * workspace's model allow-list is not interesting here. `list_platform_models` (not this page's
 * own llm-proxy-admin `providers` list) is the id space `workspace.allowedModels` is actually
 * written in (`<providerId>/<modelId>`, `ModelRow.id`) — using the admin list's own, differently
 * shaped ids here would silently never match.
 */
function WorkspaceModelMatrix({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const workspaces = useCapabilityList<PlatformWorkspaceWire>(http, 'list_workspaces', {
    status: 'active',
    includeExpired: false,
  });
  const models = useCapabilityList<ModelRow>(http, 'list_platform_models');

  const workspaceRows = workspaces.state.status === 'ready' ? workspaces.state.data.items : [];
  const modelRows = models.state.status === 'ready' ? models.state.data.items : [];

  const columns = useMemo<readonly DataTableColumn<PlatformWorkspaceWire>[]>(() => {
    const base: DataTableColumn<PlatformWorkspaceWire>[] = [
      {
        id: 'workspace',
        header: t('工作区', 'Workspace'),
        priority: 'primary',
        width: 200,
        cell: (workspace) => <span className="truncate">{workspace.name}</span>,
      },
      {
        id: 'allowed',
        header: t('允许', 'Allowed'),
        priority: 'high',
        width: 90,
        cell: (workspace) =>
          workspace.allowedModels.length === 0 ? (
            <span className="text-3 text-small">{t('全部', 'All')}</span>
          ) : (
            <span className="mono text-small">{workspace.allowedModels.length}</span>
          ),
      },
    ];
    for (const model of modelRows) {
      base.push({
        id: `model:${model.id}`,
        // Audit P0-2: a column whose provider fails says so in its header.
        header: (
          <>
            {model.id} <ModelHealthTag model={model} />
          </>
        ),
        headerClassName: 'mono',
        cell: (workspace) =>
          workspace.allowedModels.length === 0 || workspace.allowedModels.includes(model.id) ? (
            <Icon name="check" label={t('允许', 'Allowed')} />
          ) : (
            <span aria-hidden="true">—</span>
          ),
      });
    }
    return base;
  }, [modelRows, t]);

  return (
    <DashboardCard
      title={t('工作区 × 模型矩阵', 'Workspace × model matrix')}
      padded={false}
      data-testid="workspace-model-matrix"
    >
      {workspaces.state.status === 'loading' || models.state.status === 'loading' ? (
        <SkeletonRows
          count={3}
          label={t('正在加载矩阵…', 'Loading the matrix')}
          testId="workspace-model-matrix-loading"
        />
      ) : workspaces.state.status === 'error' ? (
        <ErrorBanner
          error={workspaces.state.error}
          title={t('无法加载工作区列表', 'Could not load the workspace list')}
          onRetry={() => void workspaces.reload()}
          testId="workspace-model-matrix-error"
        />
      ) : models.state.status === 'error' ? (
        <ErrorBanner
          error={models.state.error}
          title={t('无法加载模型目录', 'Could not load the model catalog')}
          onRetry={() => void models.reload()}
          testId="workspace-model-matrix-models-error"
        />
      ) : workspaceRows.length === 0 ? (
        <EmptyState
          icon="grid"
          title={t('没有活跃的工作区', 'No active workspaces')}
          testId="workspace-model-matrix-empty"
        />
      ) : modelRows.length === 0 ? (
        <p className="text-3" style={{ padding: 'var(--space-4)' }}>
          {t('模型目录还没有可用模型。', 'No models in the catalog yet.')}
        </p>
      ) : (
        <DataTable
          columns={columns}
          data={workspaceRows}
          getRowId={(workspace) => workspace.id}
          ariaLabel={t('工作区 × 模型矩阵', 'Workspace × model matrix')}
          layout="sticky"
          testId="workspace-model-matrix-table"
          rowTestId={(workspace) => `workspace-model-matrix-row-${workspace.id}`}
        />
      )}
    </DashboardCard>
  );
}
