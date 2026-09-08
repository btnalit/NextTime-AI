import type { Operation, PrincipalKind, PublishableStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { GraphObject } from '../graph/index.js';
import { SqlGraphStore } from '../graph/index.js';

/**
 * substrate/ontology/meta-objects: projects platform meta-ontology entities (design doc §5.1.2
 * "WorkerDefinition、Gatekeeper、... 也是 Object") into the graph as `objects`/`links` rows — the
 * module table (§7.1) assigns "类型、WorkerDefinition、Gatekeeper、Capability 对象" to `ontology`,
 * not to whichever module owns the entity's own relational lifecycle table
 * (`application/worker/definitions.ts` owns `worker_definitions`' draft/published/deprecated
 * transitions; `governance/connections` will own Gatekeeper registration, S2.13). This module only
 * ever *writes a graph projection* of an already-governed entity — it never itself decides whether
 * a write is authorized (I16 channel/state checks happen at the capability layer, before either of
 * these functions is ever called: `publish_worker_definition` is human-channel-only by the
 * capability registry itself, and S2.13's `create_connection` is likewise human/owner-only).
 *
 * A `graphStore.upsertObject` call needs no Activity (Objects carry no provenance chain of their
 * own — only Facts/Links do, I3); a `connects_to` Link does, so `registerGatekeeperObject` takes
 * an explicit `activityId` from its caller rather than minting one itself (this module has no
 * opinion about what Activity a Gatekeeper registration belongs to — that is S2.13's call, the
 * same way every other Fact-writing call site in this codebase is handed an `activityId` rather
 * than inventing one, per `substrate/graph/store.ts`'s own `AssertFactInput`).
 */

const graphStore = new SqlGraphStore();

// -------------------------------------------------------------------------------------------
// WorkerDefinition (application/worker/definitions.ts calls this from `publish()` — publish-time
// only, never for a draft: every WorkerDefinition Object in `objects` is therefore non-draft by
// construction, which is exactly what the I16 guard on the graph write path relies on, see
// application/gateway/meta-ontology-guard.ts's own doc comment).
// -------------------------------------------------------------------------------------------

export interface WorkerDefinitionObjectInput {
  readonly definitionId: string;
  readonly version: number;
  readonly kind: 'entry' | 'worker';
  /** S2.7: the definition content's own `name`/`description` (`packages/shared/src/worker-
   *  definition.ts`), when present — carried into `properties` purely so `find_workers`
   *  (`substrate/graph/find-means.ts`) has text to rank a `need` query against; never interpreted
   *  by the kernel otherwise. */
  readonly name?: string;
  readonly description?: string;
}

/** Upserts (by `{definitionId, version}` identity — idempotent, matching this module's doc
 *  comment: a published WorkerDefinition version's graph projection is written once and never
 *  changes) the `WorkerDefinition` Object for a just-published version. */
export async function projectWorkerDefinitionObject(
  client: PoolClient,
  workspaceId: string,
  input: WorkerDefinitionObjectInput,
): Promise<GraphObject> {
  const properties: Record<string, unknown> = { kind: input.kind };
  if (input.name !== undefined) properties.name = input.name;
  if (input.description !== undefined) properties.description = input.description;
  return graphStore.upsertObject(client, workspaceId, {
    objectType: 'WorkerDefinition',
    identity: { definitionId: input.definitionId, version: input.version },
    properties,
  });
}

// -------------------------------------------------------------------------------------------
// Gatekeeper (for S2.13's connection service to call — deliverable 6, unit-tested here ahead of
// that task landing).
// -------------------------------------------------------------------------------------------

export interface RegisterGatekeeperObjectInput {
  /** Omit to register a brand-new Gatekeeper instance; given, re-registers (upserts) the same
   *  one — same idempotency shape as `projectWorkerDefinitionObject`. */
  readonly gatekeeperId?: string;
  readonly transportKind: 'http' | 'mcp' | 'cli' | 'ssh';
  /** Human-readable connection target (design doc `ConnectionCreatedEvent.target`,
   *  packages/shared/src/events.ts) — never a credential. */
  readonly target: string;
  /** A short, stable name for this Gatekeeper instance (e.g. the接入包's own name) — used to build
   *  `request_action`'s `action_kind` (`<name>.<operation>`, governance/gatekeepers) and shown in
   *  approval cards. Not part of the identity key (a Gatekeeper may be renamed without changing
   *  which instance it is); defaults to the gatekeeper object id string when omitted. */
  readonly name?: string;
  /** The gatekeeper server's own base URL (S2.4: "Config for the endpoint may live on the
   *  object's properties for now (S2.13 will store connection details)"). Never a credential —
   *  those stay inside the gate process (I9). */
  readonly endpoint?: string;
  /** The Object id of the connected system (§5.1.4 Connection "产生 Gatekeeper 实例对象、系统对象与
   *  connects_to 边") — already created by the caller before this call. */
  readonly systemObjectId: string;
  /** I3: every Fact must trace to the Activity that produced it — see this module's doc comment
   *  for why this function accepts one rather than minting it. */
  readonly activityId: string;
  /** Who is registering this Gatekeeper (design doc: `create_connection` is human/owner-only) —
   *  becomes the `connects_to` Fact's `asserted_by` / epistemic_status source. */
  readonly registeredBy: { readonly id: string; readonly kind: PrincipalKind };
}

export interface RegisterGatekeeperObjectResult {
  readonly gatekeeperObjectId: string;
  readonly connectsToFactId: string;
}

/** Writes the `Gatekeeper` Object and its `connects_to` Link to `systemObjectId` (design doc
 *  §5.1.2, deliverable 6 — "a small helper ... for S2.13 to call"). */
export async function registerGatekeeperObject(
  client: PoolClient,
  workspaceId: string,
  input: RegisterGatekeeperObjectInput,
): Promise<RegisterGatekeeperObjectResult> {
  const gatekeeperObject = await graphStore.upsertObject(client, workspaceId, {
    objectType: 'Gatekeeper',
    identity: input.gatekeeperId ? { gatekeeperId: input.gatekeeperId } : undefined,
    properties: {
      transportKind: input.transportKind,
      target: input.target,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
    },
  });

  const connectsToFact = await graphStore.assertFact(
    client,
    workspaceId,
    { id: input.registeredBy.id, kind: input.registeredBy.kind },
    {
      linkType: 'connects_to',
      sourceObjectId: gatekeeperObject.id,
      targetObjectId: input.systemObjectId,
      activityId: input.activityId,
    },
  );

  return { gatekeeperObjectId: gatekeeperObject.id, connectsToFactId: connectsToFact.id };
}

// -------------------------------------------------------------------------------------------
// Operation (for governance/gatekeepers to call — S2.4 deliverable, the接入包-agnostic manifest
// registry). Design doc §9.2 "operations 作为平台元本体存于 objects / links，状态与版本在
// properties" — unlike WorkerDefinition, an Operation has no dedicated relational table; its
// `draft -> published -> deprecated` status (I16/I17) lives entirely in the Object's `properties`.
// These are, like the two helpers above, projections with no transition logic of their own —
// `governance/gatekeepers/manifest.ts` is what checks PUBLISHABLE_TRANSITIONS before calling
// `setOperationStatusObject`, and what decides *which* existing row a draft write may replace
// (I16); `registerOperationDraftObject` only provides the atomic conditional write that decision
// is expressed through (see its own doc comment).
//
// **Revision versioning (S3.12, closing the "propose on a published Operation always 409s" gap —
// docs/runbooks/web-console.md known-gap #11, docs/development-tasks.md S3.12 note)**: the
// identity key gained a third field, `version`, following the exact convention
// `projectWorkerDefinitionObject`/`projectSkillObject`/`projectProcedureObject` above already use
// (`{id, version}`) — multiple `Operation` rows may now coexist for the same `(gatekeeperId, name)`
// (e.g. a `published` v1 and a `draft` v2 revision proposed against it), instead of one row
// upserted in place forever. No migration was needed: `identity_key` is a generic `jsonb` column
// (`objects_identity_key_uidx`, migrations/core/0006_object_identity.sql) — this is purely a
// change to what JSON shape callers construct. `governance/gatekeepers/manifest.ts` (`getOperation`
// et al.) is what decides which version is "current" for a given read; this module still only
// projects whatever identity/version it is handed.
// -------------------------------------------------------------------------------------------

/** The Operation Object's identity key — `(gatekeeperId, name, version)`, scoped to one Gatekeeper
 *  instance's own manifest. `gatekeeperId` here is the Gatekeeper *Object*'s id (not its
 *  human-readable `name` property, which may change). `version` starts at 1 and increments by one
 *  per revision (`governance/gatekeepers/manifest.ts`'s `proposeOperation`) — never reused, even
 *  across a `deprecated` row, so `{gatekeeperId, name, version}` is a stable, permanent reference
 *  (a draft's own `draftOf` property, and a `publish_operation` Activity's `supersedes` metadata,
 *  both point at a specific row by its Object id, not by re-deriving this key). */
export interface OperationIdentity {
  readonly gatekeeperId: string;
  readonly name: string;
  readonly version: number;
}

/**
 * Which channel wrote the current draft (stored as `properties.origin`; review 2026-09 — docs/
 * development-tasks.md S2.4 "实现说明补充"): `'import'` is the manifest a gate itself declared
 * (`importManifest` — owner/CLI/`create_connection`); `'agent'`/`'human'` is a `propose_operation`
 * proposal (Handle channel; a human caller of that same capability produces `'human'`). The
 * distinction is authority, not provenance flavor: `publish_manifest` bulk-publishes only
 * `'import'` drafts, and the Handle channel may only ever replace an `'agent'`/`'human'` draft of
 * its own — never an `'import'` one, which is not any proposer's private draft.
 */
export type OperationOrigin = 'import' | 'agent' | 'human';

export interface RegisterOperationDraftInput extends OperationIdentity {
  readonly operation: Operation;
  /** `propose_operation`/manifest import is Handle-channel-legal (I16: drafts only) — the
   *  proposer becomes the `exposes` Fact's `asserted_by`, and is persisted on the draft itself
   *  (`properties.proposedBy` / `proposedByKind`) so a later proposal over the same identity can
   *  be checked against it (I16 "修改他人草稿一律拒绝"). */
  readonly proposedBy: { readonly id: string; readonly kind: PrincipalKind };
  readonly activityId: string;
  readonly origin: OperationOrigin;
  /**
   * Conditional-write guard chosen by the caller (`governance/gatekeepers/manifest.ts`): an
   * existing row is only ever replaced when it is currently a `draft` — a `published`/`deprecated`
   * row is never written by this function, whatever the caller passes. When this is set, the
   * existing draft must additionally carry `proposedBy` equal to it *and* an `origin` of
   * `'agent'`/`'human'` (the Handle channel's own-draft rule); when omitted, any draft may be
   * replaced (the owner/CLI import path).
   */
  readonly onlyOwnDraftOf?: string;
  /**
   * S3.12 revision path only: the Object id of the `published` Operation row this draft was
   * proposed against (`governance/gatekeepers/manifest.ts`'s `proposeOperation`, when the current
   * row for the identity is `published` rather than a conflicting draft) — stashed on the draft's
   * own `properties.draftOf` so `publishOperation` can deprecate that exact row, in the same
   * transaction it publishes this one, without re-deriving which version it supersedes. Absent for
   * a fresh v1 draft or an in-place same-version redraft.
   */
  readonly draftOf?: string;
}

export interface OperationObjectResult {
  readonly operationObjectId: string;
  readonly exposesFactId: string;
  readonly status: PublishableStatus;
}

/**
 * Inserts a draft `Operation` Object holding the full manifest entry (plus `status: 'draft'`,
 * `origin`, `proposedBy`, `proposedByKind`), and asserts the `Gatekeeper --exposes--> Operation`
 * Fact (design doc §5.1.2). Returns `null` — and asserts no Fact — when the identity already
 * exists and the existing row is not one this write is allowed to replace (see
 * `RegisterOperationDraftInput.onlyOwnDraftOf`).
 *
 * Why a hand-written conditional upsert rather than `graphStore.upsertObject` (review 2026-09,
 * P0): the generic upsert *merges* properties over whatever row holds the identity, and cannot
 * express "insert only" or "update only if the current row satisfies X". A read in
 * `manifest.ts` followed by that unconditional write left a window in which a Handle-channel
 * proposal could demote a `published` Operation to `draft` and rewrite its policy inputs (`mode`,
 * `blast_radius`, `auto_approvable`) — the owner's next `publish_manifest` then republished the
 * attacker's values. `ON CONFLICT DO UPDATE ... WHERE` evaluates the guard against the row
 * version the conflict locked, so two dispatch transactions racing on the same identity cannot
 * both pass a check one of them performed earlier; the caller's own pre-read (`manifest.ts`) is
 * kept only to report *why* (the existing row's status) in its error. On replace, `properties`
 * is set to the new value rather than merged — a re-proposal is the proposer's whole revised
 * definition, and a stale key left over from the previous draft would otherwise survive.
 *
 * Re-registering the same identity legitimately (an owner re-importing an unchanged manifest, a
 * proposer revising its own draft) asserts a fresh `exposes` Fact each time — Facts are
 * append-only observations, not deduplicated relationships, so a repeat registration leaving an
 * extra `exposes` edge is consistent with the rest of this Domain Model, not a bug to work around
 * here.
 */
export async function registerOperationDraftObject(
  client: PoolClient,
  workspaceId: string,
  input: RegisterOperationDraftInput,
): Promise<OperationObjectResult | null> {
  const properties: Record<string, unknown> = {
    ...input.operation,
    status: 'draft',
    origin: input.origin,
    proposedBy: input.proposedBy.id,
    proposedByKind: input.proposedBy.kind,
    version: input.version,
    ...(input.draftOf !== undefined ? { draftOf: input.draftOf } : {}),
  };
  const result = await client.query<{ id: string }>(
    `insert into objects (workspace_id, object_type, identity_key, properties)
     values ($1, 'Operation', $2::jsonb, $3::jsonb)
     on conflict (workspace_id, object_type, identity_key) where identity_key is not null
     do update set properties = excluded.properties, updated_at = now()
     where objects.properties ->> 'status' = 'draft'
       and (
         $4::text is null
         or (
           objects.properties ->> 'proposedBy' = $4
           and objects.properties ->> 'origin' in ('agent', 'human')
         )
       )
     returning id`,
    [
      workspaceId,
      JSON.stringify({
        gatekeeperId: input.gatekeeperId,
        name: input.name,
        version: input.version,
      }),
      JSON.stringify(properties),
      input.onlyOwnDraftOf ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;

  const exposesFact = await graphStore.assertFact(
    client,
    workspaceId,
    { id: input.proposedBy.id, kind: input.proposedBy.kind },
    {
      linkType: 'exposes',
      sourceObjectId: input.gatekeeperId,
      targetObjectId: row.id,
      activityId: input.activityId,
    },
  );

  return { operationObjectId: row.id, exposesFactId: exposesFact.id, status: 'draft' };
}

// -------------------------------------------------------------------------------------------
// Skill / Procedure (application/worker/skills.ts and procedures.ts call these from their own
// `publish()` — publish-time only, mirroring `projectWorkerDefinitionObject` above: every Skill/
// Procedure Object in `objects` is therefore non-draft by construction, S2.14).
// -------------------------------------------------------------------------------------------

export interface SkillObjectInput {
  readonly skillId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
}

/** Upserts (by `{skillId, version}` identity) the `Skill` Object for a just-published version
 *  (design doc §5.1.2 Skill; docs/development-tasks.md S2.14). `properties` deliberately excludes
 *  `markdown` — the graph Object is a *discovery* projection (`find_procedures`/`list_skills`
 *  text-match ranking, `substrate/graph/find-means.ts`), not the mounting source of truth
 *  (`application/worker/skills.ts`'s `skills` table row is; mounting reads that table directly,
 *  never this projection). */
export async function projectSkillObject(
  client: PoolClient,
  workspaceId: string,
  input: SkillObjectInput,
): Promise<GraphObject> {
  return graphStore.upsertObject(client, workspaceId, {
    objectType: 'Skill',
    identity: { skillId: input.skillId, version: input.version },
    properties: { name: input.name, description: input.description },
  });
}

export interface ProcedureObjectInput {
  readonly procedureId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
}

/** Upserts (by `{procedureId, version}` identity) the `Procedure` Object for a just-published
 *  version (design doc §5.1.2 Procedure; docs/development-tasks.md S2.14). Same "discovery
 *  projection, not the source of truth" note as `projectSkillObject` — `properties` excludes
 *  `steps` (the `procedures` table row is authoritative; `Procedure --steps--> …` Links, asserted
 *  separately by the caller via `SqlGraphStore.assertFact`, are what `find_procedures`/`traverse`
 *  actually walk). */
export async function projectProcedureObject(
  client: PoolClient,
  workspaceId: string,
  input: ProcedureObjectInput,
): Promise<GraphObject> {
  return graphStore.upsertObject(client, workspaceId, {
    objectType: 'Procedure',
    identity: { procedureId: input.procedureId, version: input.version },
    properties: { name: input.name, description: input.description },
  });
}

/** Merges `{status}` into one specific, already-versioned Operation Object's properties
 *  (publish/deprecate — targets exactly the `{gatekeeperId, name, version}` row `identity` names,
 *  never "whichever row currently has this name", which matters once a `published` row and a
 *  revision `draft` row can coexist for the same identity, S3.12). Callers must have already
 *  confirmed the Object exists and the transition is legal (`governance/gatekeepers/manifest.ts`
 *  reads it first and runs it through `PUBLISHABLE_TRANSITIONS`) — this function does not check
 *  either, matching `upsertObject`'s own "no identity → always insert" behavior: calling this for
 *  an identity that does not yet exist would silently create an incomplete Object rather than
 *  erroring, which is exactly the mistake callers are expected to avoid by reading first. Also
 *  used, unchanged, to deprecate the *superseded* version when `publishOperation` publishes a
 *  revision draft — same function, just called a second time against the old row's own identity. */
export async function setOperationStatusObject(
  client: PoolClient,
  workspaceId: string,
  identity: OperationIdentity,
  status: PublishableStatus,
): Promise<GraphObject> {
  return graphStore.upsertObject(client, workspaceId, {
    objectType: 'Operation',
    identity: {
      gatekeeperId: identity.gatekeeperId,
      name: identity.name,
      version: identity.version,
    },
    properties: { status },
  });
}
