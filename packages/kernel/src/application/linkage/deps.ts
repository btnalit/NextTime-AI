import type { PoolLike } from '../../adapters/db/pool.js';

/**
 * application/linkage/deps: the process-level dependency every consumer in this module needs — a
 * `PoolLike`, exactly like `application/host-bridge/turn-started-consumer.ts`'s and
 * `application/task/reaper.ts`'s own consumers. Deliberately its own (minimal) type rather than
 * reusing `application/task`'s `TaskRuntimeDeps` — this module never needs a Handle-signing key
 * or a supervisor client, only a pool to open its own short `withWorkspace` transactions.
 */
export interface LinkageDeps {
  readonly pool: PoolLike;
}
