import {
  IllegalTransition,
  PUBLISHABLE_TRANSITIONS,
  type ProcedureStep,
  type PublishableStatus,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { getPublishedOperation } from '../../governance/gatekeepers/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { projectProcedureObject } from '../../substrate/ontology/index.js';
import { requirePublishedWorkerDefinition } from './definitions.js';

/**
 * application/worker/procedures: the Procedure registry (design doc §5.1.4 Procedure, §5.4
 * I12/I16, §5.5 `draft -> published -> deprecated`; docs/development-tasks.md S2.14). Owns the
 * `procedures` table (`migrations/worker/0002_skills_procedures.sql`) — same structure and
 * conventions as this module's own `definitions.ts`/`skills.ts` (propose permissive, publish is
 * the gate, publish/deprecate resolve the *latest* version under a bare `{procedureId}`, no
 * separate `version` param — `publish_procedure`/`deprecate_procedure`'s own registered
 * `paramsSchema`, packages/shared/src/capabilities.ts).
 *
 * **Publish-time step validation is this file's one piece of real business logic** (design doc
 * §5.1.4 "有序步骤引用 Operation / WorkerDefinition"; docs/development-tasks.md S2.14 acceptance:
 * "Procedure 的步骤引用不存在的 Operation 时发布被拒"): every `operation`/`worker` step must resolve
 * to a currently-**published** Operation (`getPublishedOperation`, governance/gatekeepers — I17:
 * draft/unknown is indistinguishable from "not classified yet") or WorkerDefinition
 * (`requirePublishedWorkerDefinition`, this module's own `definitions.ts`); a step that does not
 * resolve rejects the whole publish with `ProcedureStepReferenceError` (a stable, one-shape error
 * naming the offending step index and reference) — never a partial publish. `approval`/`verify`
 * steps carry no external reference and are never checked against the graph; they are procedural
 * markers a future Workflow runner (P5) must honor, not something this task executes.
 */

const graphStore = new SqlGraphStore();

// -------------------------------------------------------------------------------------------
// Row shape
// -------------------------------------------------------------------------------------------

interface ProcedureDbRow {
  workspace_id: string;
  id: string;
  version: number;
  status: PublishableStatus;
  name: string;
  description: string;
  steps: readonly ProcedureStep[];
  proposed_by: string;
  published_by: string | null;
  created_at: Date;
  published_at: Date | null;
}

export interface ProcedureRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly version: number;
  readonly status: PublishableStatus;
  readonly name: string;
  readonly description: string;
  readonly steps: readonly ProcedureStep[];
  readonly proposedBy: string;
  readonly publishedBy: string | null;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

function mapRow(row: ProcedureDbRow): ProcedureRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    version: row.version,
    status: row.status,
    name: row.name,
    description: row.description,
    steps: row.steps ?? [],
    proposedBy: row.proposed_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

const SELECT_COLUMNS = `workspace_id, id, version, status, name, description, steps, proposed_by,
  published_by, created_at, published_at`;

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

export class ProcedureNotFoundError extends Error {
  constructor(workspaceId: string, procedureId: string) {
    super(`Procedure not found: workspace ${workspaceId}, id ${procedureId}`);
    this.name = 'ProcedureNotFoundError';
  }
}

/** Thrown by `publishProcedure` when `steps` is empty, or any `operation`/`worker` step fails to
 *  resolve to a currently-published Operation/WorkerDefinition — this task's own acceptance bar
 *  ("Procedure 的步骤引用不存在的 Operation 时发布被拒"), and a stable error shape a caller (or a
 *  test) can match on regardless of which step failed or why. */
export class ProcedureStepReferenceError extends Error {
  readonly stepIndex: number;

  constructor(stepIndex: number, reason: string) {
    super(`Procedure step ${stepIndex} does not resolve: ${reason}`);
    this.name = 'ProcedureStepReferenceError';
    this.stepIndex = stepIndex;
  }
}

// -------------------------------------------------------------------------------------------
// propose
// -------------------------------------------------------------------------------------------

export interface ProposeProcedureInput {
  /** Omit to start a new Procedure family; given, proposes the next version under that existing
   *  `id` — see `skills.ts`'s `ProposeSkillInput.skillId` doc comment for the identical rationale
   *  (no currently-registered capability passes this either). */
  readonly procedureId?: string;
  readonly name: string;
  readonly description: string;
  readonly steps: readonly ProcedureStep[];
}

async function nextVersion(
  client: PoolClient,
  workspaceId: string,
  procedureId: string | undefined,
): Promise<number> {
  if (!procedureId) return 1;
  const result = await client.query<{ max: number | null }>(
    'select max(version) as max from procedures where workspace_id = $1 and id = $2',
    [workspaceId, procedureId],
  );
  return (result.rows[0]?.max ?? 0) + 1;
}

/** Creates a new `draft` Procedure version, owned by `proposerPrincipalId` (I16). No step
 *  resolution happens here — see `publishProcedure`. */
export async function proposeProcedure(
  client: PoolClient,
  workspaceId: string,
  proposerPrincipalId: string,
  input: ProposeProcedureInput,
): Promise<ProcedureRow> {
  const version = await nextVersion(client, workspaceId, input.procedureId);
  const result = await client.query<ProcedureDbRow>(
    `insert into procedures
       (workspace_id, id, version, status, name, description, steps, proposed_by)
     values
       ($1, coalesce($2::uuid, gen_random_uuid()), $3, 'draft', $4, $5, $6::jsonb, $7)
     returning ${SELECT_COLUMNS}`,
    [
      workspaceId,
      input.procedureId ?? null,
      version,
      input.name,
      input.description,
      JSON.stringify(input.steps),
      proposerPrincipalId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('proposeProcedure: INSERT ... RETURNING produced no row');
  return mapRow(row);
}

// -------------------------------------------------------------------------------------------
// publish / deprecate
// -------------------------------------------------------------------------------------------

async function getLatestForUpdate(
  client: PoolClient,
  workspaceId: string,
  procedureId: string,
): Promise<ProcedureRow> {
  const result = await client.query<ProcedureDbRow>(
    `select ${SELECT_COLUMNS} from procedures
     where workspace_id = $1 and id = $2
     order by version desc
     limit 1
     for update`,
    [workspaceId, procedureId],
  );
  const row = result.rows[0];
  if (!row) throw new ProcedureNotFoundError(workspaceId, procedureId);
  return mapRow(row);
}

interface ResolvedStepTarget {
  readonly stepIndex: number;
  readonly targetObjectId: string;
}

/** Resolves every `operation`/`worker` step to its graph Object id, throwing
 *  `ProcedureStepReferenceError` on the first step that does not resolve to a currently-published
 *  Operation/WorkerDefinition (I17: draft/unknown Operation is unclassified, never usable).
 *  `approval`/`verify` steps produce no target (filtered out of the returned list — see this
 *  module's doc comment). */
async function resolveStepTargets(
  client: PoolClient,
  workspaceId: string,
  steps: readonly ProcedureStep[],
): Promise<readonly ResolvedStepTarget[]> {
  const targets: ResolvedStepTarget[] = [];
  for (const [stepIndex, step] of steps.entries()) {
    if (step.kind === 'operation') {
      const operation = await getPublishedOperation(
        client,
        workspaceId,
        step.gatekeeperId,
        step.operationName,
      );
      if (!operation) {
        throw new ProcedureStepReferenceError(
          stepIndex,
          `Operation "${step.operationName}" on Gatekeeper ${step.gatekeeperId} is not published (or does not exist)`,
        );
      }
      const operationObject = await graphStore.getObjectByIdentity(
        client,
        workspaceId,
        'Operation',
        {
          gatekeeperId: step.gatekeeperId,
          name: step.operationName,
        },
      );
      // Defensive — `getPublishedOperation` already confirmed this Object exists (it reads the
      // same `objects` row); a null here would mean the two queries disagree, which should never
      // happen, but this function must never silently drop a step it just validated.
      if (!operationObject) {
        throw new ProcedureStepReferenceError(
          stepIndex,
          `Operation "${step.operationName}" on Gatekeeper ${step.gatekeeperId} has no graph projection`,
        );
      }
      targets.push({ stepIndex, targetObjectId: operationObject.id });
      continue;
    }

    if (step.kind === 'worker') {
      try {
        await requirePublishedWorkerDefinition(client, workspaceId, {
          definitionId: step.definitionId,
          version: step.version,
        });
      } catch (err) {
        throw new ProcedureStepReferenceError(
          stepIndex,
          `WorkerDefinition ${step.definitionId}@${step.version} is not published: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const workerDefObject = await graphStore.getObjectByIdentity(
        client,
        workspaceId,
        'WorkerDefinition',
        { definitionId: step.definitionId, version: step.version },
      );
      if (!workerDefObject) {
        throw new ProcedureStepReferenceError(
          stepIndex,
          `WorkerDefinition ${step.definitionId}@${step.version} has no graph projection`,
        );
      }
      targets.push({ stepIndex, targetObjectId: workerDefObject.id });
    }

    // 'approval' | 'verify' — no external reference to resolve (this module's doc comment).
  }
  return targets;
}

/** Publishes the latest draft version of `procedureId` (human channel only): validates the
 *  transition, requires at least one step, resolves every `operation`/`worker` step against the
 *  graph (`resolveStepTargets` — throws `ProcedureStepReferenceError` on the first bad reference),
 *  sets `published_by`/`published_at`, and projects the Procedure plus its `steps` Links into the
 *  graph (`substrate/ontology`'s `projectProcedureObject`, `SqlGraphStore.assertFact` for each
 *  resolved step) so `find_procedures` has something to traverse. */
export async function publishProcedure(
  client: PoolClient,
  workspaceId: string,
  publisherPrincipalId: string,
  procedureId: string,
): Promise<ProcedureRow> {
  const row = await getLatestForUpdate(client, workspaceId, procedureId);
  transition(PUBLISHABLE_TRANSITIONS, row.status, 'publish');

  if (row.steps.length === 0) {
    throw new ProcedureStepReferenceError(-1, 'a Procedure must have at least one step to publish');
  }
  const targets = await resolveStepTargets(client, workspaceId, row.steps);

  const result = await client.query<ProcedureDbRow>(
    `update procedures
     set status = 'published', published_by = $4, published_at = now()
     where workspace_id = $1 and id = $2 and version = $3
     returning ${SELECT_COLUMNS}`,
    [workspaceId, row.id, row.version, publisherPrincipalId],
  );
  const updated = result.rows[0];
  if (!updated) throw new Error('publishProcedure: UPDATE ... RETURNING produced no row');

  const procedureObject = await projectProcedureObject(client, workspaceId, {
    procedureId: row.id,
    version: row.version,
    name: row.name,
    description: row.description,
  });

  for (const target of targets) {
    const activity = await startActivity(client, workspaceId, {
      kind: 'procedure_publish',
      principalId: publisherPrincipalId,
      metadata: { procedureId: row.id, stepIndex: target.stepIndex },
    });
    await graphStore.assertFact(
      client,
      workspaceId,
      { id: publisherPrincipalId, kind: 'human' },
      {
        linkType: 'steps',
        sourceObjectId: procedureObject.id,
        targetObjectId: target.targetObjectId,
        activityId: activity.id,
        properties: { stepIndex: target.stepIndex },
      },
    );
    await endActivity(client, workspaceId, activity.id, 'completed');
  }

  return mapRow(updated);
}

/** Deprecates the latest version of `procedureId` (human channel only). `IllegalTransition`
 *  unless it is currently `published`. */
export async function deprecateProcedure(
  client: PoolClient,
  workspaceId: string,
  procedureId: string,
): Promise<ProcedureRow> {
  const row = await getLatestForUpdate(client, workspaceId, procedureId);
  transition(PUBLISHABLE_TRANSITIONS, row.status, 'deprecate');

  const result = await client.query<ProcedureDbRow>(
    `update procedures
     set status = 'deprecated'
     where workspace_id = $1 and id = $2 and version = $3
     returning ${SELECT_COLUMNS}`,
    [workspaceId, row.id, row.version],
  );
  const updated = result.rows[0];
  if (!updated) throw new Error('deprecateProcedure: UPDATE ... RETURNING produced no row');
  return mapRow(updated);
}

// -------------------------------------------------------------------------------------------
// reads
// -------------------------------------------------------------------------------------------

/** Reads one Procedure version regardless of status, or `null` if it doesn't exist — the raw,
 *  privacy-unfiltered read `application/task/service.ts`'s `findProcedures` uses to read back a
 *  published candidate's `steps` (the graph Object projection deliberately excludes `steps`, see
 *  `substrate/ontology/meta-objects.ts`'s `projectProcedureObject` doc comment) for its own
 *  Grant-intersection check. */
export async function getProcedure(
  client: PoolClient,
  workspaceId: string,
  ref: { readonly procedureId: string; readonly version: number },
): Promise<ProcedureRow | null> {
  const result = await client.query<ProcedureDbRow>(
    `select ${SELECT_COLUMNS} from procedures where workspace_id = $1 and id = $2 and version = $3`,
    [workspaceId, ref.procedureId, ref.version],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** `list_procedures` — same "published, or my own draft" predicate as `skills.ts`'s `listSkills`
 *  (I16 read-privacy; see that function's own doc comment). */
export async function listProcedures(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
): Promise<readonly ProcedureRow[]> {
  const result = await client.query<ProcedureDbRow>(
    `select distinct on (id) ${SELECT_COLUMNS} from procedures
     where workspace_id = $1
       and (status = 'published' or (status = 'draft' and proposed_by = $2))
     order by id, version desc`,
    [workspaceId, callerPrincipalId],
  );
  return result.rows.map(mapRow);
}

export { IllegalTransition };
