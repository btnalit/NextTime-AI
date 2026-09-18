import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import {
  endActivity,
  findSourceByName,
  recordSourceObservation,
  registerSource,
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
 * **`register_source` is idempotent on (kind, name)** (S5.3, migration core 0028 `sources.name` +
 * `sources_kind_name_uidx`; docs/development-tasks.md §5b S5.3). A collector's Source must be
 * `workspace`-visible (Fact visibility inherits from the Source that fed the Activity —
 * `migrations/core/0010_link_visibility.sql` — so a `private` one would hide every Fact the
 * collector writes from the operator running `docs/runbooks/host-collector.md`'s verification),
 * which is why this handler goes through `substrate/epistemic`'s `registerSource` (explicit
 * visibility) rather than `registerPrivateSource`. Registering a name the caller already owns
 * with the same visibility returns the existing row (`created: false`) — the collector calls
 * `register_source` on every run and keeps its origin without any local state, which is what
 * `resolveFactOrigin` (next paragraph) needs; a name held by another owner, or already registered
 * with the other visibility, is a 409 `source_identity_conflict` (`SourceIdentityConflictError`),
 * never a silent second row. Before 0028 the name lived only in `metadata.name` (still written,
 * for readers of the bag) and the collector cached the id in a state file.
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

/** S5.3: the (kind, name) is already a Source the caller cannot take over — another owner's, the
 *  other visibility, or one RLS hides from the caller (a same-named private Source). HTTP 409
 *  `source_identity_conflict`; the caller picks another name or uses the row it already owns. */
export class SourceIdentityConflictError extends Error {
  readonly code = 'source_identity_conflict';
  constructor(kind: string, name: string, detail: string) {
    super(`register_source: a "${kind}" Source named "${name}" already exists ${detail}`);
    this.name = 'SourceIdentityConflictError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function existingSourceResult(
  existing: SourceRow,
  params: RegisterSourceParams,
  ownerPrincipalId: string,
) {
  if (existing.ownerPrincipalId !== ownerPrincipalId) {
    throw new SourceIdentityConflictError(params.kind, params.name, 'with a different owner');
  }
  if (existing.visibility !== params.visibility) {
    throw new SourceIdentityConflictError(
      params.kind,
      params.name,
      `with visibility "${existing.visibility}"`,
    );
  }
  return {
    result: { ...toWireSource(existing), created: false },
    resourceType: 'source',
    resourceId: existing.id,
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
  const identity = { kind: params.kind, name: params.name };

  const existing = await findSourceByName(client, workspaceId, identity);
  if (existing) return existingSourceResult(existing, params, ownerPrincipalId);

  // First registration of this (kind, name): same select → transaction-scoped advisory lock →
  // re-select → insert shape as `SqlGraphStore.assertFact`'s first-time identity path, so two
  // concurrent first runs of one collector register one Source instead of one of them failing.
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `${workspaceId}:source:${params.kind}:${params.name}`,
  ]);
  const raced = await findSourceByName(client, workspaceId, identity);
  if (raced) return existingSourceResult(raced, params, ownerPrincipalId);

  let source: SourceRow;
  try {
    source = await registerSource(client, workspaceId, {
      kind: params.kind,
      name: params.name,
      ownerPrincipalId,
      visibility: params.visibility,
      uri: params.uri,
      metadata,
    });
  } catch (err) {
    // The unique index found a row the lookups above could not see: someone else's private
    // Source of this (kind, name). The transaction is aborted either way; surface it as the 409.
    if (isUniqueViolation(err)) {
      throw new SourceIdentityConflictError(
        params.kind,
        params.name,
        'but is not visible to this caller',
      );
    }
    throw err;
  }
  return {
    result: { ...toWireSource(source), created: true },
    resourceType: 'source',
    resourceId: source.id,
  };
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

/** S5.2 observation window — `submit_observations`'s `window` param (packages/shared/src/
 *  capabilities.ts has the caller-facing wording): this submission is `sourceId`'s *complete*
 *  view of `objectTypes` within its Activity. */
interface ObservationWindow {
  readonly complete: true;
  readonly objectTypes: readonly string[];
}

interface SubmitObservationsParams {
  readonly sourceId: string;
  readonly activityId?: string;
  readonly observations: readonly IngestObservation[];
  readonly window?: ObservationWindow;
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
  /** S5.2: Facts the `window` declared absent, invalidated `not_reobserved` — `0` without a window. */
  factsInvalidated: number;
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
    // S5.2 (migrations/core/0026): an ingest is an observation of the Object — advance its clock.
    observedAt: new Date(),
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
    factsInvalidated: 0,
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

    // S5.2 observation window (docs/development-tasks.md §5b S5.2): after this submission's own
    // writes have advanced every re-observed Fact's `last_observed_at` to now, everything of this
    // Source that starts at an Object of the declared types and was last observed *before this
    // Activity began* is what the run did not see. The Activity's start is the window's start on
    // purpose — a collector's phases share one Activity, so one window on the last phase covers
    // the whole run (per-phase windows would invalidate what an earlier phase of the same run
    // wrote, since phases 2 and 3 both emit Container edges). Strictly `<`: phase 1's own writes
    // carry the Activity's `now()`, which is "seen in this run". One audit row per window, not per
    // Fact — a host's first windowed run may retire hundreds of leftover-28 phantoms at once.
    if (params.window) {
      const started = await client.query<{ created_at: Date }>(
        'select created_at from activities where workspace_id = $1 and id = $2',
        [workspaceId, activityId],
      );
      const before = started.rows[0]?.created_at;
      if (!before) throw new Error(`submit_observations: Activity ${activityId} has no row`);
      const invalidated = await graphStore.invalidateUnobservedFacts(client, workspaceId, {
        sourceId: params.sourceId,
        objectTypes: params.window.objectTypes,
        before,
      });
      state.factsInvalidated = invalidated.length;
      if (invalidated.length > 0) {
        await writeAudit(client, {
          workspaceId,
          actorPrincipalId: principalId,
          action: 'facts_not_reobserved',
          resourceType: 'activity',
          resourceId: activityId,
          payload: {
            sourceId: params.sourceId,
            objectTypes: [...params.window.objectTypes],
            count: invalidated.length,
            sample: invalidated.slice(0, 5),
          },
        });
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
      factsInvalidated: state.factsInvalidated,
      objects: [...state.touchedObjects.values()],
    },
    resourceType: 'activity',
    resourceId: activityId,
  };
};
