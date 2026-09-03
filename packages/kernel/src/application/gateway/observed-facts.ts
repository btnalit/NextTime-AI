import type { PoolClient } from 'pg';
import { getOrCreateGatekeeperServicePrincipal } from '../../governance/gatekeepers/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import type { Fact, GraphObject } from '../../substrate/graph/index.js';

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
 */

const graphStore = new SqlGraphStore();

export interface ObservedFactCandidateInput {
  readonly objectType: string;
  readonly identity: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
}

export interface WrittenObservedFact {
  readonly object: GraphObject;
  readonly fact: Fact;
}

/** Writes every candidate; returns the created (Object, Fact) pairs in the same order. Empty
 *  `candidates` is a no-op (does not even resolve the service Principal). */
export async function writeObservedFacts(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
  candidates: readonly ObservedFactCandidateInput[],
  activityId: string,
): Promise<readonly WrittenObservedFact[]> {
  if (candidates.length === 0) return [];

  const servicePrincipalId = await getOrCreateGatekeeperServicePrincipal(client, workspaceId);
  const written: WrittenObservedFact[] = [];

  for (const candidate of candidates) {
    if (Object.keys(candidate.identity).length === 0) continue; // nothing to upsert by
    const object = await graphStore.upsertObject(client, workspaceId, {
      objectType: candidate.objectType,
      identity: candidate.identity,
      properties: candidate.properties ?? {},
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
      },
    );
    written.push({ object, fact });
  }

  return written;
}
