import type { PoolClient } from 'pg';
import { registerSource } from '../../substrate/epistemic/index.js';

/**
 * application/task/worker-run-source: the one workspace-visible `worker_run` epistemic Source a
 * WorkerRun's writes share — its `report_task_result` Facts (`application/task/result.ts`'s
 * `postWorkerResult`, since W5.5/STATUS leftover 16: each run needs its own Source so two runs of
 * the same WorkerDefinition are different origins) and, from S8 W5-A (leftover 75), every gate
 * operation result that run observes (`application/task/gate-observation.ts`'s
 * `recordWorkerGateObservation`) — whichever happens first for a given WorkerRun creates the row,
 * the other reuses it.
 *
 * Keyed by `workerRunId` itself (`sources.name`, S5.3's `sources_kind_name_uidx` partial unique
 * index on `(workspace_id, kind, name)`) — race-safe the same select -> advisory lock -> re-select
 * -> insert shape `application/gateway/observed-facts.ts`'s `getOrCreateGatekeeperSource` already
 * uses for the analogous per-Gatekeeper Source.
 *
 * Metadata is first-writer-wins: only the call that actually inserts the row sets it, a later
 * `getOrCreateWorkerRunSource` call for the same `workerRunId` never merges its own `metadata` in.
 * Consequence, deliberate: when a gate call creates this Source before the run posts its result,
 * `postWorkerResult`'s own `transcriptSourceId` addition (only known once a session JSONL path is
 * in hand) is not stored on it — nothing reads that field off this Source today (grep-verified), so
 * this is a harmless simplification, not a silent loss of anything observable.
 */

const WORKER_RUN_SOURCE_KIND = 'worker_run';

interface SourceIdRow {
  id: string;
}

async function findWorkerRunSource(
  client: PoolClient,
  workspaceId: string,
  workerRunId: string,
): Promise<string | undefined> {
  const found = await client.query<SourceIdRow>(
    'select id from sources where workspace_id = $1 and kind = $2 and name = $3',
    [workspaceId, WORKER_RUN_SOURCE_KIND, workerRunId],
  );
  return found.rows[0]?.id;
}

export interface GetOrCreateWorkerRunSourceInput {
  readonly workerRunId: string;
  readonly taskId: string;
  readonly ownerPrincipalId: string;
  /** Merged into `{taskId, workerRunId}` only when this call is the one that creates the row (see
   *  this module's own doc comment on first-writer-wins metadata). */
  readonly metadata?: Record<string, unknown>;
}

export async function getOrCreateWorkerRunSource(
  client: PoolClient,
  workspaceId: string,
  input: GetOrCreateWorkerRunSourceInput,
): Promise<string> {
  const existing = await findWorkerRunSource(client, workspaceId, input.workerRunId);
  if (existing) return existing;

  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `${workspaceId}:worker-run-source:${input.workerRunId}`,
  ]);
  const raced = await findWorkerRunSource(client, workspaceId, input.workerRunId);
  if (raced) return raced;

  const source = await registerSource(client, workspaceId, {
    kind: WORKER_RUN_SOURCE_KIND,
    name: input.workerRunId,
    ownerPrincipalId: input.ownerPrincipalId,
    visibility: 'workspace',
    metadata: {
      taskId: input.taskId,
      workerRunId: input.workerRunId,
      ...(input.metadata ?? {}),
    },
  });
  return source.id;
}
