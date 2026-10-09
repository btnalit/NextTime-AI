import { upstreamBaseUrlProblem } from '@nexttime/shared';
import type { ProviderConfig } from './config.js';
import type { ProviderStore, StoreProvider, StoreTestResult } from './provider-store.js';
import { storeProviderToConfig } from './provider-store.js';

/**
 * catalog: the one merged view of "which providers exist" that every consumer in this process
 * reads — `proxy.ts` (routing: enabled providers only), `admin-api.ts` (listing, with source and
 * override facts), `gen-models-json.ts` (the `models.json` rewrite) and `cli/gen-models.ts`
 * (`make gen-models`, so the operator path and the console path can never disagree about the
 * catalog). S6-B, docs/console-completion-plan.md §5.4.
 *
 * Merge rule, by provider name: a store entry (provider-store.ts, written through the console)
 * overrides a same-named file entry (`llm-providers.yaml`, operator-managed) completely — no
 * field-level merge, because a half-merged provider (file's base URL + store's api kind) would be
 * exactly the confusing state an operator could never reproduce from either file alone. File
 * entries are always `enabled: true` (the yaml has no such flag; disabling a file provider means
 * writing a store override with `enabled: false`); deleting the override restores the file entry
 * (`overridesFile` tells the console which case it is looking at).
 *
 * Hot reload: `resolve()` recomputes from the store's current in-memory state on every call —
 * cheap (a handful of providers), and it means an admin mutation is visible to the very next
 * proxied request with no restart and no cache to invalidate. The yaml is read once at startup
 * (config.ts) — a change there still needs a restart, unchanged from S1.7.
 */

export type ProviderSource = 'file' | 'store';

export interface ResolvedProvider {
  readonly id: string;
  readonly config: ProviderConfig;
  readonly enabled: boolean;
  readonly source: ProviderSource;
  /** `true` when a store entry shadows a same-named file entry. */
  readonly overridesFile: boolean;
  readonly displayName: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly lastTest: StoreTestResult | null;
}

export class ProviderCatalog {
  private readonly fileProviders: Readonly<Record<string, ProviderConfig>>;
  private readonly store: ProviderStore;
  /** Test outcomes for file-only providers — nothing on disk to record them on (the yaml is
   *  read-only), so they live for this process's lifetime only. */
  private readonly fileTestResults = new Map<string, StoreTestResult>();

  constructor(fileProviders: Readonly<Record<string, ProviderConfig>>, store: ProviderStore) {
    this.fileProviders = fileProviders;
    this.store = store;
  }

  /** Every provider from both sources, merged (store over file), in a stable order: file
   *  entries in yaml order, then store-only entries in store order. */
  resolve(): readonly ResolvedProvider[] {
    const result: ResolvedProvider[] = [];
    const seen = new Set<string>();
    const storeEntries = new Map<string, StoreProvider>(this.store.entries());

    for (const [id, config] of Object.entries(this.fileProviders)) {
      const override = storeEntries.get(id);
      seen.add(id);
      result.push(
        override
          ? fromStore(id, override, true)
          : {
              id,
              config,
              enabled: true,
              source: 'file',
              overridesFile: false,
              displayName: config.display_name ?? id,
              createdAt: null,
              updatedAt: null,
              lastTest: this.fileTestResults.get(id) ?? null,
            },
      );
    }
    for (const [id, entry] of storeEntries) {
      if (seen.has(id)) continue;
      result.push(fromStore(id, entry, false));
    }
    return result;
  }

  get(id: string): ResolvedProvider | undefined {
    return this.resolve().find((provider) => provider.id === id);
  }

  /** Whether `id` exists in the operator's yaml (regardless of any override). */
  hasFileEntry(id: string): boolean {
    return id in this.fileProviders;
  }

  /** Every yaml entry as the operator wrote it, including one a store override currently shadows —
   *  admin-api.ts reads it as the operator's own pairing of an env var with an upstream (R-23). */
  fileEntries(): ReadonlyArray<readonly [string, ProviderConfig]> {
    return Object.entries(this.fileProviders);
  }

  /** Routing lookup for proxy.ts: the `ProviderConfig` for an *enabled* provider, else
   *  `undefined` — a disabled provider is indistinguishable from an unknown one to a caller
   *  (404 `unknown_provider`), so disabling is an immediate, complete cut-off. */
  getRoutable(id: string): ProviderConfig | undefined {
    const provider = this.get(id);
    return provider && isRoutable(provider) ? provider.config : undefined;
  }

  /** Providers whose saved `upstream_base_url` breaks the bare-base rule (shared
   *  `upstreamBaseUrlProblem`: a `?`, `#`, userinfo or non-http scheme). The admin API refuses
   *  such a base since #510, but a row saved before that (store or yaml) still loads — it is
   *  never routed, tested or put in models.json, and index.ts logs it at startup so the operator
   *  can fix it in the console. Loading rather than refusing the whole file keeps one bad row
   *  from taking every other provider down with it. */
  unsafeBaseUrls(): ReadonlyArray<{ readonly id: string; readonly problem: string }> {
    return this.resolve().flatMap((provider) => {
      const problem = upstreamBaseUrlProblem(provider.config.upstream_base_url);
      return problem ? [{ id: provider.id, problem }] : [];
    });
  }

  /** Records a test outcome where it can live: on the store entry when there is one, else in
   *  memory for a file-only provider. */
  async recordTest(id: string, result: StoreTestResult): Promise<void> {
    const recorded = await this.store.recordTest(id, result);
    if (!recorded) this.fileTestResults.set(id, result);
  }

  /** Forgets the provider's last test, wherever it lives (review S1): called when its console key
   *  is set or cleared, so the provider reads 未测试 until it is tested with the key now in use. */
  async clearTest(id: string): Promise<void> {
    this.fileTestResults.delete(id);
    await this.store.clearTest(id);
  }
}

function fromStore(id: string, entry: StoreProvider, overridesFile: boolean): ResolvedProvider {
  return {
    id,
    config: storeProviderToConfig(entry),
    enabled: entry.enabled,
    source: 'store',
    overridesFile,
    displayName: entry.display_name ?? id,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    lastTest: entry.last_test ?? null,
  };
}

/** Enabled, and its upstream base passes the bare-base rule — the one test for "requests may be
 *  sent to this provider", shared by routing and the models.json rewrite. */
export function isRoutable(provider: ResolvedProvider): boolean {
  return provider.enabled && upstreamBaseUrlProblem(provider.config.upstream_base_url) === null;
}
