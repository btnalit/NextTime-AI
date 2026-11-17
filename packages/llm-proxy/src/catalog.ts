import { upstreamBaseUrlProblem } from '@nexttime/shared';
import type { ProviderConfig } from './config.js';
import { Mutex } from './mutex.js';
import type { ProviderStore, StoreProvider, StoreTestResult } from './provider-store.js';
import { storeProviderToConfig } from './provider-store.js';
import type { TestedKeys } from './tested-keys.js';

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
 *
 * Which test result applies (legacy 202, 203): with `testedKeys` wired (index.ts does), a
 * provider's `lastTest` is the recorded result only while the provider would still send the key
 * that result ran with (tested-keys.ts). A key rotated by a restart, or changed while a test was
 * running, leaves the result unshown — the provider reads 未测试 until it is tested again.
 */

/** What the catalog needs to tell whether a test result is about the key in use now. */
export interface CatalogTestedKeys {
  readonly store: TestedKeys;
  /** The key the provider would send now — the S7-A order (a console key, then `apiKeyEnv`),
   *  provider-keys.ts `currentProviderKey`. */
  readonly currentKey: (id: string, apiKeyEnv: string | undefined) => string | undefined;
}

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
  private readonly testedKeys: CatalogTestedKeys | undefined;
  /** One `recordTest` at a time, so a result and the entry naming its key are written as a pair:
   *  two tests finishing together cannot leave one's result beside the other's entry. */
  private readonly testWrites = new Mutex();

  constructor(
    fileProviders: Readonly<Record<string, ProviderConfig>>,
    store: ProviderStore,
    testedKeys?: CatalogTestedKeys,
  ) {
    this.fileProviders = fileProviders;
    this.store = store;
    this.testedKeys = testedKeys;
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
          ? this.fromStore(id, override, true)
          : {
              id,
              config,
              enabled: true,
              source: 'file',
              overridesFile: false,
              displayName: config.display_name ?? id,
              createdAt: null,
              updatedAt: null,
              lastTest: this.applicableTest(id, config, this.fileTestResults.get(id) ?? null),
            },
      );
    }
    for (const [id, entry] of storeEntries) {
      if (seen.has(id)) continue;
      result.push(this.fromStore(id, entry, false));
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

  /** Records a test outcome where it can live — on the store entry when there is one, else in
   *  memory for a file-only provider — and then which key it ran with (`key`, the one the test
   *  sent). A crash between the two writes is safe either way round: the result and the entry
   *  name different `tested_at`s, so the result is not shown (tested-keys.ts). What makes that hold
   *  for a provider's first result is tracking it before the result is written. The result goes
   *  first so that a result write that fails leaves the previous result and its entry still
   *  paired, shown as before, rather than hiding a result that is still true. */
  async recordTest(id: string, result: StoreTestResult, key: string): Promise<void> {
    await this.testWrites.runExclusive(async () => {
      const testedKeys = this.testedKeys?.store;
      if (testedKeys && !testedKeys.tracks(id)) await testedKeys.track(id);
      const recorded = await this.store.recordTest(id, result);
      if (!recorded) this.fileTestResults.set(id, result);
      await testedKeys?.record(id, result.tested_at, key);
    });
  }

  /** Forgets the provider's last test, wherever it lives (review S1): called when its console key
   *  is set or cleared, so the provider reads 未测试 until it is tested with the key now in use. A
   *  test still running when this is called records its result afterwards; that result names the
   *  key it ran with, so it is not shown for the new one (legacy 203). */
  async clearTest(id: string): Promise<void> {
    this.fileTestResults.delete(id);
    await this.store.clearTest(id);
  }

  /** `test` when it ran with the key the provider would send now, or when its key is unknown
   *  (recorded before tested-keys.json existed: shown as before); else `null`. */
  private applicableTest(
    id: string,
    config: ProviderConfig,
    test: StoreTestResult | null,
  ): StoreTestResult | null {
    if (test === null || this.testedKeys === undefined) return test;
    const currentKey = this.testedKeys.currentKey(id, config.api_key_env);
    return this.testedKeys.store.match(id, test.tested_at, currentKey) === 'other' ? null : test;
  }

  private fromStore(id: string, entry: StoreProvider, overridesFile: boolean): ResolvedProvider {
    const config = storeProviderToConfig(entry);
    return {
      id,
      config,
      enabled: entry.enabled,
      source: 'store',
      overridesFile,
      displayName: entry.display_name ?? id,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
      lastTest: this.applicableTest(id, config, entry.last_test ?? null),
    };
  }
}

/** Enabled, and its upstream base passes the bare-base rule — the one test for "requests may be
 *  sent to this provider", shared by routing and the models.json rewrite. */
export function isRoutable(provider: ResolvedProvider): boolean {
  return provider.enabled && upstreamBaseUrlProblem(provider.config.upstream_base_url) === null;
}
