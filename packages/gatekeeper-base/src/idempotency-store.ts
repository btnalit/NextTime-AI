import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { removeStaleTempFiles, writeFileAtomic } from './atomic-file.js';

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
 *   - `'reserved'` — this caller now owns the key; must end it with `complete`, `fail` or
 *     `release`.
 *   - `'replay'` — the key was already completed for the SAME tuple; return its stored `entry`.
 *   - `'failed'` — the key's call already ended in a failure for the SAME tuple (R-51); answer
 *     with that same failure, never run it again.
 *   - `'unknown'` — the key was reserved by an earlier gate process that stopped before recording
 *     any result (R-51, D-11); nobody knows whether the effect happened, so it is never re-run.
 *   - `'conflict'` — the key exists for a DIFFERENT tuple, OR is still reserved (a genuinely
 *     concurrent duplicate, same tuple or not) — refuse with `IdempotencyConflictError` (409
 *     `idempotency_conflict`) rather than invoke the transport a second time or silently block.
 *
 * Durable reservations (R-51, maintainer decision D-11): a `'reserved'` key is written to disk
 * *before* `reserve` returns, so the transport is never invoked for a key the file does not know
 * about. A gate that crashes mid-call restarts with that key still pending; it is loaded as
 * orphaned and answers `'unknown'` from then on (the kernel marks the ActionRequest `failed:
 * outcome_unknown` for a person to reconcile). Before this, a crash freed the key and the kernel's
 * replay re-executed the effect. There is no automatic re-run even for an Operation that looks
 * idempotent: the Operation schema has no platform-governed idempotency declaration (only MCP's
 * untrusted `idempotent_hint`, honoured for auto-approval only together with the admin-set
 * `vetted` flag, which the gate cannot see).
 *
 * Durability/limits (task brief: "document durability limits"): a single JSON file, fully loaded
 * into memory at construction and rewritten in full on every reserve / complete / fail / release
 * (atomic via write-to-temp-then-rename, so a crash mid-write never corrupts the existing file;
 * writes are serialized, so an older snapshot can never land after a newer one). This is adequate
 * for one gate process with a modest number of Operations — it is **not** safe for multiple gate
 * processes sharing the same file (no cross-process locking) and is O(n) per write in the number
 * of stored keys (no compaction/pruning here — an operator wanting bounded growth should
 * periodically prune old entries out-of-band, or a future task should replace this with a real
 * embedded KV store).
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

/** How a reserved key's transport call ended when it did not succeed (R-51). */
export interface StoredApplyFailure {
  readonly message: string;
  /** `true` when the transport stopped without knowing whether the effect happened (an exec
   *  timeout killed the command) — replays answer "outcome unknown", not "failed". */
  readonly outcomeUnknown: boolean;
}

export type IdempotencyReserveResult =
  | { readonly status: 'reserved' }
  | { readonly status: 'replay'; readonly entry: IdempotencyEntry }
  | { readonly status: 'failed'; readonly failure: StoredApplyFailure }
  | { readonly status: 'unknown' }
  | { readonly status: 'conflict' };

export interface IdempotencyStore {
  /** Atomically checks `key` and, if free, claims it for `descriptor` — must be called (and its
   *  result acted on) before the transport is invoked. */
  reserve(key: string, descriptor: IdempotencyDescriptor): Promise<IdempotencyReserveResult>;
  /** Completes a `'reserved'` key with the invoke result. */
  complete(key: string, result: { data: unknown; observedFacts: unknown }): Promise<void>;
  /** R-51: completes a `'reserved'` key with the failure its transport call ended in, so a retry
   *  gets that same answer — never 409 forever, never a second invocation. */
  fail(key: string, failure: StoredApplyFailure): Promise<void>;
  /** Frees a `'reserved'` key whose call ran nothing (R-04 `OperationRefusedError`; R-51 a
   *  credential that could not be resolved), so a retry starts clean rather than 409. A key in any
   *  other state is never released. */
  release(key: string): Promise<void>;
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

/** Reserved by this process, transport call in flight. */
type Pending = { readonly status: 'pending' } & IdempotencyDescriptor;
/** Reserved by an earlier process that stopped before recording a result (loaded from disk). */
type Orphaned = { readonly status: 'orphaned' } & IdempotencyDescriptor;
type Done = { readonly status: 'done' } & IdempotencyEntry;
type Failed = { readonly status: 'failed' } & IdempotencyDescriptor & StoredApplyFailure;
type StoreEntryState = Pending | Orphaned | Done | Failed;

function descriptorOf(entry: IdempotencyDescriptor): IdempotencyDescriptor {
  return {
    operation: entry.operation,
    paramsHash: entry.paramsHash,
    onBehalfOf: entry.onBehalfOf,
  };
}

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
  if (existing.status === 'orphaned') return { status: 'unknown' };
  if (existing.status === 'failed') {
    return {
      status: 'failed',
      failure: { message: existing.message, outcomeUnknown: existing.outcomeUnknown },
    };
  }
  const { status: _status, ...entry } = existing;
  return { status: 'replay', entry };
}

/** The descriptor `reserve` claimed `key` for. Defensive fallback only — `complete`/`fail` are
 *  always called with the same key a prior `reserve` just returned `'reserved'` for
 *  (`GatekeeperBase.apply`'s own control flow). */
function reservedDescriptor(map: Map<string, StoreEntryState>, key: string): IdempotencyDescriptor {
  const reserved = map.get(key);
  return reserved !== undefined
    ? descriptorOf(reserved)
    : { operation: '', paramsHash: '', onBehalfOf: undefined };
}

function completeEntry(
  map: Map<string, StoreEntryState>,
  key: string,
  result: { data: unknown; observedFacts: unknown },
): void {
  map.set(key, {
    status: 'done',
    ...reservedDescriptor(map, key),
    data: result.data,
    observedFacts: result.observedFacts,
  });
}

function failEntry(
  map: Map<string, StoreEntryState>,
  key: string,
  failure: StoredApplyFailure,
): void {
  map.set(key, {
    status: 'failed',
    ...reservedDescriptor(map, key),
    message: failure.message,
    outcomeUnknown: failure.outcomeUnknown,
  });
}

/** `true` if a pending key was actually freed. */
function releaseEntry(map: Map<string, StoreEntryState>, key: string): boolean {
  if (map.get(key)?.status !== 'pending') return false;
  map.delete(key);
  return true;
}

/** One persisted entry, as loaded back from disk: a reservation that was still pending when the
 *  file was last written belongs to a process that is gone, so it becomes orphaned. */
function loadedEntry(entry: unknown): StoreEntryState | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const record = entry as { readonly status?: unknown };
  if (record.status === 'done' || record.status === 'failed') {
    return record as Done | Failed;
  }
  if (record.status === 'pending' || record.status === 'orphaned') {
    return { status: 'orphaned', ...descriptorOf(record as unknown as IdempotencyDescriptor) };
  }
  // A file left over from a pre-reserve/complete version of this store (plain `{value}` records,
  // no `status`) has no matching shape here and is simply skipped: those keys are treated as never
  // having been applied, which is no worse than losing them to any other format change.
  return undefined;
}

interface StoreFileShape {
  readonly entries: Record<string, { readonly storedAt: string; readonly entry: StoreEntryState }>;
}

export class JsonFileIdempotencyStore implements IdempotencyStore {
  private readonly filePath: string;
  private loaded: Map<string, StoreEntryState> | undefined;
  private loadPromise: Promise<Map<string, StoreEntryState>> | undefined;
  /** Every write waits for the previous one and snapshots the map when it runs (R-51 — two
   *  overlapping full-file rewrites could otherwise land out of order and resurrect a stale
   *  pending entry, or race the same `rename` target). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, fileName = 'idempotency-store.json') {
    this.filePath = join(dataDir, fileName);
  }

  private async load(): Promise<Map<string, StoreEntryState>> {
    if (this.loaded) return this.loaded;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        // Runs once, before this store's first write (every write waits for the load), so any
        // temp file found is an interrupted earlier process's (#530 review; atomic-file.ts).
        await removeStaleTempFiles(this.filePath);
        try {
          const raw = await readFile(this.filePath, 'utf8');
          const parsed = JSON.parse(raw) as StoreFileShape;
          const map = new Map<string, StoreEntryState>();
          for (const [key, record] of Object.entries(parsed.entries ?? {})) {
            const entry = loadedEntry(record?.entry);
            if (entry) map.set(key, entry);
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
    const result = reserveOrConflict(map, key, descriptor);
    if (result.status === 'reserved') {
      try {
        await this.flush(map);
      } catch (err) {
        // Not on disk, so not reserved: the caller must not invoke the transport.
        map.delete(key);
        throw err;
      }
    }
    return result;
  }

  async complete(key: string, result: { data: unknown; observedFacts: unknown }): Promise<void> {
    const map = await this.load();
    completeEntry(map, key, result);
    await this.flush(map);
  }

  async fail(key: string, failure: StoredApplyFailure): Promise<void> {
    const map = await this.load();
    failEntry(map, key, failure);
    await this.flush(map);
  }

  async release(key: string): Promise<void> {
    const map = await this.load();
    if (releaseEntry(map, key)) await this.flush(map);
  }

  private flush(map: Map<string, StoreEntryState>): Promise<void> {
    const write = this.writeChain.then(() => this.writeSnapshot(map));
    // A failed write is reported to its own caller; it must not wedge every later write.
    this.writeChain = write.catch(() => {});
    return write;
  }

  private async writeSnapshot(map: Map<string, StoreEntryState>): Promise<void> {
    const entries: StoreFileShape['entries'] = {};
    const now = new Date().toISOString();
    for (const [key, value] of map) {
      entries[key] = { storedAt: now, entry: value };
    }
    const shape: StoreFileShape = { entries };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFileAtomic(this.filePath, JSON.stringify(shape, null, 2));
  }
}

/** In-memory store — for tests, or a gate that deliberately opts out of on-disk idempotency
 *  (and so of durable reservations: a restart forgets every key). */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, StoreEntryState>();

  async reserve(key: string, descriptor: IdempotencyDescriptor): Promise<IdempotencyReserveResult> {
    return reserveOrConflict(this.map, key, descriptor);
  }

  async complete(key: string, result: { data: unknown; observedFacts: unknown }): Promise<void> {
    completeEntry(this.map, key, result);
  }

  async fail(key: string, failure: StoredApplyFailure): Promise<void> {
    failEntry(this.map, key, failure);
  }

  async release(key: string): Promise<void> {
    releaseEntry(this.map, key);
  }
}
