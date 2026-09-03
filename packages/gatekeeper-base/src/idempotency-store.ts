import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * `apply`'s idempotency store (design doc §5.1.4 "apply 幂等"): a repeat `apply` call with the
 * same `idempotencyKey` returns the stored result instead of re-executing.
 *
 * Durability/limits (task brief: "document durability limits"): a single JSON file, fully loaded
 * into memory at construction and rewritten in full on every `set` (atomic via write-to-temp-then-
 * rename, so a crash mid-write never corrupts the existing file). This is adequate for one gate
 * process with a modest number of Operations — it is **not** safe for multiple gate processes
 * sharing the same file (no cross-process locking) and is O(n) per write in the number of stored
 * keys (no compaction/pruning here — an operator wanting bounded growth should periodically prune
 * old entries out-of-band, or a future task should replace this with a real embedded KV store).
 */

export interface IdempotencyStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface StoreFileShape {
  readonly entries: Record<string, { readonly storedAt: string; readonly value: unknown }>;
}

export class JsonFileIdempotencyStore implements IdempotencyStore {
  private readonly filePath: string;
  private loaded: Map<string, unknown> | undefined;
  private loadPromise: Promise<Map<string, unknown>> | undefined;

  constructor(dataDir: string, fileName = 'idempotency-store.json') {
    this.filePath = join(dataDir, fileName);
  }

  private async load(): Promise<Map<string, unknown>> {
    if (this.loaded) return this.loaded;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await readFile(this.filePath, 'utf8');
          const parsed = JSON.parse(raw) as StoreFileShape;
          const map = new Map<string, unknown>();
          for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
            map.set(key, entry.value);
          }
          this.loaded = map;
          return map;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            this.loaded = new Map();
            return this.loaded;
          }
          throw err;
        }
      })();
    }
    return this.loadPromise;
  }

  async get(key: string): Promise<unknown | undefined> {
    const map = await this.load();
    return map.get(key);
  }

  /** Idempotent set: if `key` is already stored, this is a no-op (the first writer wins — a
   *  concurrent `apply` racing on the same key must never overwrite the winner's result). */
  async set(key: string, value: unknown): Promise<void> {
    const map = await this.load();
    if (map.has(key)) return;
    map.set(key, value);
    await this.flush(map);
  }

  private async flush(map: Map<string, unknown>): Promise<void> {
    const entries: Record<string, { storedAt: string; value: unknown }> = {};
    const now = new Date().toISOString();
    for (const [key, value] of map) {
      entries[key] = { storedAt: now, value };
    }
    const shape: StoreFileShape = { entries };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(shape, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }
}

/** In-memory store — for tests, or a gate that deliberately opts out of on-disk idempotency. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, unknown>();

  async get(key: string): Promise<unknown | undefined> {
    return this.map.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    if (this.map.has(key)) return;
    this.map.set(key, value);
  }
}
