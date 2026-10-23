import type { ChangeItemKind } from '@nexttime/shared';

/** The order a segment's item locks are taken in, whatever order its items are in — planning,
 *  applying and rolling back alike: the ontology's first (`lockOntologyFamily`: the workspace's
 *  ontology namespace, then the family), then the Skill and WorkerDefinition registry's
 *  (`application/worker`'s `lockWorkerRegistry`, which nothing that holds it follows with an
 *  ontology lock), then the workspace's Operation revisions' (`lockOperationRevision`, then each
 *  live row as its item is planned — publishing an Operation takes neither of the others). One
 *  order everywhere, so two transactions never wait on each other in a cycle — an install of a
 *  segment and a rollback of another (which plans its items last first) included. */
const LOCK_ORDER: Readonly<Record<ChangeItemKind, number>> = {
  ontology_version: 0,
  skill_version: 1,
  worker_definition_version: 1,
  operation_version: 2,
};

/** `items` in lock order (a stable sort: items of one kind keep their order). */
export function inLockOrder<T extends { readonly kind: ChangeItemKind }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => LOCK_ORDER[a.kind] - LOCK_ORDER[b.kind]);
}
