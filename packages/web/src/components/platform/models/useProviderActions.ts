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

/** What the form asks for beyond the provider row (providers/ProviderForm.tsx
 *  `ProviderFormExtras`, restated here so this file imports nothing from `components/ui/*`'s
 *  neighbours). */
export interface SaveExtras {
  readonly key?: string;
  readonly testAfterSave?: boolean;
}

export interface ProviderActionsState {
  readonly testing: string | null;
  readonly testResults: Record<string, LlmProviderTestResultWire>;
  readonly rowError: { id: string; error: unknown } | null;
  readonly replaceRow: (updated: LlmProviderWire) => void;
  readonly save: (
    input: LlmProviderInputWire,
    existing: LlmProviderWire | undefined,
    extras?: SaveExtras,
  ) => Promise<void>;
  readonly setEnabled: (provider: LlmProviderWire, enabled: boolean) => Promise<void>;
  readonly remove: (provider: LlmProviderWire) => Promise<void>;
  readonly runTest: (provider: LlmProviderWire, model?: string) => Promise<void>;
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

  /**
   * Saves the provider row, then — only once the row exists — applies the form's extras: the typed
   * key becomes the provider's console key (`PUT /providers/:id/secret`), and 测试调用 runs right
   * away. A saved row whose key could not be written is not a failed save: the drawer switches to
   * the provider's detail (where the key can be set again) with the error shown, instead of the
   * form reporting "could not save" for a row that is already there. With a test, the drawer also
   * switches to the detail, so the result lands in front of the administrator.
   */
  async function save(
    input: LlmProviderInputWire,
    existing: LlmProviderWire | undefined,
    extras: SaveExtras = {},
  ): Promise<void> {
    let saved = existing ? await client.updateProvider(input) : await client.createProvider(input);
    replaceRow(saved);
    let keyError: unknown = null;
    if (extras.key) {
      try {
        saved = await client.setProviderSecret(saved.id, extras.key);
        replaceRow(saved);
      } catch (error) {
        keyError = error;
      }
    }
    toast.push({
      tone: keyError ? 'warn' : 'ok',
      title: existing
        ? t(`已保存 ${saved.displayName}`, `Saved ${saved.displayName}`)
        : t(`已新增 ${saved.displayName}`, `Added ${saved.displayName}`),
      description: keyError
        ? t(
            '供应商已保存，但密钥没有写入——在详情里重新设置。',
            'The provider is saved, but the key was not written — set it again in the details.',
          )
        : t(
            'models.json 已重写；工作区「模型与配额」里可以勾选它的模型。',
            'models.json rewritten — workspaces can now allow its models.',
          ),
    });
    void list.reload();
    if (keyError) {
      setRowError({ id: saved.id, error: keyError });
      setDrawer({ kind: 'detail', provider: saved });
      return;
    }
    if (extras.testAfterSave && saved.enabled && saved.credentialPresent) {
      setDrawer({ kind: 'detail', provider: saved });
      await runTest(saved);
      return;
    }
    setDrawer({ kind: 'closed' });
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
        ? t(
            `已删除覆盖记录，恢复为 yaml 里的 ${provider.id}`,
            `Override dropped — ${provider.id} from the yaml is back`,
          )
        : t(`已删除 ${provider.displayName}`, `Deleted ${provider.displayName}`),
    });
    // P2 hotfix (post-v0.16.0 review): a deleted provider's console key is now also cleared
    // (llm-proxy's DELETE /providers/:id) — surface it separately so it is not lost inside the
    // delete toast's own title.
    if (result.secretCleared) {
      toast.push({ tone: 'ok', title: t('已一并清除控制台密钥', 'Console key cleared as well') });
    }
    void list.reload();
  }

  async function runTest(provider: LlmProviderWire, model?: string): Promise<void> {
    setTesting(provider.id);
    setRowError(null);
    try {
      const result = await client.testProvider(provider.id, model ? { model } : {});
      setTestResults((prev) => ({ ...prev, [provider.id]: result }));
      replaceRow({ ...provider, lastTest: result });
      const passed = result.completion === 'ok' && result.toolCall === 'ok';
      toast.push({
        tone: passed ? 'ok' : 'warn',
        title: passed
          ? t(`${provider.displayName}：测试通过`, `${provider.displayName}: test passed`)
          : result.completion === 'ok'
            ? t(
                `${provider.displayName}：能对话，工具调用失败`,
                `${provider.displayName}: chat ok, tool call failed`,
              )
            : t(`${provider.displayName}：调用失败`, `${provider.displayName}: call failed`),
        description: passed
          ? `${result.model} · ${result.latencyMs} ms`
          : t('详情里有原因说明。', 'See the details for why.'),
      });
    } catch (error) {
      setRowError({ id: provider.id, error });
    } finally {
      setTesting(null);
    }
  }

  return { testing, testResults, rowError, replaceRow, save, setEnabled, remove, runTest };
}
