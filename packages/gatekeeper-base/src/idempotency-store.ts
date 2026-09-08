import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * `apply`'s idempotency store (design doc §5.1.4 "apply 幂等"): a repeat `apply` call with the
 * same `actionRequestId` (docs/wire-contract-conventions.md §1, 2026-09-08 decision — renamed
 * from `idempotencyKey`, same key, different name) returns the stored result instead of
 * re-executing.
 *
 * Descriptor + reserve/complete (review lane 5, P2-1): entries now carry the `(operation,
 * paramsHash, onBehalfOf)` tuple `apply` first reserved the key for, not just an opaque value.
 * `GatekeeperBase.apply` calls `reserve` *before* invoking the transport (previously: `get` →
 * invoke → `set`, not atomic — two concurrent `apply` calls for the same key both saw `get()`
 * return `undefined` and both invoked the transport). `reserve` is a single synchronous
 * check-and-insert into the already-loaded in-memory map (no `await` between the check and the
 * insert), so two concurrent `reserve` calls for the same key can never both see `'reserved'`
 * within one process:
 *   - `'reserved'` — this caller now owns the key; must call `complete` with the result.
 *   - `'replay'` — the key was already completed for the SAME tuple; return its stored `entry`.
 *   - `'conflict'` — the key exists for a DIFFERENT tuple, OR is still reserved (a genuinely
 *     concurrent duplicate, same tuple or not) — refuse with `IdempotencyConflictError` (409
 *     `idempotency_conflict`) rather than invoke the transport a second time or silently block.
 *
 * Durability/limits (task brief: "document durability limits"): a single JSON file, fully loaded
 * into memory at construction and rewritten in full on every `complete` (atomic via write-to-temp-
 * then-rename, so a crash mid-write never corrupts the existing file). This is adequate for one
 * gate process with a modest number of Operations — it is **not** safe for multiple gate processes
 * sharing the same file (no cross-process locking) and is O(n) per write in the number of stored
 * keys (no compaction/pruning here — an operator wanting bounded growth should periodically prune
 * old entries out-of-band, or a future task should replace this with a real embedded KV store). A
 * `'reserved'` entry lives only in memory, never persisted to disk — if the process crashes between
 * `reserve` and `complete`, the key is simply free again on restart (the same "an incomplete apply
 * leaves no idempotency record" behavior this store already had before this change), rather than
 * permanently stuck as `'pending'`.
 */

export interface IdempotencyDescriptor {
  readonly operation: string;
  readonly paramsHash: string;
  readonly onBehalfOf: string | undefined;
}

export interface IdempotencyEntry extends IdempotencyDescriptor {
  readonly data: unknown;
  readonly observedFacts: unknown;
}

export type IdempotencyReserveResult =
  | { readonly status: 'reserved' }
  | { readonly status: 'replay'; readonly entry: IdempotencyEntry }
  | { readonly status: 'conflict' };

export interface IdempotencyStore {
  /** Atomically checks `key` and, if free, claims it for `descriptor` — must be called (and its
   *  result acted on) before the transport is invoked. */
  reserve(key: string, descriptor: IdempotencyDescriptor): Promise<IdempotencyReserveResult>;
  /** Completes a `'reserved'` key with the invoke result. */
  complete(key: string, result: { data: unknown; observedFacts: unknown }): Promise<void>;
}

/** Stable (key-sorted) JSON stringify so `{a:1,b:2}` and `{b:2,a:1}` hash identically —
 *  `paramsHash` must not depend on a caller's/serializer's key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** `paramsHash` for an `IdempotencyDescriptor` — `params ?? {}` matches `assertParamsValid`'s own
 *  normalization, so `undefined` and `{}` hash identically (the same effective call). */
export function hashIdempotencyParams(params: unknown): string {
  return createHash('sha256')
    .update(stableStringify(params ?? {}))
    .digest('hex');
}

function sameDescriptor(a: IdempotencyDescriptor, b: IdempotencyDescriptor): boolean {
  return (
    a.operation === b.operation && a.paramsHash === b.paramsHash && a.onBehalfOf === b.onBehalfOf
  );
}

type Pending = { readonly status: 'pending' } & IdempotencyDescriptor;
type Done = { readonly status: 'done' } & IdempotencyEntry;
type StoreEntryState = Pending | Done;

function reserveOrConflict(
  map: Map<string, StoreEntryState>,
  key: string,
  descriptor: IdempotencyDescriptor,
): IdempotencyReserveResult {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, { status: 'pending', ...descriptor });
    return { status: 'reserved' };
  }
  if (existing.status === 'pending') {
    // Still in flight — refuse rather than invoke a second time or block the caller waiting.
    return { status: 'conflict' };
  }
  if (!sameDescriptor(existing, descriptor)) {
    return { status: 'conflict' };
  }
  const { status: _status, ...entry } = existing;
  return { status: 'replay', entry };
}

function completeEntry(
  map: Map<string, StoreEntryState>,
  key: string,
  result: { data: unknown; observedFacts: unknown },
): Done {
  const reserved = map.get(key);
  const descriptor: IdempotencyDescriptor =
    reserved !== undefined
      ? {
          operation: reserved.operation,
          paramsHash: reserved.paramsHash,
          onBehalfOf: reserved.onBehalfOf,
        }
      : // Defensive only — `complete` is always called with the same key a prior `reserve` just
        // returned `'reserved'` for (`GatekeeperBase.apply`'s own control flow).
        { operation: '', paramsHash: '', onBehalfOf: undefined };
  const done: Done = {
    status: 'done',
    ...descriptor,
    data: result.data,
    observedFacts: result.observedFacts,
  };
  map.set(key, done);
  return done;
}

interface StoreFileShape {
  readonly entries: Record<string, { readonly storedAt: string; readonly entry: Done }>;
}

export class JsonFileIdempotencyStore implements IdempotencyStore {
  private readonly filePath: string;
  private loaded: Map<string, StoreEntryState> | undefined;
  private loadPromise: Promise<Map<string, StoreEntryState>> | undefined;

  constructor(dataDir: string, fileName = 'idempotency-store.json') {
    this.filePath = join(dataDir, fileName);
  }

  private async load(): Promise<Map<string, StoreEntryState>> {
    if (this.loaded) return this.loaded;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await readFile(this.filePath, 'utf8');
          const parsed = JSON.parse(raw) as StoreFileShape;
          const map = new Map<string, StoreEntryState>();
          for (const [key, record] of Object.entries(parsed.entries ?? {})) {
            // Only 'done' entries are ever persisted (see `complete`) — a file left over from a
            // pre-reserve/complete version of this store (plain `{value}` records, no `status`)
            // has no matching shape here and is simply skipped: those keys are treated as never
            // having been applied, which is no worse than losing them to any other format change.
            const entry = record?.entry;
            if (entry && entry.status === 'done') map.set(key, entry);
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

  async reserve(key: string, descriptor: IdempotencyDescriptor): Promise<IdempotencyReserveResult> {
    const map = await this.load();
    // No `await` between `load()` resolving and this call — see module doc comment.
    return reserveOrConflict(map, key, descriptor);
  }

  async complete(key: string, result: { data: unknown; observedFacts: unknown }): Promise<void> {
    const map = await this.load();
    completeEntry(map, key, result);
    await this.flush(map);
  }

  private async flush(map: Map<string, StoreEntryState>): Promise<void> {
    const entries: StoreFileShape['entries'] = {};
    const now = new Date().toISOString();
    for (const [key, value] of map) {
      if (value.status !== 'done') continue;
      entries[key] = { storedAt: now, entry: value };
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
  private readonly map = new Map<string, StoreEntryState>();

  async reserve(key: string, descriptor: IdempotencyDescriptor): Promise<IdempotencyReserveResult> {
    return reserveOrConflict(this.map, key, descriptor);
  }

  async complete(key: string, result: { data: unknown; observedFacts: unknown }): Promise<void> {
    completeEntry(this.map, key, result);
  }
}
