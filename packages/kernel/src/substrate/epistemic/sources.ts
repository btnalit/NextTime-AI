import type { PoolClient } from 'pg';

/**
 * substrate/epistemic/sources: writes to the `sources`/`observations` tables (migrations/core/
 * 0002_substrate.sql), first used by S2.9's session-JSONL-as-Source path (design doc §7.3 "会话
 * JSONL 回流为私有 Source"). `sources.uri` is a pointer, not inline content — the kernel never
 * reads a Worker's session file itself (no kernel process needs filesystem access into a Worker's
 * workspace mount). Registering a Source alone leaves it unreachable from `explain` (which walks
 * an Activity's `observations`, not `sources` directly) — `recordSourceObservation` below writes
 * the one-row link a caller needs for `explain(activityId).observations[].source` to surface it,
 * same as `attachEvidence` in this package leaves Activity-level attachment to its own caller.
 */

export interface RegisterPrivateSourceInput {
  readonly kind: string;
  readonly ownerPrincipalId: string;
  /** S5.3 (`sources.name`, migration core 0028): the Source's identity within its `kind` —
   *  unique per workspace when set (`sources_kind_name_uidx`). A caller that has no stable
   *  identity for its Source (a WorkerRun, a session transcript) leaves it unset. */
  readonly name?: string;
  readonly uri?: string;
  readonly metadata?: Record<string, unknown>;
}

/** `registerSource` (W5.5): same as `RegisterPrivateSourceInput` plus an explicit visibility. */
export interface RegisterSourceInput extends RegisterPrivateSourceInput {
  readonly visibility: 'private' | 'workspace';
}

export interface SourceRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly kind: string;
  /** See `RegisterPrivateSourceInput.name`; `null` for a Source registered without one (every
   *  pre-0028 row whose `metadata.name` was not unique in its kind is left null too). */
  readonly name: string | null;
  readonly ownerPrincipalId: string;
  readonly visibility: 'private' | 'workspace';
  readonly uri: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

interface SourceDbRow {
  workspace_id: string;
  id: string;
  kind: string;
  name: string | null;
  owner_principal_id: string;
  visibility: 'private' | 'workspace';
  uri: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const SOURCE_COLUMNS =
  'workspace_id, id, kind, name, owner_principal_id, visibility, uri, metadata, created_at';

function mapSourceRow(row: SourceDbRow): SourceRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    kind: row.kind,
    name: row.name,
    ownerPrincipalId: row.owner_principal_id,
    visibility: row.visibility,
    uri: row.uri,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

/** S5.3: the Source of this (kind, name) the caller can see, or `undefined`. RLS-scoped like
 *  every read here — a *private* Source of the same name owned by someone else is invisible, and
 *  `register_source` then learns of it only through the unique index on insert. */
export async function findSourceByName(
  client: PoolClient,
  workspaceId: string,
  input: { readonly kind: string; readonly name: string },
): Promise<SourceRow | undefined> {
  const result = await client.query<SourceDbRow>(
    `select ${SOURCE_COLUMNS} from sources
      where workspace_id = $1 and kind = $2 and name = $3`,
    [workspaceId, input.kind, input.name],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapSourceRow(row);
}

/** Registers a `visibility='private'` Source owned by `input.ownerPrincipalId` (§5.6:会话派生内容
 *  默认 private given the on_behalf_of user — always private here, never `workspace`; promoting
 *  visibility is a separate, human-channel-governed transition this function does not perform). */
export async function registerPrivateSource(
  client: PoolClient,
  workspaceId: string,
  input: RegisterPrivateSourceInput,
): Promise<SourceRow> {
  return registerSource(client, workspaceId, { ...input, visibility: 'private' });
}

/** Registers a Source with an explicit visibility (W5.5, STATUS leftover 16): `postWorkerResult`
 *  records every WorkerRun as a workspace-visible `worker_run` Source so the run's Facts are
 *  workspace knowledge (`links_visibility` derives Fact visibility from the Sources observed on
 *  the Activity, migrations/core/0013); the transcript, when present, goes through
 *  `registerPrivateSource` above on its own Activity. Every other caller keeps using
 *  `registerPrivateSource`. */
export async function registerSource(
  client: PoolClient,
  workspaceId: string,
  input: RegisterSourceInput,
): Promise<SourceRow> {
  const result = await client.query<SourceDbRow>(
    `insert into sources (workspace_id, kind, owner_principal_id, visibility, uri, metadata, name)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     returning ${SOURCE_COLUMNS}`,
    [
      workspaceId,
      input.kind,
      input.ownerPrincipalId,
      input.visibility,
      input.uri ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.name ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('registerSource: INSERT ... RETURNING produced no row');
  }
  return mapSourceRow(row);
}

export interface SourceFreshnessRow {
  readonly sourceId: string;
  readonly kind: string;
  readonly name: string | null;
  readonly lastObservedAt: Date | null;
  readonly silent: boolean;
}

/**
 * S8 W4-A (ui-audit G1; STATUS leftover 70/62): every Source owned by a `kind:'service'`
 * Principal in this workspace (a collector, an external runtime — the same population `substrate/
 * audit/invariant-checks.ts`'s `ops.collector_silent` sweeps, restated here workspace-scoped under
 * ordinary RLS rather than that module's cross-workspace admin-mode connection), with its newest
 * observation and whether that observation is older than `staleThresholdMs`. A Source with no
 * observation at all (`lastObservedAt: null`) is never `silent` — it never established a cadence
 * to fall silent from, exactly `checkCollectorSilent`'s own rule.
 */
export async function listSourceFreshness(
  client: PoolClient,
  workspaceId: string,
  staleThresholdMs: number,
): Promise<readonly SourceFreshnessRow[]> {
  const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();
  const result = await client.query<{
    id: string;
    kind: string;
    name: string | null;
    last_observed_at: Date | null;
  }>(
    `select s.id, s.kind, s.name, o.last_observed_at
       from sources s
       join principals p on p.workspace_id = s.workspace_id and p.id = s.owner_principal_id
       left join lateral (
         select max(created_at) as last_observed_at
           from observations ob
          where ob.workspace_id = s.workspace_id and ob.source_id = s.id
       ) o on true
      where s.workspace_id = $1
        and p.kind = 'service'
      order by o.last_observed_at asc nulls last`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    sourceId: row.id,
    kind: row.kind,
    name: row.name,
    lastObservedAt: row.last_observed_at,
    silent: row.last_observed_at !== null && row.last_observed_at.toISOString() < cutoff,
  }));
}

/** Links a Source to the Activity that used it (`observations.activity_id`) — the row `explain`
 *  already walks (`substrate/epistemic/explain.ts`'s `fetchObservationRefs`). `content` carries no
 *  PROV-O payload of its own for most callers here (S2.9's use is purely "this Activity used this
 *  Source"), so it defaults to an empty object rather than `null`, matching the column's
 *  `not null default '{}'` shape. S8 W5-A (leftover 75, `application/task/gate-observation.ts`'s
 *  `recordWorkerGateObservation`) is the first caller that fills it: a bounded/truncated gate
 *  operation payload, so the Observation itself carries what was actually observed rather than
 *  being a bare "this happened" marker. */
export async function recordSourceObservation(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly sourceId: string;
    readonly activityId: string;
    readonly content?: Record<string, unknown>;
  },
): Promise<{ readonly id: string }> {
  const result = await client.query<{ id: string }>(
    `insert into observations (workspace_id, source_id, activity_id, content)
     values ($1, $2, $3, $4::jsonb)
     returning id`,
    [workspaceId, input.sourceId, input.activityId, JSON.stringify(input.content ?? {})],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('recordSourceObservation: INSERT ... RETURNING produced no row');
  }
  return row;
}
