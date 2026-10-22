import { CHANGE_ROLLBACK_IN_USE_CAP } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type GraphTypeUsage, countGraphTypeUsage } from '../../substrate/graph/index.js';
import { loadPublishedLinkTypeFamilies } from '../../substrate/ontology/index.js';

/**
 * application/change-plan/usage: how many graph rows use a type a change takes out of a
 * workspace's ontology — shown before a rollback (`rollback.ts`) or an install (`application/packs`)
 * is applied. The rows stay (S10 I-P4: data already written is never removed); new writes are
 * checked against the ontology without those types.
 */

/** Objects of `objectTypes` and active Facts of `linkTypes`, each count stopping at
 *  `CHANGE_ROLLBACK_IN_USE_CAP`. A LinkType name may be declared by several families (signatures
 *  accumulate, I-P1): a name a family outside `changedOntologyIds` declares is not taken out by the
 *  change, and is not counted. */
export async function countRemovedTypeUsage(
  client: PoolClient,
  workspaceId: string,
  removed: { readonly objectTypes: Iterable<string>; readonly linkTypes: Iterable<string> },
  changedOntologyIds: ReadonlySet<string>,
): Promise<GraphTypeUsage> {
  const objectTypes = new Set(removed.objectTypes);
  const linkTypes = new Set(removed.linkTypes);
  if (linkTypes.size > 0) {
    for (const [name, families] of await loadPublishedLinkTypeFamilies(client, workspaceId)) {
      if (families.some((id) => !changedOntologyIds.has(id))) linkTypes.delete(name);
    }
  }
  if (objectTypes.size === 0 && linkTypes.size === 0) {
    return { objects: 0, links: 0, capped: false };
  }
  return countGraphTypeUsage(
    client,
    workspaceId,
    { objectTypes: [...objectTypes], linkTypes: [...linkTypes] },
    CHANGE_ROLLBACK_IN_USE_CAP,
  );
}
