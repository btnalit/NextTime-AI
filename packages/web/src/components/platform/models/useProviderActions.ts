import type {
  LlmProviderInputWire,
  LlmProviderListWire,
  LlmProviderTestResultWire,
  LlmProviderWire,
} from '@nexttime/shared';
import { type Dispatch, type SetStateAction, useState } from 'react';
import type { Resource } from '../../../hooks/useResource.js';
import type { Translate } from '../../../lib/i18n.js';
import type { LlmAdminClient } from '../../../lib/llm-admin.js';

/** The minimum shape `useProviderActions` needs from `useToast()` — kept local (not `ToastApi`
 *  from `components/ui/Toast`) so this file imports nothing from `components/ui/*`
 *  (S8 §5e risk ①, `scripts/guards/css-tokens.mjs`). Structurally compatible with the real
 *  `ToastApi`, so passing it straight through from `PlatformModelsPage` needs no adapter. */
export interface ToastPusher {
  readonly push: (input: {
    readonly tone?: 'info' | 'ok' | 'warn' | 'danger';
    readonly title: string;
    readonly description?: string;
  }) => number;
}

export type DrawerState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly provider: LlmProviderWire }
  | { readonly kind: 'detail'; readonly provider: LlmProviderWire };

export interface ProviderActionsState {
  readonly testing: string | null;
  readonly testResults: Record<string, LlmProviderTestResultWire>;
  readonly rowError: { id: string; error: unknown } | null;
  readonly replaceRow: (updated: LlmProviderWire) => void;
  readonly save: (
    input: LlmProviderInputWire,
    existing: LlmProviderWire | undefined,
  ) => Promise<void>;
  readonly setEnabled: (provider: LlmProviderWire, enabled: boolean) => Promise<void>;
  readonly remove: (provider: LlmProviderWire) => Promise<void>;
  readonly runTest: (provider: LlmProviderWire) => Promise<void>;
}

/**
 * components/platform/models/useProviderActions: `PlatformModelsPage`'s provider CRUD + test-call
 * mutations — split out of the page itself (console redesign P1) because none of it renders JSX
 * and it does not need anything from `components/ui/*`. Every mutation goes through
 * `lib/llm-admin.ts`'s `LlmAdminClient` (a 5-minute JWT, then llm-proxy's admin endpoints directly
 * through caddy `/api/llm-admin/*`) — nothing here goes through a kernel capability except the
 * token mint.
 */
export function useProviderActions(
  client: LlmAdminClient,
  drawer: DrawerState,
  list: Resource<LlmProviderListWire>,
  setDrawer: Dispatch<SetStateAction<DrawerState>>,
  toast: ToastPusher,
  t: Translate,
): ProviderActionsState {
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, LlmProviderTestResultWire>>({});
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);

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
      description: t(
        'models.json 已重写；工作区"模型与配额"可勾选它的模型。 models.json rewritten —',
        'workspaces can now allow its models.',
      ),
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
      toast.push({ tone: 'ok', title: t('已一并清除控制台密钥 ·', 'Console key cleared as well') });
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

  return { testing, testResults, rowError, replaceRow, save, setEnabled, remove, runTest };
}
