import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { Mutex } from './mutex.js';

/**
 * key-store: the console-written provider secrets (S7-A, docs/STATUS.md 维护者决定 2026-09-22 ①
 * "NO approval flow; usability first"). A single JSON file in llm-proxy's own read-write state
 * mount — `/data/state/keys.json`, the *same* directory `provider-store.ts`'s `providers.json`
 * already lives in (`${NEXTTIME_DATA}/llm-proxy`, already 10001-owned by
 * `scripts/host-llm-proxy-init.sh` — no new host step) — keyed by **provider id**, holding the
 * real key value.
 *
 * This is the one place in this codebase that holds a provider key outside the operator's own
 * `secrets/llm-proxy.env` — a deliberate, scoped exception to "agent / kernel 进程不持凭证": it is
 * still only llm-proxy's own process, never the kernel or an agent container, and the value never
 * leaves this file except into an outbound request to the provider's own upstream (proxy.ts,
 * provider-test.ts). It must never appear in a log line, an error message, an HTTP response, an
 * audit row, or `models.json` (whose own `apiKey` field is always the literal template string
 * `$CAPABILITY_HANDLE` — gen-models-json.ts).
 *
 * Resolution order (admin-api.ts `credentialSource`, proxy.ts `resolveConsoleKey`): a console key
 * for a provider's id always wins over that provider's `api_key_env` (file or store) — "console
 * overrides env" holds even for a pure yaml/file provider, so an operator-configured provider can
 * still get a key set purely through the console without editing `secrets/llm-proxy.env`.
 *
 * Same on-disk discipline as `provider-store.ts`: atomic writes (`<file>.tmp-<pid>` + `rename`,
 * never a partial file a concurrent reader could observe), a missing file is an empty store, an
 * unreadable-but-present file fails loudly (`KeyStoreError`) rather than silently discarding every
 * console key, `writable()` probes the directory once so the admin API can answer 503
 * `store_unwritable` instead of an opaque EACCES, and an in-process `Mutex` (mutex.ts) serializes
 * concurrent `set`/`remove` calls so two racing admin requests can never interleave a read-modify-
 * write and lose one of the two writes (S6-B leftover 50, same fix applied to `ProviderStore`).
 *
 * The one difference from `provider-store.ts`: this file is mode **0600** (owner read/write only,
 * no group/other bits at all) — it holds secret values, not a metadata record whose worst-case
 * leak is a base URL and a model list.
 */

export const KEY_STORE_VERSION = 1;

export const KeyStoreFileSchema = z
  .object({
    version: z.literal(KEY_STORE_VERSION),
    keys: z.record(z.string(), z.string().min(1)),
  })
  .strict();
export type KeyStoreFile = z.infer<typeof KeyStoreFileSchema>;

const KEY_STORE_FILE_MODE = 0o600;

export class KeyStoreError extends Error {
  readonly code: 'unreadable' | 'invalid' | 'unwritable';

  constructor(code: KeyStoreError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeyStoreError';
    this.code = code;
  }
}

function emptyStore(): KeyStoreFile {
  return { version: KEY_STORE_VERSION, keys: {} };
}

export class KeyStore {
  private readonly filePath: string;
  private state: KeyStoreFile = emptyStore();
  private writableState: boolean | undefined;
  private readonly mutex = new Mutex();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  /** Reads and validates the file. Missing → empty store (first run, or no console key has ever
   *  been set). Present but unreadable / invalid → throws, see module doc. Safe to call again to
   *  re-read from disk. */
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
      throw new KeyStoreError(
        'unreadable',
        `cannot read the key store at "${this.filePath}" (${code ?? 'error'})`,
        { cause: err },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new KeyStoreError('invalid', `the key store at "${this.filePath}" is not valid JSON`, {
        cause: err,
      });
    }
    const result = KeyStoreFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new KeyStoreError(
        'invalid',
        `the key store at "${this.filePath}" does not match the expected schema`,
        { cause: result.error },
      );
    }
    this.state = result.data;
  }

  /** Whether this process can write the store's directory — probed once, cached. `false` is the
   *  "operator has not created / chowned the state directory" case the admin API reports as 503
   *  `store_unwritable` — the same directory `provider-store.ts`'s own `writable()` probes, so the
   *  two stores always agree. */
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

  /** `true` when a console key is set for this provider id — never returns the value itself. */
  has(id: string): boolean {
    return id in this.state.keys;
  }

  /** The console key for this provider id, or `undefined` — read from the in-memory state kept
   *  current by `load()`/`set()`/`remove()`, never a fresh disk read (hot: no restart needed
   *  after a write from this same process). */
  get(id: string): string | undefined {
    return this.state.keys[id];
  }

  /** Sets (or replaces) the console key for `id` and persists atomically, mode 0600. The caller
   *  (admin-api.ts) validates and trims the value before calling this — this method stores
   *  exactly what it is given. */
  async set(id: string, key: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const next: KeyStoreFile = {
        version: KEY_STORE_VERSION,
        keys: { ...this.state.keys, [id]: key },
      };
      await this.persist(next);
      this.state = next;
    });
  }

  /** Removes the console key for `id`, if any, and persists atomically. `false` when there was
   *  none (a no-op DELETE — the admin API still reports success: the end state, "no console key",
   *  already holds). */
  async remove(id: string): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      if (!(id in this.state.keys)) return false;
      const { [id]: _removed, ...rest } = this.state.keys;
      const next: KeyStoreFile = { version: KEY_STORE_VERSION, keys: rest };
      await this.persist(next);
      this.state = next;
      return true;
    });
  }

  private async persist(next: KeyStoreFile): Promise<void> {
    if (!(await this.writable())) {
      throw new KeyStoreError(
        'unwritable',
        `the key store directory "${dirname(this.filePath)}" is not writable by this process`,
      );
    }
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        mode: KEY_STORE_FILE_MODE,
      });
      // writeFile's `mode` only applies when it *creates* the file — a pre-existing `.tmp-<pid>`
      // debris file from a prior crash (same pid, unlikely but not impossible after a reboot's
      // pid reuse) could otherwise keep its old mode; `chmod` makes the guarantee unconditional.
      await chmod(tmp, KEY_STORE_FILE_MODE);
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw new KeyStoreError(
        'unwritable',
        `failed to write the key store at "${this.filePath}": ${String(err)}`,
        { cause: err },
      );
    }
  }
}
