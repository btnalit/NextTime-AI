import type { PoolClient } from 'pg';
import {
  endActivity,
  recordSourceObservation,
  startActivity,
} from '../../substrate/epistemic/index.js';
import type { SourceRow } from '../../substrate/epistemic/index.js';
import type { GraphObject } from '../../substrate/graph/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { getType } from '../../substrate/ontology/index.js';
import { currentPrincipalId } from '../chat/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import { toWireSource } from './resource-wire.js';

/**
 * application/gateway/ingest-handlers: `register_source` / `submit_observations` — the two `ingest`
 * -group capabilities a service-principal collector calls (design doc §7.8 采集器, §5.1.3
 * Source/Observation/Fact; docs/development-tasks.md S3.3).
 *
 * **`register_source` writes directly to `sources`, bypassing `substrate/epistemic/sources.ts`'s
 * `registerPrivateSource`** (a deliberate, narrow deviation, same shape as `substrate/epistemic/
 * explain.ts`'s own documented one — see that module's doc comment: "a direct... SELECT... rather
 * than going through GraphStore's public interface, because [it] has no method today, and this
 * task's explicit file ownership excludes adding one there... the narrowest deviation from the
 * module-boundary convention that still satisfies the dispatch"). This task's own dispatch
 * excludes touching `substrate/epistemic/**` at all (S3.2 owns that directory in this wave), but
 * `registerPrivateSource` only ever writes `visibility: 'private'` — unusable for a collector's
 * Source, which must be `workspace`-visible for `docs/runbooks/host-collector.md`'s own
 * verification step ("`explain`/`find_*` see `Container runs_on Host`") to work at all: Fact
 * visibility inherits from the Source that fed the Activity producing it
 * (`migrations/core/0010_link_visibility.sql`), so a `private` Source owned by the collector's own
 * service Principal would make every Fact this collector writes invisible to the human operator
 * running that verification. The insert below is the same 6-line statement `registerPrivateSource`
 * already runs, parametrized over `visibility` instead of hardcoding it — not a second, drifting
 * implementation of Source lifecycle (there is none; a Source is never updated or deleted after
 * creation anywhere in this codebase).
 *
 * `sources` has no `name` column (migrations/core/0002_substrate.sql) — `name` is folded into
 * `metadata.name` on write and projected back out by `resource-wire.ts`'s `toWireSource` on read
 * (see that function's own doc comment). `register_source` always inserts a fresh row (matching its
 * literal name — "register" is a create) — a collector that must keep asserting under the *same*
 * origin across independent runs (see the next paragraph) is expected to persist the returned `id`
 * itself and call `register_source` only once ever (`collectors/host-inventory`'s own README
 * documents this — a small local `${NEXTTIME_DATA}/state/host-inventory-source.json` cache), not
 * to make this handler guess at idempotency-by-name for a capability every kind of Source caller
 * (documents, DBs, APIs, people, agent sessions — this capability's own description) shares.
 *
 * **`submit_observations` writes every Link purely through `GraphStore.assertFact` — the "seam"
 * this task's own dispatch names.** S3.2 (merged to `main` while this task was in flight,
 * `substrate/epistemic/conflicts.ts`) extended `assertFact` itself to look up any existing active
 * Fact on the same `(linkType, sourceObjectId, targetObjectId)` identity, resolve *origin* for both
 * the prior and the new assertion (`resolveFactOrigin`: the single distinct epistemic Source
 * feeding the Fact's own Activity when there is exactly one, else the asserting Principal), and
 * either delegate to `supersedeFact` (same origin) or open a `conflicts` row (different origin) —
 * see that module's own doc comment for the full rule. This handler therefore does no dedup, no
 * same-edge lookup, and no origin comparison of its own (an earlier draft of this file did — see
 * git history — and was simplified once S3.2 landed and made that logic redundant with, and
 * potentially divergent from, the store's own): every Link just calls `assertFact`, and the
 * returned Fact's own `supersedesId` (`null` for a fresh assert, set when the store delegated to a
 * supersede) is what `factsAsserted`/`factsSuperseded` below count.
 *
 * This is also what makes the collector's own acceptance criterion true: `recordSourceObservation`
 * below writes exactly one Observation, from *this* submission's `sourceId`, per top-level
 * observation item, on the *one* Activity this whole submission's Facts share — so
 * `resolveFactOrigin`'s "single distinct source_id feeding this Activity" always resolves to this
 * collector's own registered Source, every run, as long as the caller keeps reusing the same
 * `sourceId` (see this file's own `register_source` paragraph above). Two submissions of identical
 * observations therefore always resolve as *same origin* (→ supersede, never a Conflict); a changed
 * property value on a later submission still resolves as *same origin* (→ supersede, with the new
 * value) — exactly "两遍无重复无 Conflict…改端口第三遍 supersede", produced entirely by the seam this
 * handler writes through, not by any logic in this file.
 */

const graphStore = new SqlGraphStore();

// -------------------------------------------------------------------------------------------
// register_source
// -------------------------------------------------------------------------------------------

interface RegisterSourceParams {
  readonly kind: string;
  readonly name: string;
  readonly visibility: 'workspace' | 'private';
  readonly uri?: string;
  readonly metadata?: Record<string, unknown>;
}

interface SourceDbRow {
  workspace_id: string;
  id: string;
  kind: string;
  owner_principal_id: string;
  visibility: 'private' | 'workspace';
  uri: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapSourceDbRow(row: SourceDbRow): SourceRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    kind: row.kind,
    ownerPrincipalId: row.owner_principal_id,
    visibility: row.visibility,
    uri: row.uri,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export const registerSourceHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  const params = rawParams as RegisterSourceParams;
  const ownerPrincipalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const metadata = { ...(params.metadata ?? {}), name: params.name };

  const result = await client.query<SourceDbRow>(
    `insert into sources (workspace_id, kind, owner_principal_id, visibility, uri, metadata)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     returning workspace_id, id, kind, owner_principal_id, visibility, uri, metadata, created_at`,
    [
      workspaceId,
      params.kind,
      ownerPrincipalId,
      params.visibility,
      params.uri ?? null,
      JSON.stringify(metadata),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('register_source: INSERT ... RETURNING produced no row');

  const source = mapSourceDbRow(row);
  return { result: toWireSource(source), resourceType: 'source', resourceId: source.id };
};

// -------------------------------------------------------------------------------------------
// submit_observations
// -------------------------------------------------------------------------------------------

interface IngestLinkTarget {
  readonly objectType: string;
  readonly identity: Record<string, unknown>;
}

interface IngestLink {
  readonly linkType: string;
  readonly target: IngestLinkTarget;
  readonly properties?: Record<string, unknown>;
}

interface IngestObservation {
  readonly objectType: string;
  readonly identity: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
  readonly links?: readonly IngestLink[];
}

interface SubmitObservationsParams {
  readonly sourceId: string;
  readonly activityId?: string;
  readonly observations: readonly IngestObservation[];
}

/** Thrown when the caller supplies an unknown Source id, or one this caller cannot see (I5.6
 *  visibility — RLS already hides a private Source owned by someone else; this surfaces that as a
 *  clear 404 rather than a raw FK-violation 500 on the first `recordSourceObservation` insert). */
export class SourceNotFoundError extends Error {
  constructor(sourceId: string) {
    super(`submit_observations: no Source "${sourceId}" visible to this caller`);
    this.name = 'SourceNotFoundError';
  }
}

/** Thrown when an observation's (or a link target's) `identity` is missing a property the
 *  ontology registry's `identityKey` (S3.1) declares required for that ObjectType, or names an
 *  ObjectType no visible ontology family declares at all — I2, and this task's own acceptance
 *  criterion ("reject an observation whose identity misses a key field (400)"). */
export class ObservationIdentityError extends Error {
  readonly objectType: string;
  readonly reason: 'unknown_object_type' | 'missing_identity_key_fields';
  readonly missingKeys?: readonly string[];
  constructor(
    objectType: string,
    reason: 'unknown_object_type' | 'missing_identity_key_fields',
    missingKeys?: readonly string[],
  ) {
    super(
      reason === 'unknown_object_type'
        ? `submit_observations: ObjectType "${objectType}" is not declared by any ontology family visible to this caller`
        : `submit_observations: identity for ObjectType "${objectType}" is missing required key field(s): ${(missingKeys ?? []).join(', ')}`,
    );
    this.name = 'ObservationIdentityError';
    this.objectType = objectType;
    this.reason = reason;
    this.missingKeys = missingKeys;
  }
}

/** Every distinct ObjectType named by `observations` (both top-level and every link target). */
function collectObjectTypeNames(observations: readonly IngestObservation[]): Set<string> {
  const names = new Set<string>();
  for (const observation of observations) {
    names.add(observation.objectType);
    for (const link of observation.links ?? []) {
      names.add(link.target.objectType);
    }
  }
  return names;
}

/** Validates one `{objectType, identity}` pair against the resolved identityKey map — throws
 *  `ObservationIdentityError` on the first violation found across the whole batch (fail fast,
 *  before any write — same "validate everything, then write" shape `ProcedureStepReferenceError`
 *  and `WorkerResultValidationError` already use elsewhere in this codebase). */
function assertIdentityComplete(
  objectType: string,
  identity: Record<string, unknown>,
  identityKeysByType: ReadonlyMap<string, readonly string[] | undefined>,
): void {
  if (!identityKeysByType.has(objectType)) {
    throw new ObservationIdentityError(objectType, 'unknown_object_type');
  }
  const requiredKeys = identityKeysByType.get(objectType);
  if (!requiredKeys || requiredKeys.length === 0) return;
  const missing = requiredKeys.filter((key) => identity[key] === undefined);
  if (missing.length > 0) {
    throw new ObservationIdentityError(objectType, 'missing_identity_key_fields', missing);
  }
}

/** Resolves every distinct ObjectType named in `observations` to its ontology `identityKey`
 *  (`undefined` when the type declares none — no keys are required for it) via S3.1's
 *  `substrate/ontology/registry.ts` `getType`, and validates every observation/link-target
 *  identity against it before any graph write happens. */
async function resolveAndValidateIdentityKeys(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
  observations: readonly IngestObservation[],
): Promise<void> {
  const objectTypeNames = collectObjectTypeNames(observations);
  const identityKeysByType = new Map<string, readonly string[] | undefined>();
  for (const objectType of objectTypeNames) {
    const entry = await getType(client, workspaceId, callerPrincipalId, objectType);
    if (!entry || entry.kind !== 'object') {
      throw new ObservationIdentityError(objectType, 'unknown_object_type');
    }
    identityKeysByType.set(objectType, entry.identityKey);
  }

  for (const observation of observations) {
    assertIdentityComplete(observation.objectType, observation.identity, identityKeysByType);
    for (const link of observation.links ?? []) {
      assertIdentityComplete(link.target.objectType, link.target.identity, identityKeysByType);
    }
  }
}

/** Deterministic cache key for de-duplicating `upsertObject` calls within one submission —
 *  `identity`'s own key order is caller-controlled and not itself meaningful, so keys are sorted
 *  before serializing. */
function identityCacheKey(objectType: string, identity: Record<string, unknown>): string {
  const sortedEntries = Object.entries(identity).sort(([a], [b]) => a.localeCompare(b));
  return `${objectType}::${JSON.stringify(sortedEntries)}`;
}

interface TouchedObject {
  readonly objectType: string;
  readonly identity: Record<string, unknown>;
  readonly id: string;
}

interface SubmitObservationsState {
  objectsUpserted: number;
  factsAsserted: number;
  factsSuperseded: number;
  /** S3.2 followup ("idempotent re-assertion", docs/development-tasks.md): a Link whose
   *  `assertFact` call resolved to the store's own no-op path (`fact.unchanged === true`) — a
   *  same-origin re-assertion whose content exactly matched the currently-active Fact, so nothing
   *  was written. Counted separately from `factsSuperseded` so a collector re-submitting an
   *  unchanged inventory sees `factsSuperseded: 0` on its second run, not a number that grows
   *  `links` forever. */
  factsUnchanged: number;
  /** One entry per distinct `(objectType, identity)` touched — surfaced back to the caller as
   *  `objects` (`SubmitObservationsResultWireSchema`'s own doc comment,
   *  `packages/shared/src/wire/ingest.ts`, explains why: a dependency-ordered multi-phase
   *  submission needs the real graph id ops-assets-v1's identity scheme requires for `<Type>Id`
   *  fields, which no caller can invent ahead of time). */
  readonly touchedObjects: Map<string, TouchedObject>;
}

/**
 * Upserts one `{objectType, identity, properties}`. Always performs the write — never served from
 * a cache of a *prior call's own result* — because `upsertObject`'s own `ON CONFLICT` merges
 * `properties` (`objects.properties || excluded.properties`, `queries.ts`'s `buildUpsertObjectQuery`),
 * so a link target upserted first with no `properties` (this file never gives one — see
 * `IngestLink`'s own type) and the *same* identity later named by its own top-level observation
 * (with real `properties`) must each independently reach the database, or the second call's
 * properties would silently never merge in. `state.touchedObjects` tracks which `(objectType,
 * identity)` pairs this submission has already recorded purely so `objectsUpserted` counts
 * *distinct* objects touched (and `objects` in the result lists each once) — it never short-
 * circuits the write itself.
 */
async function upsertCounted(
  client: PoolClient,
  workspaceId: string,
  state: SubmitObservationsState,
  objectType: string,
  identity: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
): Promise<GraphObject> {
  const object = await graphStore.upsertObject(client, workspaceId, {
    objectType,
    identity,
    properties: properties ?? {},
  });
  const key = identityCacheKey(objectType, identity);
  if (!state.touchedObjects.has(key)) {
    state.touchedObjects.set(key, { objectType, identity, id: object.id });
    state.objectsUpserted += 1;
  }
  return object;
}

/**
 * Writes one Link purely through `GraphStore.assertFact` (this file's own module doc comment: "the
 * seam" — no pre-check, no dedup, no origin comparison here). `assertFact`'s own returned Fact
 * tells this handler which of three things happened: `fact.unchanged === true` is the S3.2 followup
 * no-op (a same-origin re-assertion whose content exactly matched the currently-active Fact — the
 * store wrote nothing); otherwise `supersedesId === null` is a fresh assert (a genuinely new edge,
 * or the first time this collector observed it), and a non-null `supersedesId` means the store
 * found a prior active Fact on this identity, resolved this submission's origin as the same as that
 * prior Fact's, and its content actually differed, so it delegated to `supersedeFact`.
 */
async function writeLink(
  client: PoolClient,
  workspaceId: string,
  callerPrincipalId: string,
  activityId: string,
  sourceObject: GraphObject,
  targetObject: GraphObject,
  linkType: string,
  properties: Record<string, unknown>,
  state: SubmitObservationsState,
  observationId: string,
): Promise<void> {
  const fact = await graphStore.assertFact(
    client,
    workspaceId,
    { id: callerPrincipalId },
    {
      linkType,
      sourceObjectId: sourceObject.id,
      targetObjectId: targetObject.id,
      activityId,
      properties,
      // W5 (migrations/core/0018): the Observation this item recorded is the one that fed this
      // Link — `explain(factId)` narrows to it instead of the Activity's whole batch.
      observationId,
    },
  );
  if (fact.unchanged) {
    state.factsUnchanged += 1;
  } else if (fact.supersedesId) {
    state.factsSuperseded += 1;
  } else {
    state.factsAsserted += 1;
  }
}

export const submitObservationsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  const params = rawParams as SubmitObservationsParams;
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  // I5.6 / RLS: a Source this caller cannot see (unknown id, or a private Source owned by someone
  // else) reads back as no row — same "not visible = not found" fail-closed shape RLS already
  // gives every other visibility-scoped table in this codebase.
  const sourceCheck = await client.query<{ id: string }>(
    'select id from sources where workspace_id = $1 and id = $2',
    [workspaceId, params.sourceId],
  );
  if (sourceCheck.rows.length === 0) throw new SourceNotFoundError(params.sourceId);

  // Validate every observation's/link-target's identity *before* starting an Activity or writing
  // anything — a batch that fails validation leaves no partial state behind. An empty/unpublished
  // ontology namespace surfaces the same way any other unknown ObjectType does: `getType` (inside
  // this call) returns `null` for the first name it cannot resolve.
  await resolveAndValidateIdentityKeys(client, workspaceId, principalId, params.observations);

  const ownActivityId = params.activityId === undefined;
  const activityId = params.activityId
    ? params.activityId
    : (
        await startActivity(client, workspaceId, {
          kind: 'ingest.submit_observations',
          principalId,
          sourceId: params.sourceId,
        })
      ).id;

  const state: SubmitObservationsState = {
    objectsUpserted: 0,
    factsAsserted: 0,
    factsSuperseded: 0,
    factsUnchanged: 0,
    touchedObjects: new Map(),
  };

  try {
    for (const observation of params.observations) {
      const sourceObject = await upsertCounted(
        client,
        workspaceId,
        state,
        observation.objectType,
        observation.identity,
        observation.properties,
      );

      // One Observation row per submitted observation item (design doc §5.1.3: "Observation：a
      // single observed input") — ties this Activity to the Source that produced this item, so
      // `explain(factId)` can trace every Fact this item's links produce back to it, and (see this
      // file's module doc comment) so `resolveFactOrigin` (S3.2) always finds exactly one distinct
      // `source_id` feeding this Activity.
      const recorded = await recordSourceObservation(client, workspaceId, {
        sourceId: params.sourceId,
        activityId,
      });

      for (const link of observation.links ?? []) {
        const targetObject = await upsertCounted(
          client,
          workspaceId,
          state,
          link.target.objectType,
          link.target.identity,
          undefined,
        );
        await writeLink(
          client,
          workspaceId,
          principalId,
          activityId,
          sourceObject,
          targetObject,
          link.linkType,
          link.properties ?? {},
          state,
          recorded.id,
        );
      }
    }

    if (ownActivityId) await endActivity(client, workspaceId, activityId, 'completed');
  } catch (err) {
    if (ownActivityId) await endActivity(client, workspaceId, activityId, 'failed').catch(() => {});
    throw err;
  }

  return {
    result: {
      activityId,
      objectsUpserted: state.objectsUpserted,
      factsAsserted: state.factsAsserted,
      factsSuperseded: state.factsSuperseded,
      factsUnchanged: state.factsUnchanged,
      objects: [...state.touchedObjects.values()],
    },
    resourceType: 'activity',
    resourceId: activityId,
  };
};
