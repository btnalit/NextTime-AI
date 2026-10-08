import type { PoolClient } from 'pg';
import type { OntologyDefinition } from './schema.js';

/**
 * substrate/ontology/namespace: invariant I-P1 (docs/s10-evolution-plan-2026-10-04.md §3.3, STATUS
 * leftover 124) — within one workspace, an ObjectType name and an ActionType name each belong to
 * at most one published ontology family. Before this, `registry.ts`'s `mergeVisibleOntology` let
 * the family later by id silently replace a same-named type from another family, so a write was
 * checked against whichever definition happened to sort last. Only one domain pack existed, so it
 * never fired; capability packs make it reachable at once.
 *
 * Refuse, never override: both paths that make a version `published` — `loader.ts`'s
 * `publishOntologyVersion` (bootstrap seed, domain pack, `install_module` / `upgrade_module`) and
 * `registry.ts`'s `publishOntologyDraft` (`publish_ontology_version`) — call
 * `assertOntologyNamespace` with the definition about to become their family's head, under
 * `lockOntologyNamespace`, and nothing is written when it throws.
 *
 * Scope, deliberately the plan's and no wider:
 *  - LinkTypes may share a name across families; their signatures accumulate (unchanged).
 *  - Drafts are not part of the namespace: another principal's draft is invisible (I16), and a
 *    draft that collides is refused when it is published, not when it is proposed.
 *  - Names are unique per kind, not across kinds (an ObjectType and an ActionType may share a
 *    name, as `get_type`'s kind order already resolves).
 *  - Whether a type a family references belongs to a family it `requires` is P1's check, not this.
 */

export type OntologyNamespaceKind = 'object' | 'action';

export interface OntologyNamespaceConflict {
  readonly kind: OntologyNamespaceKind;
  readonly name: string;
  /** The family that already declares `name` — the candidate's own id when the candidate
   *  declares it twice. */
  readonly ontologyId: string;
}

export class OntologyNamespaceConflictError extends Error {
  readonly code = 'ontology_namespace_conflict' as const;
  readonly conflicts: readonly OntologyNamespaceConflict[];
  constructor(conflicts: readonly OntologyNamespaceConflict[]) {
    super(
      `ontology type names already taken in this workspace (I-P1): ${conflicts
        .map(
          (c) =>
            `${c.kind === 'object' ? 'ObjectType' : 'ActionType'} "${c.name}" (ontology ${c.ontologyId})`,
        )
        .join(', ')} — rename them, or change the family that declares them instead`,
    );
    this.name = 'OntologyNamespaceConflictError';
    this.conflicts = conflicts;
  }
}

/** Serializes every publish into one workspace's ontology until the transaction ends, so two
 *  families published concurrently cannot both pass `assertOntologyNamespace` with the same new
 *  name. Taken before any family lock (`loader.ts`'s `lockOntologyFamily` takes it first), so a
 *  transaction that publishes several families never waits on this lock while holding a family
 *  lock another publisher needs. Same `pg_advisory_xact_lock(hashtext(...))` convention. */
export async function lockOntologyNamespace(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `ontology_namespace:${workspaceId}`,
  ]);
}

/** Pure half: the conflicts `candidate` (about to become family `candidateId`'s published head)
 *  has with `others` (every other family's published head) and with itself. */
export function findOntologyNamespaceConflicts(
  candidateId: string | null,
  candidate: OntologyDefinition,
  others: readonly { readonly id: string; readonly definition: OntologyDefinition }[],
): OntologyNamespaceConflict[] {
  const owners = new Map<string, string>();
  for (const family of others) {
    if (family.id === candidateId) continue;
    for (const t of family.definition.objectTypes) owners.set(`object:${t.name}`, family.id);
    for (const t of family.definition.actionTypes ?? []) owners.set(`action:${t.name}`, family.id);
  }

  const conflicts: OntologyNamespaceConflict[] = [];
  const own = new Set<string>();
  const check = (kind: OntologyNamespaceKind, name: string): void => {
    const key = `${kind}:${name}`;
    const owner = owners.get(key);
    if (owner !== undefined) conflicts.push({ kind, name, ontologyId: owner });
    else if (own.has(key)) conflicts.push({ kind, name, ontologyId: candidateId ?? '(new)' });
    own.add(key);
  };
  for (const t of candidate.objectTypes) check('object', t.name);
  for (const t of candidate.actionTypes ?? []) check('action', t.name);
  return conflicts;
}

/** Throws `OntologyNamespaceConflictError` when publishing `candidate` as family `candidateId`'s
 *  head (null: a family that does not exist yet) would give an ObjectType or ActionType name a
 *  second owner in `workspaceId`. Compares against every other family's latest published version
 *  — the same "latest published per family" rule `loadPublishedLinkTypes` reads writes against.
 *  Caller holds `lockOntologyNamespace`. */
export async function assertOntologyNamespace(
  client: PoolClient,
  workspaceId: string,
  candidateId: string | null,
  candidate: OntologyDefinition,
): Promise<void> {
  const result = await client.query<{ id: string; definition: OntologyDefinition }>(
    `select t.id, t.definition
     from ontology_versions t
     where t.workspace_id = $1
       and t.status = 'published'
       and ($2::uuid is null or t.id <> $2::uuid)
       and t.version = (
         select max(t2.version)
         from ontology_versions t2
         where t2.workspace_id = t.workspace_id
           and t2.id = t.id
           and t2.status = 'published'
       )
     order by t.id`,
    [workspaceId, candidateId],
  );
  const conflicts = findOntologyNamespaceConflicts(candidateId, candidate, result.rows);
  if (conflicts.length > 0) throw new OntologyNamespaceConflictError(conflicts);
}
