/**
 * mutex: a minimal in-process async mutex. S6-B leftover 50 ("`ProviderStore` 并发写无互斥（单
 * 管理员前提）") / S7-A: `ProviderStore` (providers.json) and `KeyStore` (keys.json) each hold one
 * instance and wrap every read-modify-write mutation (`upsert`/`recordTest`/`remove`, `set`/
 * `remove`) in `runExclusive` — two concurrent admin requests (or a mutation racing a test-result
 * write) now queue instead of interleaving their read-modify-write cycles and losing one of the
 * two writes. Each store gets its own `Mutex` — a write to `providers.json` never waits on a
 * write to `keys.json`, and vice versa.
 *
 * Deliberately not a library dependency: the whole thing is "chain a promise onto the previous
 * one", well-tested in isolation (mutex.test.ts) and small enough that a dependency would cost
 * more (another package in the audit surface) than it saves.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `fn` once every previously queued `runExclusive` call on this instance has settled
   *  (resolved or rejected) — never concurrently with another `fn` on the same instance. The
   *  calling promise resolves/rejects with `fn`'s own outcome; a rejection never blocks the next
   *  queued caller. */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
