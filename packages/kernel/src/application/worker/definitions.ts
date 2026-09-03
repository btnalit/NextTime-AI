import {
  IllegalTransition,
  PUBLISHABLE_TRANSITIONS,
  type PublishableStatus,
  type WorkerDefinitionKind,
  transition,
  workerDefinitionContentSchemaFor,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { ENTRY_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { projectWorkerDefinitionObject } from '../../substrate/ontology/index.js';

/**
 * application/worker/definitions: the WorkerDefinition registry (design doc §5.1.4
 * WorkerDefinition row, §5.5 `draft -> published -> deprecated`, I12, I16;
 * docs/development-tasks.md S2.6). Owns `worker_definitions`
 * (migrations/worker/0001_worker_definitions.sql) and exposes only this service interface — it
 * must not be reached into from another module's internal files, and other modules must not
 * query its table directly; cross-module coordination happens through domain events (see
 * packages/shared).
 *
 * Every function here takes an already-open `PoolClient`, matching every other application-layer
 * service in this codebase (`application/gateway/handlers.ts`'s handlers, `application/chat`'s
 * service functions): the surrounding `withWorkspace()` transaction and the post-call
 * `writeAudit` (I11) are `application/gateway/dispatch.ts`'s generic responsibility for *every*
 * capability call, not something this module re-implements.
 *
 * I16 ("平台元本体对象只能经 human 通道发布；Handle 通道只能写对提议者私有的草稿") is largely
 * structural rather than something this module re-checks by hand:
 *   - `publish`/`deprecate` are `channel:'human'`-only capabilities (packages/shared/src/
 *     capabilities.ts) — a Handle-channel caller is rejected by `authorizeCapabilityCall` before
 *     ever reaching `publishWorkerDefinition`/`deprecateWorkerDefinition` below.
 *   - `propose` always **inserts a new row** it owns (`proposed_by` is always the calling
 *     principal — see `application/gateway/handlers.ts`'s `currentPrincipalId`), so there is no
 *     "modify another principal's draft" path through this capability at all; ownership is
 *     correct by construction, not by an extra runtime check.
 * The one I16 surface this module does *not* cover — a Handle-channel `assert_fact`/object write
 * naming a meta-ontology ObjectType — is `application/gateway/meta-ontology-guard.ts`'s job (the
 * graph write path, not the relational registry).
 */

// -------------------------------------------------------------------------------------------
// Row shape
// -------------------------------------------------------------------------------------------

interface WorkerDefinitionDbRow {
  workspace_id: string;
  id: string;
  version: number;
  kind: WorkerDefinitionKind;
  status: PublishableStatus;
  definition: Record<string, unknown>;
  proposed_by: string;
  published_by: string | null;
  created_at: Date;
  published_at: Date | null;
}

export interface WorkerDefinitionRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly version: number;
  readonly kind: WorkerDefinitionKind;
  readonly status: PublishableStatus;
  readonly definition: Record<string, unknown>;
  readonly proposedBy: string;
  readonly publishedBy: string | null;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

function mapRow(row: WorkerDefinitionDbRow): WorkerDefinitionRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    version: row.version,
    kind: row.kind,
    status: row.status,
    definition: row.definition,
    proposedBy: row.proposed_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

const SELECT_COLUMNS = `workspace_id, id, version, kind, status, definition, proposed_by,
  published_by, created_at, published_at`;

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

export class WorkerDefinitionNotFoundError extends Error {
  constructor(workspaceId: string, id: string, version: number) {
    super(`WorkerDefinition not found: workspace ${workspaceId}, id ${id}, version ${version}`);
    this.name = 'WorkerDefinitionNotFoundError';
  }
}

/** Thrown by `requirePublishedWorkerDefinition` — see that function's own doc comment
 *  (docs/development-tasks.md S2.6 acceptance: "引用 draft 被拒"). */
export class WorkerDefinitionNotPublishedError extends Error {
  constructor(workspaceId: string, id: string, version: number, actualStatus: PublishableStatus) {
    super(
      `WorkerDefinition workspace ${workspaceId}, id ${id}, version ${version} is not published ` +
        `(status: ${actualStatus}) — only a published version may be referenced`,
    );
    this.name = 'WorkerDefinitionNotPublishedError';
  }
}

/** Thrown when a `definition` fails its kind-specific Zod schema, or (for `kind='entry'`) when
 *  `capabilities` is not a subset of the fixed entry ceiling (`entryScope()`). */
export class WorkerDefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerDefinitionValidationError';
  }
}

/** Thrown when `propose` targets an existing `definitionId` whose established `kind` differs from
 *  the proposal's `kind` — `kind` is immutable per `id` across every version in that family. */
export class WorkerDefinitionKindMismatchError extends Error {
  constructor(id: string, existingKind: WorkerDefinitionKind, proposedKind: WorkerDefinitionKind) {
    super(
      `WorkerDefinition ${id} is kind "${existingKind}" — cannot propose a "${proposedKind}" version under the same id`,
    );
    this.name = 'WorkerDefinitionKindMismatchError';
  }
}

// -------------------------------------------------------------------------------------------
// Content validation (publish-time only — see this module's doc comment: propose is intentionally
// permissive, publish is the gate).
// -------------------------------------------------------------------------------------------

function assertEntryCapabilitiesWithinCeiling(capabilities: readonly string[]): void {
  const ceiling = new Set(ENTRY_CEILING_CAPABILITIES);
  const outside = capabilities.filter((name) => !ceiling.has(name));
  if (outside.length > 0) {
    throw new WorkerDefinitionValidationError(
      `entry WorkerDefinition capabilities exceed the entry ceiling (entryScope()): ${outside.join(', ')}`,
    );
  }
}

/** Validates `definition` against its kind-specific content schema, and (entry only) the
 *  capability ceiling. Throws `WorkerDefinitionValidationError`; returns nothing on success. */
export function validateWorkerDefinitionContent(
  kind: WorkerDefinitionKind,
  definition: Record<string, unknown>,
): void {
  const schema = workerDefinitionContentSchemaFor(kind);
  const result = schema.safeParse(definition);
  if (!result.success) {
    throw new WorkerDefinitionValidationError(
      `WorkerDefinition definition failed validation for kind "${kind}": ${result.error.message}`,
    );
  }
  if (kind === 'entry' && 'capabilities' in result.data) {
    // `result.data`'s static type is the union of both kind-specific schemas (S2.7 added an
    // *optional* `capabilities` to the worker-kind schema too, packages/shared/src/worker-
    // definition.ts) — `?? []` is defensive typing only; at runtime, `kind === 'entry'` already
    // guarantees `EntryWorkerDefinitionContentSchema` parsed this, whose own `capabilities` is
    // required, never `undefined`.
    assertEntryCapabilitiesWithinCeiling(result.data.capabilities ?? []);
  }
}

// -------------------------------------------------------------------------------------------
// propose
// -------------------------------------------------------------------------------------------

export interface ProposeWorkerDefinitionInput {
  /** Omit to start a new WorkerDefinition family (a fresh `id`, version 1); given, proposes the
   *  next version under that existing `id`. */
  readonly definitionId?: string;
  readonly kind: WorkerDefinitionKind;
  readonly definition: Record<string, unknown>;
}

async function nextVersion(
  client: PoolClient,
  workspaceId: string,
  definitionId: string | undefined,
): Promise<number> {
  if (!definitionId) return 1;
  const result = await client.query<{ max: number | null }>(
    'select max(version) as max from worker_definitions where workspace_id = $1 and id = $2',
    [workspaceId, definitionId],
  );
  return (result.rows[0]?.max ?? 0) + 1;
}

async function existingKind(
  client: PoolClient,
  workspaceId: string,
  definitionId: string,
): Promise<WorkerDefinitionKind | null> {
  const result = await client.query<{ kind: WorkerDefinitionKind }>(
    'select kind from worker_definitions where workspace_id = $1 and id = $2 limit 1',
    [workspaceId, definitionId],
  );
  return result.rows[0]?.kind ?? null;
}

/** Creates a new `draft` WorkerDefinition version, owned by `proposerPrincipalId` (I16: ownership
 *  is the calling principal by construction — see this module's doc comment). No content
 *  validation happens here — see `publishWorkerDefinition`. */
export async function proposeWorkerDefinition(
  client: PoolClient,
  workspaceId: string,
  proposerPrincipalId: string,
  input: ProposeWorkerDefinitionInput,
): Promise<WorkerDefinitionRow> {
  if (input.definitionId) {
    const priorKind = await existingKind(client, workspaceId, input.definitionId);
    if (priorKind && priorKind !== input.kind) {
      throw new WorkerDefinitionKindMismatchError(input.definitionId, priorKind, input.kind);
    }
  }

  const version = await nextVersion(client, workspaceId, input.definitionId);
  const result = await client.query<WorkerDefinitionDbRow>(
    `insert into worker_definitions
       (workspace_id, id, version, kind, status, definition, proposed_by)
     values
       ($1, coalesce($2::uuid, gen_random_uuid()), $3, $4, 'draft', $5::jsonb, $6)
     returning ${SELECT_COLUMNS}`,
    [
      workspaceId,
      input.definitionId ?? null,
      version,
      input.kind,
      JSON.stringify(input.definition),
      proposerPrincipalId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('proposeWorkerDefinition: INSERT ... RETURNING produced no row');
  return mapRow(row);
}

// -------------------------------------------------------------------------------------------
// publish / deprecate
// -------------------------------------------------------------------------------------------

export interface WorkerDefinitionVersionRef {
  readonly definitionId: string;
  readonly version: number;
}

async function getForUpdate(
  client: PoolClient,
  workspaceId: string,
  ref: WorkerDefinitionVersionRef,
): Promise<WorkerDefinitionRow> {
  const result = await client.query<WorkerDefinitionDbRow>(
    `select ${SELECT_COLUMNS} from worker_definitions
     where workspace_id = $1 and id = $2 and version = $3
     for update`,
    [workspaceId, ref.definitionId, ref.version],
  );
  const row = result.rows[0];
  if (!row) throw new WorkerDefinitionNotFoundError(workspaceId, ref.definitionId, ref.version);
  return mapRow(row);
}

/** Publishes a draft version (human channel only — enforced at the gateway, see this module's
 *  doc comment): validates the transition via `PUBLISHABLE_TRANSITIONS` (`IllegalTransition` on
 *  anything but `draft -> published`), validates `definition` against its kind-specific schema
 *  (entry: capabilities ⊆ entryScope()), sets `published_by`/`published_at`, and projects the
 *  WorkerDefinition into the graph (`substrate/ontology`'s `projectWorkerDefinitionObject`) so
 *  `find_workers` (S2.7) has something to traverse. */
export async function publishWorkerDefinition(
  client: PoolClient,
  workspaceId: string,
  publisherPrincipalId: string,
  ref: WorkerDefinitionVersionRef,
): Promise<WorkerDefinitionRow> {
  const row = await getForUpdate(client, workspaceId, ref);
  transition(PUBLISHABLE_TRANSITIONS, row.status, 'publish'); // throws IllegalTransition if illegal

  validateWorkerDefinitionContent(row.kind, row.definition);

  const result = await client.query<WorkerDefinitionDbRow>(
    `update worker_definitions
     set status = 'published', published_by = $4, published_at = now()
     where workspace_id = $1 and id = $2 and version = $3
     returning ${SELECT_COLUMNS}`,
    [workspaceId, ref.definitionId, ref.version, publisherPrincipalId],
  );
  const updated = result.rows[0];
  if (!updated) throw new Error('publishWorkerDefinition: UPDATE ... RETURNING produced no row');

  // S2.7: thread the definition's own `name`/`description` (packages/shared/src/worker-
  // definition.ts), when present, into the graph projection — see meta-objects.ts's
  // `WorkerDefinitionObjectInput` doc comment for why (find_workers ranking only).
  const contentName = row.definition.name;
  const contentDescription = row.definition.description;
  await projectWorkerDefinitionObject(client, workspaceId, {
    definitionId: ref.definitionId,
    version: ref.version,
    kind: row.kind,
    ...(typeof contentName === 'string' ? { name: contentName } : {}),
    ...(typeof contentDescription === 'string' ? { description: contentDescription } : {}),
  });

  return mapRow(updated);
}

/** Deprecates a published version (human channel only — enforced at the gateway). Validates the
 *  transition via `PUBLISHABLE_TRANSITIONS` (`published -> deprecated` is its only edge out of
 *  `published`; `IllegalTransition` otherwise, e.g. deprecating a draft or an already-deprecated
 *  version). */
export async function deprecateWorkerDefinition(
  client: PoolClient,
  workspaceId: string,
  ref: WorkerDefinitionVersionRef,
): Promise<WorkerDefinitionRow> {
  const row = await getForUpdate(client, workspaceId, ref);
  transition(PUBLISHABLE_TRANSITIONS, row.status, 'deprecate');

  const result = await client.query<WorkerDefinitionDbRow>(
    `update worker_definitions
     set status = 'deprecated'
     where workspace_id = $1 and id = $2 and version = $3
     returning ${SELECT_COLUMNS}`,
    [workspaceId, ref.definitionId, ref.version],
  );
  const updated = result.rows[0];
  if (!updated) throw new Error('deprecateWorkerDefinition: UPDATE ... RETURNING produced no row');
  return mapRow(updated);
}

// -------------------------------------------------------------------------------------------
// reads
// -------------------------------------------------------------------------------------------

/** Reads one WorkerDefinition version, or `null` if it doesn't exist. Does **not** check status —
 *  see `requirePublishedWorkerDefinition` for the "must be published" variant S2.7's
 *  `invoke_worker` needs. */
export async function getWorkerDefinition(
  client: PoolClient,
  workspaceId: string,
  ref: WorkerDefinitionVersionRef,
): Promise<WorkerDefinitionRow | null> {
  const result = await client.query<WorkerDefinitionDbRow>(
    `select ${SELECT_COLUMNS} from worker_definitions
     where workspace_id = $1 and id = $2 and version = $3`,
    [workspaceId, ref.definitionId, ref.version],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Throws `WorkerDefinitionNotFoundError` / `WorkerDefinitionNotPublishedError` unless `ref`
 *  resolves to a `published` version — the "a Task/Handle may only reference a published version"
 *  rule (docs/development-tasks.md S2.6 acceptance: "引用 draft 被拒"). Exposed for S2.7's
 *  `invoke_worker` (and any other future caller that pins a `(definitionId, version)`) to call
 *  before acting on it. */
export async function requirePublishedWorkerDefinition(
  client: PoolClient,
  workspaceId: string,
  ref: WorkerDefinitionVersionRef,
): Promise<WorkerDefinitionRow> {
  const row = await getWorkerDefinition(client, workspaceId, ref);
  if (!row) throw new WorkerDefinitionNotFoundError(workspaceId, ref.definitionId, ref.version);
  if (row.status !== 'published') {
    throw new WorkerDefinitionNotPublishedError(
      workspaceId,
      ref.definitionId,
      ref.version,
      row.status,
    );
  }
  return row;
}

/** The workspace's current published `kind='entry'` WorkerDefinition (the most recently published
 *  one, across every entry-kind `id` in the workspace — see this module's doc comment: there is
 *  no `principal_id` column on `worker_definitions`, so the entry WorkerDefinition is workspace-
 *  wide, shared by every user's entry container in that workspace, not per-user), or `null` if
 *  none has ever been published. `AgentHostRuntime.startTurn` (S2.6 deliverable 5) calls this to
 *  resolve the container's `systemPrompt`/`model`. */
export async function getPublishedEntryDefinition(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkerDefinitionRow | null> {
  const result = await client.query<WorkerDefinitionDbRow>(
    `select ${SELECT_COLUMNS} from worker_definitions
     where workspace_id = $1 and kind = 'entry' and status = 'published'
     order by published_at desc
     limit 1`,
    [workspaceId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Lists published WorkerDefinitions (`list_worker_definitions`'s own description: "List
 *  published WorkerDefinitions" — packages/shared/src/capabilities.ts), optionally filtered by
 *  `kind`. */
export async function listWorkerDefinitions(
  client: PoolClient,
  workspaceId: string,
  kind?: WorkerDefinitionKind,
): Promise<readonly WorkerDefinitionRow[]> {
  const result = kind
    ? await client.query<WorkerDefinitionDbRow>(
        `select ${SELECT_COLUMNS} from worker_definitions
         where workspace_id = $1 and status = 'published' and kind = $2
         order by created_at desc`,
        [workspaceId, kind],
      )
    : await client.query<WorkerDefinitionDbRow>(
        `select ${SELECT_COLUMNS} from worker_definitions
         where workspace_id = $1 and status = 'published'
         order by created_at desc`,
        [workspaceId],
      );
  return result.rows.map(mapRow);
}

export { IllegalTransition };
