import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import { writeAudit } from '../../substrate/audit/index.js';

/**
 * application/platform/compact-observations: retention for the `observations` table (STATUS
 * leftover 103; maintainer decision 2026-10-04: 30-day age gate, an Observation that carries a
 * payload is never compacted). The mechanism behind `cli/compact-observations.ts`, which
 * `scripts/apply-release.sh` runs after the release's `BACKUP_NOW` — that dump is the recovery
 * point for every row this deletes.
 *
 * **What may go.** An Observation is provenance, so it is deleted only when no reader can tell it
 * is gone. A row is deleted only if ALL of these hold:
 *   (a) no `links.observation_id` and no `links.last_observation_id` points at it, whatever the
 *       Fact's lifecycle state — `explain(factId)`'s narrowing and `lastObservation`, and the
 *       observation window's "this Fact belongs to the Source" test, read exactly these rows;
 *   (b) it is older than the newest Observation of its Source — `listSourceFreshness` and
 *       `checkCollectorSilent` read `max(created_at)` per Source (rows tied at the newest instant
 *       all stay);
 *   (c) it is not the last row left for its `(workspace_id, activity_id, source_id)` —
 *       `resolveFactOrigin` (distinct Sources per Activity), `link_visible_to_caller` (a private
 *       Source observed on a Fact's Activity hides the Fact), the window's Activity-level fallback
 *       for Facts that name no Observation, and `explain(activityId)` / the PROV export (≥ 1
 *       Observation per Source per Activity) read only which pairs exist;
 *   (d) `content = '{}'` — an ingest marker. A gate observation or a task result carries a payload
 *       and is never deleted;
 *   (e) `created_at` is older than the age gate.
 *
 * (c) is decided per group by a rank, so it never depends on which rows happen to be examined
 * together: a row is *protected* when (a), (d) or (e) keeps it, and the group's survivor is its
 * highest-ranked row by (protected, created_at, id). An unprotected row goes when some other row
 * of its group ranks higher — a protected one, or a newer one. The top row is never deleted, so a
 * group always keeps at least one row, and exactly one when none of its rows is protected.
 *
 * **How.** Per Source, in windows of `batchSize` rows walked in `(created_at, id)` order over the
 * `observations (workspace_id, source_id, created_at)` index (core 0039). Each window is one short
 * transaction: classify the window's rows, then delete the deletable ones with every condition
 * re-checked in the DELETE itself. The group test probes `observations (workspace_id,
 * activity_id)` (0039), the reference tests the two partial indexes on `links` (0018, 0039).
 * Statement snapshots keep each DELETE consistent with itself (it sees the group's top row it is
 * keeping), and a transaction-level advisory lock serializes the windows of two concurrent runs, so
 * no two DELETEs ever judge one group from different snapshots. Nothing holds a lock beyond one
 * window; rows are never updated, only deleted.
 *
 * **Privilege.** `nexttime_app` has only SELECT and INSERT on `observations` (core 0035, R-29) and
 * keeps exactly that: the deletes run on the login role (`skipRoleSwitch`), like the workspace
 * purge. The foreign keys into `observations` stay enforced (no `session_replication_role`), and a
 * run refuses up front if the catalog shows any foreign key into `observations` other than the two
 * on `links` this module knows how to respect.
 *
 * **Audit.** An executing run writes one platform audit row, `cli.observations_compacted`, with the
 * parameters and the per-workspace counts — also when it fails part-way, so the windows that did
 * commit are on record (`completed: false` plus the error). Unattributed when no operator
 * resolves (migration core 0040).
 */

/** Maintainer decision 2026-10-04 (leftover 103). */
export const OBSERVATION_COMPACTION_AGE_DAYS = 30;
/** Rows examined (and at most deleted) per transaction. */
export const OBSERVATION_COMPACTION_BATCH_SIZE = 10_000;
export const OBSERVATION_COMPACTION_AUDIT_ACTION = 'cli.observations_compacted';

/** Serializes the windows of concurrent runs (transaction-level, one window at a time). A fixed
 *  bigint distinct from the migration keys (runner 7241000001, core 7241000101, governance
 *  7241000201 — see migrations/core/0001_identity.sql). */
const COMPACTION_LOCK_KEY = 7241010301;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Full-precision UTC text for a timestamptz: a JS `Date` keeps only milliseconds, and the
 *  `(created_at, id)` keyset must resume exactly where the last window ended. */
const UTC_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export class ObservationCompactionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationCompactionRefusedError';
  }
}

export interface ObservationCompactionCounts {
  /** Observations older than the age gate — each one examined once. */
  readonly examined: number;
  /** Kept by (d): the row carries a payload (gate observation, task result). */
  readonly keptPayload: number;
  /** Kept by (a): a Fact names it as its origin or its last confirmation. */
  readonly keptReferenced: number;
  /** Kept by (b): the newest Observation of its Source. */
  readonly keptSourceNewest: number;
  /** Kept by (c): the row its `(activity, source)` pair keeps. */
  readonly keptLastOfActivitySource: number;
  /** Deleted (`confirm: true`) or deletable (dry run). */
  readonly deleted: number;
}

export interface WorkspaceObservationCompaction extends ObservationCompactionCounts {
  readonly workspaceId: string;
  readonly name: string | null;
  /** Every Observation of the workspace before the run, of any age. */
  readonly rowsBefore: number;
}

export interface CompactObservationsInput {
  /** `false`: dry run — classify and count, delete nothing, write no audit row. */
  readonly confirm: boolean;
  readonly olderThanDays?: number;
  readonly batchSize?: number;
  /** Only this workspace (default: every workspace). */
  readonly workspaceId?: string;
  /** The operator, for the audit row; omitted when none resolves (unattributed row). */
  readonly actorUserId?: string;
}

export interface CompactObservationsResult {
  readonly executed: boolean;
  readonly olderThanDays: number;
  /** The age gate on the database clock, UTC, microsecond precision. */
  readonly cutoff: string;
  readonly batchSize: number;
  /** Windows processed (one transaction each). */
  readonly batches: number;
  readonly workspaces: readonly WorkspaceObservationCompaction[];
  readonly totals: ObservationCompactionCounts & { readonly rowsBefore: number };
  /** The `cli.observations_compacted` row of an executing run; `null` for a dry run. */
  readonly auditRecordId: string | null;
}

/** Thrown when an executing run fails after some windows committed: the audit row recording them
 *  was written, and `partial` says what was deleted before the failure. */
export class ObservationCompactionFailedError extends Error {
  readonly partial: CompactObservationsResult;
  constructor(cause: unknown, partial: CompactObservationsResult) {
    super(
      `compact-observations: failed after ${partial.totals.deleted} deletion(s) in ${partial.batches} window(s): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ObservationCompactionFailedError';
    this.partial = partial;
  }
}

// -------------------------------------------------------------------------------------------
// SQL — one set of predicates, shared by the classification and the DELETE
// -------------------------------------------------------------------------------------------

/** (a) for the row aliased `alias`. */
function referencedBy(alias: string): string {
  return `(exists (select 1 from links l
                    where l.workspace_id = ${alias}.workspace_id and l.observation_id = ${alias}.id)
           or exists (select 1 from links l
                       where l.workspace_id = ${alias}.workspace_id
                         and l.last_observation_id = ${alias}.id))`;
}

/** (b): `o` is not older than the newest Observation of its Source. */
const SOURCE_NEWEST = `o.created_at >= (select max(n.created_at) from observations n
                                         where n.workspace_id = o.workspace_id
                                           and n.source_id = o.source_id)`;

/** (c)'s rank: another row of `o`'s `(activity, source)` pair ranks higher than `o` — it is
 *  protected ((e), (d) or (a), cheapest test first) or newer. Meaningful for an unprotected `o`;
 *  `$3` is the age gate. */
const HIGHER_RANKED_ROW_EXISTS = `exists (
  select 1 from observations k
   where k.workspace_id = o.workspace_id
     and k.activity_id = o.activity_id
     and k.source_id = o.source_id
     and k.id <> o.id
     and ((k.created_at, k.id) > (o.created_at, o.id)
          or k.created_at >= $3::timestamptz
          or k.content <> '{}'::jsonb
          or ${referencedBy('k')}))`;

/** The next window of a Source's Observations older than the gate, after the keyset cursor
 *  `($4, $5)`. The redundant `created_at >= $4` gives the planner an index range on 0039's
 *  `observations_source_idx`; the row comparison then skips the rows of the cursor's own instant
 *  already seen. */
const NEXT_WINDOW_SQL = `
  select id, to_char(created_at at time zone 'UTC', ${UTC_TEXT}) as created_at_key
    from observations
   where workspace_id = $1 and source_id = $2
     and created_at < $3::timestamptz
     and created_at >= $4::timestamptz
     and (created_at, id) > ($4::timestamptz, $5::uuid)
   order by created_at, id
   limit $6`;

/** Classifies a window's rows: `$1` workspace, `$2` the window's ids, `$3` the age gate. */
const CLASSIFY_SQL = `
  select o.id,
         (o.content <> '{}'::jsonb) as has_payload,
         ${referencedBy('o')} as referenced,
         (${SOURCE_NEWEST}) as source_newest,
         (not ${HIGHER_RANKED_ROW_EXISTS}) as last_of_activity_source
    from observations o
   where o.workspace_id = $1 and o.id = any($2::uuid[])`;

/** Deletes the given rows that are still deletable — every condition re-checked here, so a row
 *  classified a moment earlier is never deleted on stale grounds. */
const DELETE_SQL = `
  delete from observations o
   where o.workspace_id = $1 and o.id = any($2::uuid[])
     and o.created_at < $3::timestamptz
     and o.content = '{}'::jsonb
     and not ${referencedBy('o')}
     and not (${SOURCE_NEWEST})
     and ${HIGHER_RANKED_ROW_EXISTS}
  returning o.id`;

// -------------------------------------------------------------------------------------------
// The run
// -------------------------------------------------------------------------------------------

interface MutableCounts {
  examined: number;
  keptPayload: number;
  keptReferenced: number;
  keptSourceNewest: number;
  keptLastOfActivitySource: number;
  deleted: number;
}

function emptyCounts(): MutableCounts {
  return {
    examined: 0,
    keptPayload: 0,
    keptReferenced: 0,
    keptSourceNewest: 0,
    keptLastOfActivitySource: 0,
    deleted: 0,
  };
}

interface ClassifiedRow {
  id: string;
  has_payload: boolean;
  referenced: boolean;
  source_newest: boolean;
  last_of_activity_source: boolean;
}

/** One transaction on the login role, RLS-bypassing like the purge; `workspaceId` only fills the
 *  session variables `withWorkspace` requires. */
function onLoginRole<T>(
  pool: PoolLike,
  workspaceId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withWorkspace(pool, { workspaceId, principalId: randomUUID() }, fn, {
    skipRoleSwitch: true,
  });
}

/** The two foreign keys into `observations` condition (a) covers — `links.observation_id` (core
 *  0018) and `links.last_observation_id` (core 0026). Anything else in the catalog means a
 *  reference this module does not know how to respect: refuse rather than let the FK check fail
 *  a window half-way. */
async function assertKnownObservationReferences(client: PoolClient): Promise<void> {
  const result = await client.query<{ child_table: string; columns: string }>(
    `select child.relname as child_table,
            (select string_agg(a.attname::text, ',' order by a.attname)
               from pg_attribute a
              where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as columns
       from pg_constraint c
       join pg_class child on child.oid = c.conrelid
      where c.contype = 'f' and c.confrelid = 'public.observations'::regclass`,
  );
  const known = new Set([
    'links:observation_id,workspace_id',
    'links:last_observation_id,workspace_id',
  ]);
  const unknown = result.rows
    .map((row) => `${row.child_table}:${row.columns}`)
    .filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new ObservationCompactionRefusedError(
      `compact-observations: refusing to run — foreign keys into observations this compaction does not check: ${unknown.join(', ')}. Extend condition (a) first`,
    );
  }
}

export async function compactObservations(
  pool: PoolLike,
  input: CompactObservationsInput,
): Promise<CompactObservationsResult> {
  const olderThanDays = input.olderThanDays ?? OBSERVATION_COMPACTION_AGE_DAYS;
  const batchSize = input.batchSize ?? OBSERVATION_COMPACTION_BATCH_SIZE;
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new ObservationCompactionRefusedError(
      `compact-observations: olderThanDays must be a positive integer, got ${olderThanDays}`,
    );
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new ObservationCompactionRefusedError(
      `compact-observations: batchSize must be a positive integer, got ${batchSize}`,
    );
  }
  const scopeId = input.workspaceId ?? randomUUID();

  const setup = await onLoginRole(pool, scopeId, async (client) => {
    await assertKnownObservationReferences(client);
    const cutoffRow = await client.query<{ cutoff: string }>(
      `select to_char((now() - make_interval(days => $1)) at time zone 'UTC', ${UTC_TEXT}) as cutoff`,
      [olderThanDays],
    );
    const workspaces = await client.query<{ id: string; name: string | null }>(
      'select id, name from workspaces where ($1::uuid is null or id = $1) order by id',
      [input.workspaceId ?? null],
    );
    const rowCounts = await client.query<{ workspace_id: string; n: string }>(
      `select workspace_id, count(*)::text as n from observations
        where ($1::uuid is null or workspace_id = $1) group by workspace_id`,
      [input.workspaceId ?? null],
    );
    const cutoff = cutoffRow.rows[0]?.cutoff as string;
    // Only Sources with at least one row older than the gate (one 0039 index probe each) — every
    // WorkerRun registers its own Source, so most have nothing to examine.
    const sources = await client.query<{ workspace_id: string; id: string }>(
      `select s.workspace_id, s.id from sources s
        where ($1::uuid is null or s.workspace_id = $1)
          and exists (select 1 from observations o
                       where o.workspace_id = s.workspace_id and o.source_id = s.id
                         and o.created_at < $2::timestamptz)
        order by s.workspace_id, s.id`,
      [input.workspaceId ?? null, cutoff],
    );
    return {
      cutoff,
      workspaces: workspaces.rows,
      rowCounts: new Map(rowCounts.rows.map((row) => [row.workspace_id, Number(row.n)])),
      sources: sources.rows,
    };
  });
  if (input.workspaceId !== undefined && setup.workspaces.length === 0) {
    throw new ObservationCompactionRefusedError(
      `compact-observations: workspace not found: ${input.workspaceId}`,
    );
  }

  const countsByWorkspace = new Map<string, MutableCounts>();
  const countsFor = (workspaceId: string): MutableCounts => {
    let counts = countsByWorkspace.get(workspaceId);
    if (!counts) {
      counts = emptyCounts();
      countsByWorkspace.set(workspaceId, counts);
    }
    return counts;
  };
  let batches = 0;

  const buildResult = (auditRecordId: string | null): CompactObservationsResult => {
    const names = new Map(setup.workspaces.map((ws) => [ws.id, ws.name]));
    const ids = new Set([...setup.rowCounts.keys(), ...countsByWorkspace.keys()]);
    const workspaces = [...ids].sort().map((workspaceId) => ({
      workspaceId,
      name: names.get(workspaceId) ?? null,
      rowsBefore: setup.rowCounts.get(workspaceId) ?? 0,
      ...(countsByWorkspace.get(workspaceId) ?? emptyCounts()),
    }));
    const totals = { rowsBefore: 0, ...emptyCounts() };
    for (const ws of workspaces) {
      totals.rowsBefore += ws.rowsBefore;
      totals.examined += ws.examined;
      totals.keptPayload += ws.keptPayload;
      totals.keptReferenced += ws.keptReferenced;
      totals.keptSourceNewest += ws.keptSourceNewest;
      totals.keptLastOfActivitySource += ws.keptLastOfActivitySource;
      totals.deleted += ws.deleted;
    }
    return {
      executed: input.confirm,
      olderThanDays,
      cutoff: setup.cutoff,
      batchSize,
      batches,
      workspaces,
      totals,
      auditRecordId,
    };
  };

  let failure: unknown;
  try {
    for (const source of setup.sources) {
      let cursor = { createdAt: '-infinity', id: NIL_UUID };
      for (;;) {
        const outcome = await onLoginRole(pool, source.workspace_id, async (client) => {
          if (input.confirm) {
            await client.query('select pg_advisory_xact_lock($1)', [COMPACTION_LOCK_KEY]);
          }
          const window = await client.query<{ id: string; created_at_key: string }>(
            NEXT_WINDOW_SQL,
            [source.workspace_id, source.id, setup.cutoff, cursor.createdAt, cursor.id, batchSize],
          );
          const last = window.rows.at(-1);
          if (!last) return null;

          const classified = await client.query<ClassifiedRow>(CLASSIFY_SQL, [
            source.workspace_id,
            window.rows.map((row) => row.id),
            setup.cutoff,
          ]);
          const counts = emptyCounts();
          const deletable: string[] = [];
          for (const row of classified.rows) {
            counts.examined += 1;
            if (row.has_payload) counts.keptPayload += 1;
            else if (row.referenced) counts.keptReferenced += 1;
            else if (row.source_newest) counts.keptSourceNewest += 1;
            else if (row.last_of_activity_source) counts.keptLastOfActivitySource += 1;
            else deletable.push(row.id);
          }
          if (!input.confirm) {
            counts.deleted = deletable.length;
          } else if (deletable.length > 0) {
            const deleted = await client.query(DELETE_SQL, [
              source.workspace_id,
              deletable,
              setup.cutoff,
            ]);
            counts.deleted = deleted.rowCount ?? 0;
            // A row classified deletable that the DELETE's re-check kept (a writer referenced it
            // in between) is still a kept row: count it under (a), the only condition that can
            // change for an old, payload-free row.
            counts.keptReferenced += deletable.length - counts.deleted;
          }
          return {
            counts,
            cursor: { createdAt: last.created_at_key, id: last.id },
            done: window.rows.length < batchSize,
          };
        });
        if (outcome === null) break;
        // Merged only once the window's transaction committed.
        batches += 1;
        cursor = outcome.cursor;
        const total = countsFor(source.workspace_id);
        total.examined += outcome.counts.examined;
        total.keptPayload += outcome.counts.keptPayload;
        total.keptReferenced += outcome.counts.keptReferenced;
        total.keptSourceNewest += outcome.counts.keptSourceNewest;
        total.keptLastOfActivitySource += outcome.counts.keptLastOfActivitySource;
        total.deleted += outcome.counts.deleted;
        if (outcome.done) break;
      }
    }
  } catch (err) {
    failure = err;
  }

  if (!input.confirm) {
    if (failure !== undefined) throw failure;
    return buildResult(null);
  }

  const partial = buildResult(null);
  const audit = await onLoginRole(pool, scopeId, (client) =>
    writeAudit(client, {
      workspaceId: null,
      actorPrincipalId: null,
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      action: OBSERVATION_COMPACTION_AUDIT_ACTION,
      resourceType: 'observations',
      payload: {
        channel: 'cli',
        attributedActor: input.actorUserId !== undefined,
        olderThanDays,
        cutoff: partial.cutoff,
        batchSize,
        workspaceFilter: input.workspaceId ?? null,
        completed: failure === undefined,
        ...(failure !== undefined
          ? { error: failure instanceof Error ? failure.message : String(failure) }
          : {}),
        batches: partial.batches,
        totals: partial.totals,
        workspaces: partial.workspaces.filter((ws) => ws.examined > 0),
      },
    }),
  );
  const result = buildResult(audit.id);
  if (failure !== undefined) throw new ObservationCompactionFailedError(failure, result);
  return result;
}
