import type { PrincipalKind } from '@nexttime/shared';
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
}

/** Upserts (by `{definitionId, version}` identity — idempotent, matching this module's doc
 *  comment: a published WorkerDefinition version's graph projection is written once and never
 *  changes) the `WorkerDefinition` Object for a just-published version. */
export async function projectWorkerDefinitionObject(
  client: PoolClient,
  workspaceId: string,
  input: WorkerDefinitionObjectInput,
): Promise<GraphObject> {
  return graphStore.upsertObject(client, workspaceId, {
    objectType: 'WorkerDefinition',
    identity: { definitionId: input.definitionId, version: input.version },
    properties: { kind: input.kind },
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
    properties: { transportKind: input.transportKind, target: input.target },
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
