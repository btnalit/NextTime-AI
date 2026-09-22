import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ModelCostSchema, ProviderConfigSchema, RESERVED_PROVIDER_NAMES } from './config.js';
import type { ProviderConfig } from './config.js';

/**
 * provider-store: the console-managed half of the provider catalog (S6-B, docs/console-
 * completion-plan.md §5.4 "llm-proxy 热加载并原地重写 models.json"; docs/platform-admin-design.md
 * §6.2). A single JSON file in this service's own read-write state mount (`/data/state/
 * providers.json`, `${NEXTTIME_DATA}/llm-proxy` on the host), holding every provider the
 * administrator created or edited through `/admin/providers*` (admin-api.ts). The operator-managed
 * `llm-providers.yaml` (config.ts) is untouched by this file and stays read-only; catalog.ts
 * merges the two by name, store over file.
 *
 * On disk the entries use the yaml's own snake_case field names (`upstream_base_url`,
 * `api_key_env`) plus this store's own lifecycle fields — one schema family for both sources, so
 * `catalog.ts` can hand either straight to `proxy.ts` as a `ProviderConfig`. The camelCase wire
 * shape the console sees (`@nexttime/shared` wire/llm-admin.ts) is produced in admin-api.ts.
 *
 * Writes are atomic: `<file>.tmp-<pid>` + `rename` (same guarantee the Makefile's `gen-models`
 * target gives `models.json`), so a crash mid-write never leaves a truncated store for the next
 * start to choke on. A missing file is an empty store; an unreadable-but-present file fails
 * loudly (`ProviderStoreError`) — silently ignoring a corrupt store would make every console
 * change "disappear". Whether the directory is writable is probed once (`writable`) so the admin
 * API can answer 503 `store_unwritable` with the operator step instead of an opaque EACCES.
 *
 * What is never here: a provider key. The store carries `api_key_env` — the *name* of the env
 * var the operator sets in `secrets/llm-proxy.env` — exactly like the yaml.
 */

export const PROVIDER_STORE_VERSION = 1;

const StoreModelSchema = z
  .object({
    id: z.string().min(1),
    cost: ModelCostSchema.optional(),
    display_name: z.string().min(1).optional(),
  })
  .strict();

const StoreTestResultSchema = z
  .object({
    model: z.string(),
    completion: z.enum(['ok', 'error', 'skipped']),
    tool_call: z.enum(['ok', 'error', 'skipped']),
    latency_ms: z.number().int().nonnegative(),
    error: z.string().nullable(),
    tested_at: z.string(),
  })
  .strict();
export type StoreTestResult = z.infer<typeof StoreTestResultSchema>;

export const StoreProviderSchema = ProviderConfigSchema.extend({
  models: z.array(StoreModelSchema).min(1),
  enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  last_test: StoreTestResultSchema.nullable().optional(),
}).strict();
export type StoreProvider = z.infer<typeof StoreProviderSchema>;

export const ProviderStoreFileSchema = z
  .object({
    version: z.literal(PROVIDER_STORE_VERSION),
    providers: z.record(z.string(), StoreProviderSchema),
  })
  .strict();
export type ProviderStoreFile = z.infer<typeof ProviderStoreFileSchema>;

export class ProviderStoreError extends Error {
  readonly code: 'unreadable' | 'invalid' | 'unwritable' | 'reserved_name';

  constructor(code: ProviderStoreError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderStoreError';
    this.code = code;
  }
}

function emptyStore(): ProviderStoreFile {
  return { version: PROVIDER_STORE_VERSION, providers: {} };
}

/** Strips the store-only lifecycle fields, leaving exactly the `ProviderConfig` proxy.ts routes
 *  on (the yaml schema is `.strict()`, so the extra keys must not leak through). */
export function storeProviderToConfig(entry: StoreProvider): ProviderConfig {
  const { enabled: _enabled, created_at: _c, updated_at: _u, last_test: _t, ...config } = entry;
  return config;
}

export class ProviderStore {
  private readonly filePath: string;
  private state: ProviderStoreFile = emptyStore();
  private writableState: boolean | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  /** Reads and validates the file. Missing → empty store (first run). Present but unreadable /
   *  invalid → throws, see module doc. Safe to call again to re-read from disk. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        this.state = emptyStore();
        return;
      }
      throw new ProviderStoreError(
        'unreadable',
        `cannot read the provider store at "${this.filePath}" (${code ?? 'error'})`,
        { cause: err },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ProviderStoreError(
        'invalid',
        `the provider store at "${this.filePath}" is not valid JSON`,
        { cause: err },
      );
    }
    const result = ProviderStoreFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new ProviderStoreError(
        'invalid',
        `the provider store at "${this.filePath}" does not match the expected schema: ${result.error.message}`,
        { cause: result.error },
      );
    }
    this.state = result.data;
  }

  /** Whether this process can write the store's directory — probed once, cached. `false` is
   *  the "operator has not created / chowned the state directory" case the admin API reports. */
  async writable(): Promise<boolean> {
    if (this.writableState !== undefined) return this.writableState;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await access(dirname(this.filePath), fsConstants.W_OK);
      this.writableState = true;
    } catch {
      this.writableState = false;
    }
    return this.writableState;
  }

  get(id: string): StoreProvider | undefined {
    return this.state.providers[id];
  }

  entries(): ReadonlyArray<readonly [string, StoreProvider]> {
    return Object.entries(this.state.providers);
  }

  /** Inserts or replaces one entry and persists atomically. Refuses reserved names (config.ts
   *  `RESERVED_PROVIDER_NAMES`). `created_at` is preserved across replacements. */
  async upsert(
    id: string,
    entry: Omit<StoreProvider, 'created_at' | 'updated_at'>,
    now: Date = new Date(),
  ): Promise<StoreProvider> {
    if (RESERVED_PROVIDER_NAMES.has(id)) {
      throw new ProviderStoreError(
        'reserved_name',
        `provider id "${id}" is reserved for this proxy's own routes`,
      );
    }
    const existing = this.state.providers[id];
    const stamped: StoreProvider = StoreProviderSchema.parse({
      ...entry,
      created_at: existing?.created_at ?? now.toISOString(),
      updated_at: now.toISOString(),
    });
    const next: ProviderStoreFile = {
      version: PROVIDER_STORE_VERSION,
      providers: { ...this.state.providers, [id]: stamped },
    };
    await this.persist(next);
    this.state = next;
    return stamped;
  }

  /** Records a test outcome on an existing store entry (no-op for a file-only provider — the
   *  catalog keeps those results in memory, see catalog.ts). */
  async recordTest(id: string, result: StoreTestResult): Promise<boolean> {
    const existing = this.state.providers[id];
    if (!existing) return false;
    const next: ProviderStoreFile = {
      version: PROVIDER_STORE_VERSION,
      providers: { ...this.state.providers, [id]: { ...existing, last_test: result } },
    };
    await this.persist(next);
    this.state = next;
    return true;
  }

  /** Removes one entry and persists atomically. `false` when it was not there. */
  async remove(id: string): Promise<boolean> {
    if (!(id in this.state.providers)) return false;
    const { [id]: _removed, ...rest } = this.state.providers;
    const next: ProviderStoreFile = { version: PROVIDER_STORE_VERSION, providers: rest };
    await this.persist(next);
    this.state = next;
    return true;
  }

  private async persist(next: ProviderStoreFile): Promise<void> {
    if (!(await this.writable())) {
      throw new ProviderStoreError(
        'unwritable',
        `the provider store directory "${dirname(this.filePath)}" is not writable by this process`,
      );
    }
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw new ProviderStoreError(
        'unwritable',
        `failed to write the provider store at "${this.filePath}": ${String(err)}`,
        { cause: err },
      );
    }
  }
}
