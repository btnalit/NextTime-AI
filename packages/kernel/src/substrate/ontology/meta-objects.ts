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
// These are, like the two helpers above, dumb projections with no policy/transition logic of
// their own — `governance/gatekeepers/manifest.ts` is what checks PUBLISHABLE_TRANSITIONS before
// calling `setOperationStatusObject`, and what enforces I16 (draft-only on the Handle channel).
// -------------------------------------------------------------------------------------------

/** The Operation Object's identity key — `(gatekeeperId, name)`, scoped to one Gatekeeper
 *  instance's own manifest. `gatekeeperId` here is the Gatekeeper *Object*'s id (not its
 *  human-readable `name` property, which may change). */
export interface OperationIdentity {
  readonly gatekeeperId: string;
  readonly name: string;
}

export interface RegisterOperationDraftInput extends OperationIdentity {
  readonly operation: Operation;
  /** `propose_operation`/manifest import is Handle-channel-legal (I16: drafts only) — the
   *  proposer becomes the `exposes` Fact's `asserted_by`. */
  readonly proposedBy: { readonly id: string; readonly kind: PrincipalKind };
  readonly activityId: string;
}

export interface OperationObjectResult {
  readonly operationObjectId: string;
  readonly exposesFactId: string;
  readonly status: PublishableStatus;
}

/** Upserts (by `{gatekeeperId, name}` identity) a draft `Operation` Object holding the full
 *  manifest entry, and asserts the `Gatekeeper --exposes--> Operation` Fact (design doc §5.1.2).
 *  Re-registering the same identity (e.g. re-importing an unchanged manifest) upserts the same
 *  Object (properties merge, `status` reset to `'draft'`) but does assert a fresh `exposes` Fact
 *  each call — Facts are append-only observations, not deduplicated relationships, so a repeat
 *  registration leaving an extra `exposes` edge is consistent with the rest of this Domain Model,
 *  not a bug to work around here. */
export async function registerOperationDraftObject(
  client: PoolClient,
  workspaceId: string,
  input: RegisterOperationDraftInput,
): Promise<OperationObjectResult> {
  const operationObject = await graphStore.upsertObject(client, workspaceId, {
    objectType: 'Operation',
    identity: { gatekeeperId: input.gatekeeperId, name: input.name },
    properties: { ...input.operation, status: 'draft' },
  });

  const exposesFact = await graphStore.assertFact(
    client,
    workspaceId,
    { id: input.proposedBy.id, kind: input.proposedBy.kind },
    {
      linkType: 'exposes',
      sourceObjectId: input.gatekeeperId,
      targetObjectId: operationObject.id,
      activityId: input.activityId,
    },
  );

  return { operationObjectId: operationObject.id, exposesFactId: exposesFact.id, status: 'draft' };
}

/** Merges `{status}` into an existing Operation Object's properties (publish/deprecate). Callers
 *  must have already confirmed the Object exists and the transition is legal
 *  (`governance/gatekeepers/manifest.ts` reads it first via `GraphStore.getObjectByIdentity` and
 *  runs it through `PUBLISHABLE_TRANSITIONS`) — this function does not check either, matching
 *  `upsertObject`'s own "no identity → always insert" behavior: calling this for an identity that
 *  does not yet exist would silently create an incomplete Object rather than erroring, which is
 *  exactly the mistake callers are expected to avoid by reading first. */
export async function setOperationStatusObject(
  client: PoolClient,
  workspaceId: string,
  identity: OperationIdentity,
  status: PublishableStatus,
): Promise<GraphObject> {
  return graphStore.upsertObject(client, workspaceId, {
    objectType: 'Operation',
    identity: { gatekeeperId: identity.gatekeeperId, name: identity.name },
    properties: { status },
  });
}
