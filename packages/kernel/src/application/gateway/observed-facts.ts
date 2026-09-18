import type { PoolClient } from 'pg';
import { getOrCreateGatekeeperServicePrincipal } from '../../governance/gatekeepers/index.js';
import { recordSourceObservation, registerSource } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import type { AssertFactResult, GraphObject } from '../../substrate/graph/index.js';

/**
 * application/gateway/observed-facts: writes a Gatekeeper's `observe`/`apply` result's
 * `observedFacts` candidates (`@nexttime/gatekeeper-base`'s `{objectType, identity, properties}`
 * shape, from an Operation's `result_mapping`) into the graph as `observed` Facts (design doc
 * §5.1.4/§7.5 "门返回时内核写为 observed Fact"; docs/development-tasks.md S2.4).
 *
 * Each candidate becomes: an upserted target Object (`objectType`/`identity`/`properties`), and a
 * `Gatekeeper --observed--> target` Link asserted by the shared Gatekeeper service Principal
 * (`governance/gatekeepers`'s `getOrCreateGatekeeperServicePrincipal`) — the one `CallerPrincipal
 * .kind` that makes `substrate/graph/store.ts`'s `deriveEpistemicStatus` produce `'observed'`
 * (§5.6), independent of which actual Handle/Principal invoked `request_action`. I3's own
 * `activity_id` requirement is the caller's — every call site here already has one open (the
 * Activity `request_action`'s observe path, or the apply-execution Activity `action-executor.ts`
 * starts around each `apply`).
 *
 * **S5.2 — every gate observation names its Source (I-S5-2).** Each Gatekeeper has one epistemic
 * Source of `kind: 'gatekeeper'` (owned by the shared service Principal, `workspace` visibility,
 * `metadata.gatekeeperId` = the Gatekeeper Object's id; created lazily under a transaction-scoped
 * advisory lock so two concurrent first observations by the same gate register one Source), and
 * every call here records one Observation of it on the caller's Activity and passes it to
 * `assertFact` as the Facts' `observationId`. Consequences, all deliberate:
 *   - `explain` on a gate-written Fact reaches the gate through the Observation (before S5.2 the
 *     Activity carried no Observation at all — the Fact's provenance stopped at the shared
 *     principal), and the same gate seeing the same target again advances the Fact's
 *     `lastObservation*` clock (migrations/core/0026) instead of being a silent no-op;
 *   - the origin `resolveFactOrigin` compares (substrate/epistemic/conflicts.ts) is now the gate's
 *     Source, not the shared principal. Nothing observable changes for `observed` Links themselves
 *     — their identity already starts at the Gatekeeper Object, so two gates never share an
 *     identity — but a Fact written *before* S5.2 (no Observation, origin = the shared principal)
 *     is a different origin from the same gate's next observation: with identical content (always,
 *     these Facts carry no properties) the old row is returned `unchanged` and never touched, so it
 *     keeps its pre-S5.2 provenance and never gains a `lastObservedAt`. `invalidate_fact` on such a
 *     row makes the gate's next observation write a fresh, Source-backed one.
 * No observation window is declared here: a gate's `observe` is one Operation's answer, never a
 * complete view of a type.
 */

const graphStore = new SqlGraphStore();

const GATEKEEPER_SOURCE_KIND = 'gatekeeper';

export interface ObservedFactCandidateInput {
  readonly objectType: string;
  readonly identity: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
}

export interface WrittenObservedFact {
  readonly object: GraphObject;
  /** `unchanged: true` when the gate re-observed an already-recorded Fact (its clock advanced). */
  readonly fact: AssertFactResult;
}

interface SourceIdRow {
  id: string;
}

async function findGatekeeperSource(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
): Promise<string | undefined> {
  const found = await client.query<SourceIdRow>(
    `select id from sources
      where workspace_id = $1 and kind = $2 and metadata ->> 'gatekeeperId' = $3
      order by created_at limit 1`,
    [workspaceId, GATEKEEPER_SOURCE_KIND, gatekeeperObjectId],
  );
  return found.rows[0]?.id;
}

/** The Gatekeeper's own epistemic Source (see module doc comment), created on first use. Same
 *  select → advisory lock → re-select → insert shape as `SqlGraphStore.assertFact`'s first-time
 *  identity path: `sources` has no unique key on `(kind, metadata.gatekeeperId)` (S5.3 adds the
 *  `name` column and its index), and steady-state calls never take the lock. */
export async function getOrCreateGatekeeperSource(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
  ownerPrincipalId: string,
): Promise<string> {
  const existing = await findGatekeeperSource(client, workspaceId, gatekeeperObjectId);
  if (existing) return existing;
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `${workspaceId}:gatekeeper-source:${gatekeeperObjectId}`,
  ]);
  const raced = await findGatekeeperSource(client, workspaceId, gatekeeperObjectId);
  if (raced) return raced;
  const source = await registerSource(client, workspaceId, {
    kind: GATEKEEPER_SOURCE_KIND,
    ownerPrincipalId,
    visibility: 'workspace',
    metadata: { name: gatekeeperObjectId, gatekeeperId: gatekeeperObjectId },
  });
  return source.id;
}

/** Writes every candidate; returns the created (Object, Fact) pairs in the same order. Empty
 *  `candidates` is a no-op (does not even resolve the service Principal or record an
 *  Observation). */
export async function writeObservedFacts(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
  candidates: readonly ObservedFactCandidateInput[],
  activityId: string,
): Promise<readonly WrittenObservedFact[]> {
  if (candidates.length === 0) return [];

  const servicePrincipalId = await getOrCreateGatekeeperServicePrincipal(client, workspaceId);
  const sourceId = await getOrCreateGatekeeperSource(
    client,
    workspaceId,
    gatekeeperObjectId,
    servicePrincipalId,
  );
  const observation = await recordSourceObservation(client, workspaceId, { sourceId, activityId });
  const observedAt = new Date();
  const written: WrittenObservedFact[] = [];

  for (const candidate of candidates) {
    if (Object.keys(candidate.identity).length === 0) continue; // nothing to upsert by
    const object = await graphStore.upsertObject(client, workspaceId, {
      objectType: candidate.objectType,
      identity: candidate.identity,
      properties: candidate.properties ?? {},
      observedAt,
    });
    const fact = await graphStore.assertFact(
      client,
      workspaceId,
      { id: servicePrincipalId, kind: 'service' },
      {
        linkType: 'observed',
        sourceObjectId: gatekeeperObjectId,
        targetObjectId: object.id,
        activityId,
        observationId: observation.id,
      },
    );
    written.push({ object, fact });
  }

  return written;
}
