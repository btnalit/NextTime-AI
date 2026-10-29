import {
  IllegalTransition,
  type OutputSchema,
  PUBLISHABLE_TRANSITIONS,
  type ProcedureStep,
  type PublishableStatus,
  transition,
  usesPlanTemplateFields,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type PublishActor,
  assertPublishAuthority,
  assertReviewedDraft,
  assertReviewedVersion,
} from '../../governance/capability/index.js';
import { getPublishedOperation } from '../../governance/gatekeepers/index.js';
import { assertDraftCredentialsReviewed, quotedName } from '../../governance/redaction/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { projectProcedureObject } from '../../substrate/ontology/index.js';
import { requirePublishedWorkerDefinition } from './definitions.js';
import { type DraftViewer, draftVisibilityBinds, draftVisibleTo } from './draft-visibility.js';
import { assertNoPendingDraft, familyVersionDigest, readFamilyHead } from './family-version.js';
import { assertFamilyPublishAuthority } from './publish-family.js';

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
 *
 * S11 GO5d-2: a published Procedure is also a template a goal's plan is made from (`propose_goal`'s
 * `fromProcedure`, `application/goal/from-procedure.ts`), taking `parameters` (worker/0005). One
 * that says anything of that plan (`usesPlanTemplateFields`) is published only when the plan it
 * makes passes — the check the `publish_procedure` handler passes in ({@link PublishProcedureOptions};
 * it lives with the plan, which reads this module, so it is handed in rather than imported).
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
  parameters: OutputSchema | null;
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
  /** S11 GO5d-2: the parameters schema of a goal made from it; `null` = it takes none. */
  readonly parameters: OutputSchema | null;
  readonly proposedBy: string;
  readonly publishedBy: string | null;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

/** Review #493 on #764 (F1): the digest a reviewer hands back to `publish_procedure`
 *  (`familyVersionDigest`) — everything the version says, and who proposed it. */
export function procedureDraftDigest(
  row: Pick<
    ProcedureRow,
    'id' | 'version' | 'name' | 'description' | 'steps' | 'parameters' | 'proposedBy'
  >,
): string {
  return familyVersionDigest('procedure', {
    id: row.id,
    version: row.version,
    name: row.name,
    description: row.description,
    steps: row.steps,
    parameters: row.parameters,
    proposedBy: row.proposedBy,
  });
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
    parameters: row.parameters ?? null,
    proposedBy: row.proposed_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

const SELECT_COLUMNS = `workspace_id, id, version, status, name, description, steps, parameters,
  proposed_by, published_by, created_at, published_at`;

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
  /** Omit to start a new Procedure family; given (`propose_procedure{procedureId}`, S11 W1a E2-0),
   *  proposes the next version of that existing family under the rules of `family-version.ts`. A
   *  Procedure is addressed by id (`find_procedures`, `propose_goal`'s `fromProcedure`), so unlike a
   *  Skill a new version may change its name. */
  readonly procedureId?: string;
  readonly name: string;
  readonly description: string;
  readonly steps: readonly ProcedureStep[];
  /** S11 GO5d-2: absent — it takes no parameters. */
  readonly parameters?: OutputSchema;
}

/** The version a proposal gets: 1 for a new family; for an existing one, the next after its latest,
 *  which must exist and not be a draft (`family-version.ts`). Two locks, then the latest version is
 *  read again. The family's own advisory lock serializes proposals of it (review #493 on #764,
 *  P3-2): when the row a proposal waits on is a draft being discarded, the row lock alone only
 *  holds because Postgres then locks the next row (`LockRows` runs under `Limit`) — executor
 *  behaviour, where this lock states the rule, as `lockWorkerRegistry` does for Skills. The latest
 *  row `for update` is the lock `publishProcedure` / `deprecateProcedure` take. A second proposal
 *  waiting on either sees the first one's draft. */
async function nextVersion(
  client: PoolClient,
  workspaceId: string,
  procedureId: string | undefined,
): Promise<number> {
  if (!procedureId) return 1;
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `procedure_family:${workspaceId}:${procedureId}`,
  ]);
  await client.query(
    `select version from procedures
     where workspace_id = $1 and id = $2
     order by version desc
     limit 1
     for update`,
    [workspaceId, procedureId],
  );
  const head = await readFamilyHead(client, 'procedures', workspaceId, procedureId);
  if (!head) throw new ProcedureNotFoundError(workspaceId, procedureId);
  assertNoPendingDraft('procedure', procedureId, head);
  return head.version + 1;
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
       (workspace_id, id, version, status, name, description, steps, parameters, proposed_by)
     values
       ($1, coalesce($2::uuid, gen_random_uuid()), $3, 'draft', $4, $5, $6::jsonb, $7::jsonb, $8)
     returning ${SELECT_COLUMNS}`,
    [
      workspaceId,
      input.procedureId ?? null,
      version,
      input.name,
      input.description,
      JSON.stringify(input.steps),
      input.parameters === undefined ? null : JSON.stringify(input.parameters),
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

/** D-24 (`governance/capability/publish-authority.ts`): the locked row's proposer or the owner.
 *  A draft the caller cannot see (`draftVisibleTo`) is not found — the same answer
 *  `list_procedures` gives; a row the caller can see (a builder reviewing someone else's draft, or
 *  any published / deprecated version) is a 403 `not_proposer`. */
function requireProcedureAuthority(
  action: 'publish_procedure' | 'deprecate_procedure',
  actor: PublishActor | undefined,
  row: ProcedureRow,
): void {
  assertPublishAuthority(
    action,
    actor,
    row,
    `Procedure ${row.id}@${row.version}`,
    actor && !draftVisibleTo(actor, row)
      ? () => new ProcedureNotFoundError(row.workspaceId, row.id)
      : undefined,
  );
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
          `Operation ${quotedName(step.operationName)} on Gatekeeper ${step.gatekeeperId} is not published (or does not exist)`,
        );
      }
      // `getPublishedOperation` already resolved this Object and carries its own id (S3.12:
      // Operation's identity gained a `version` dimension, so a plain `{gatekeeperId, name}`
      // `getObjectByIdentity` lookup — this used to re-fetch the same row that way — no longer
      // resolves anything; `operation.id` is that same row, no second query needed).
      targets.push({ stepIndex, targetObjectId: operation.id });
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

/** What a Procedure makes take effect when published — the content `publish_procedure`'s
 *  suspected-credential count reads (governance/redaction/credential-review.ts). Steps can carry
 *  call arguments, so a value under a secret-named field counts too. */
export function procedureReviewContent(row: ProcedureRow): unknown {
  return {
    name: row.name,
    description: row.description,
    steps: row.steps,
    ...(row.parameters !== null ? { parameters: row.parameters } : {}),
  };
}

/** S11 GO5d-2: thrown by `publishProcedure` when the Procedure says how a goal's plan is made from
 *  it and that plan does not pass (400 `invalid_params` with `details.problems`, like a plan). */
export class ProcedureTemplateError extends Error {
  readonly problems: readonly string[];

  constructor(subject: string, problems: readonly string[]) {
    super(`${subject} cannot make a goal's plan: ${problems.join('; ')}`);
    this.name = 'ProcedureTemplateError';
    this.problems = problems;
  }
}

export interface PublishProcedureOptions {
  /** S11 GO5d-2: what stops the Procedure as a goal-plan template — asked only of one that says
   *  anything of that plan (`usesPlanTemplateFields`); `application/goal`'s
   *  `procedureTemplateProblems`. */
  readonly templateProblems?: (row: ProcedureRow) => readonly string[];
}

/** Publishes the latest draft version of `procedureId` (human channel only): validates the
 *  transition, requires at least one step, resolves every `operation`/`worker` step against the
 *  graph (`resolveStepTargets` — throws `ProcedureStepReferenceError` on the first bad reference),
 *  sets `published_by`/`published_at`, and projects the Procedure plus its `steps` Links into the
 *  graph (`substrate/ontology`'s `projectProcedureObject`, `SqlGraphStore.assertFact` for each
 *  resolved step) so `find_procedures` has something to traverse.
 *
 *  `actor` (D-24): the `publish_procedure` caller — `actor.principalId` is
 *  `publisherPrincipalId` — checked against the locked row (`requireProcedureAuthority`) and the
 *  family's live version it would supersede (`assertFamilyPublishAuthority`); omitted by internal
 *  callers. */
export async function publishProcedure(
  client: PoolClient,
  workspaceId: string,
  publisherPrincipalId: string,
  procedureId: string,
  actor?: PublishActor,
  options: PublishProcedureOptions = {},
): Promise<ProcedureRow> {
  const row = await getLatestForUpdate(client, workspaceId, procedureId);
  requireProcedureAuthority('publish_procedure', actor, row);
  // Legacy 300: publish what the person reviewed — a newer version under this id since refuses.
  assertReviewedVersion(
    'publish_procedure',
    `Procedure ${row.id}`,
    actor?.reviewedVersion,
    row.version,
  );
  // Review #493 on #764 (F1): and the content of that version — see `publishSkill`.
  assertReviewedDraft(
    'publish_procedure',
    `Procedure ${row.id}@${row.version}`,
    actor?.reviewedDraftDigest,
    procedureDraftDigest(row),
  );
  transition(PUBLISHABLE_TRANSITIONS, row.status, 'publish');
  await assertFamilyPublishAuthority(client, workspaceId, {
    table: 'procedures',
    action: 'publish_procedure',
    familyId: row.id,
    subject: `Procedure ${row.id}@${row.version}`,
    actor,
  });

  if (row.steps.length === 0) {
    throw new ProcedureStepReferenceError(-1, 'a Procedure must have at least one step to publish');
  }
  assertDraftCredentialsReviewed(
    'procedure',
    `${row.id}@${row.version}`,
    procedureReviewContent(row),
    actor,
    { secretFields: true },
  );
  const targets = await resolveStepTargets(client, workspaceId, row.steps);
  if (options.templateProblems && usesPlanTemplateFields(row)) {
    const problems = options.templateProblems(row);
    if (problems.length > 0) {
      throw new ProcedureTemplateError(`Procedure ${row.id}@${row.version}`, problems);
    }
  }

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
  actor?: PublishActor,
): Promise<ProcedureRow> {
  const row = await getLatestForUpdate(client, workspaceId, procedureId);
  requireProcedureAuthority('deprecate_procedure', actor, row);
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

/** S11 GO5d-2: a published version of `procedureId` — `version`, or its latest published one —
 *  or `null` when there is none (unknown, only drafts, or deprecated): what a goal's plan is made
 *  from (`application/goal/from-procedure.ts`). Published content never changes (worker/0002's
 *  trigger), so no lock is needed. */
export async function getPublishedProcedure(
  client: PoolClient,
  workspaceId: string,
  ref: { readonly procedureId: string; readonly version?: number },
): Promise<ProcedureRow | null> {
  const result = await client.query<ProcedureDbRow>(
    `select ${SELECT_COLUMNS} from procedures
      where workspace_id = $1 and id = $2 and status = 'published'
        and ($3::int is null or version = $3)
      order by version desc
      limit 1`,
    [workspaceId, ref.procedureId, ref.version ?? null],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

// -------------------------------------------------------------------------------------------
// S8 W1-C (leftover 48 pagination list): same shape/reasoning as `skills.ts`'s own `listSkills`
// keyset page — see that function's own doc comment.
// -------------------------------------------------------------------------------------------
export const DEFAULT_LIST_PROCEDURES_LIMIT = 100;
export const MAX_LIST_PROCEDURES_LIMIT = 500;

const PROCEDURE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeListProceduresCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeListProceduresCursor(
  cursor: string | undefined,
): { readonly createdAt: string; readonly id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sepIndex = decoded.lastIndexOf('|');
    if (sepIndex < 0) return null;
    const createdAt = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !PROCEDURE_UUID_PATTERN.test(id)) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface ListProceduresFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ProceduresPage {
  readonly items: readonly ProcedureRow[];
  readonly nextCursor?: string;
  readonly truncated?: true;
}

/** As `skills.ts`'s `latestPublishedSkills` (UX acceptance of #764, P2-1): each of
 *  `procedureIds`' latest published version — the one a goal made from it uses
 *  (`getPublishedProcedure` without a version) — keyed by id; `list_procedures` attaches it to a
 *  draft row as `inUse`. */
export async function latestPublishedProcedures(
  client: PoolClient,
  workspaceId: string,
  procedureIds: readonly string[],
): Promise<ReadonlyMap<string, ProcedureRow>> {
  if (procedureIds.length === 0) return new Map();
  const result = await client.query<ProcedureDbRow>(
    `select distinct on (id) ${SELECT_COLUMNS} from procedures
     where workspace_id = $1 and id = any($2::uuid[]) and status = 'published'
     order by id, version desc`,
    [workspaceId, procedureIds],
  );
  return new Map(result.rows.map((row) => [row.id, mapRow(row)]));
}

/** `list_procedures` — same "published, or a draft the viewer may see" predicate as `skills.ts`'s
 *  `listSkills` (I16 read-privacy with D-26's reviewer rule, `draftVisibleTo`; see that function's
 *  own doc comment), and the same keyset-page shape. */
export async function listProcedures(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftViewer,
  filter: ListProceduresFilter = {},
): Promise<ProceduresPage> {
  const requestedLimit = filter.limit ?? DEFAULT_LIST_PROCEDURES_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIST_PROCEDURES_LIMIT);
  const cursor = decodeListProceduresCursor(filter.cursor);
  const visibility = draftVisibilityBinds(viewer);

  const result = await client.query<ProcedureDbRow>(
    `with latest as (
       select distinct on (id) ${SELECT_COLUMNS} from procedures
       where workspace_id = $1
         and (
           status = 'published'
           or (status = 'draft' and ($6::boolean or proposed_by = $2))
         )
       order by id, version desc
     )
     select * from latest
     where (
       $3::timestamptz is null
       or (date_trunc('milliseconds', created_at), id) < ($3::timestamptz, $4::uuid)
     )
     order by date_trunc('milliseconds', created_at) desc, id desc
     limit $5`,
    [
      workspaceId,
      visibility.principalId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
      visibility.seesEveryDraft,
    ],
  );

  const rows = result.rows.slice(0, limit).map(mapRow);
  const last = rows[rows.length - 1];
  const nextCursor =
    result.rows.length > limit && last
      ? encodeListProceduresCursor(last.createdAt, last.id)
      : undefined;
  const truncated = requestedLimit > MAX_LIST_PROCEDURES_LIMIT ? (true as const) : undefined;
  return {
    items: rows,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

export { IllegalTransition };
