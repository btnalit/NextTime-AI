import { quotedName } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { loadOntologyFamilyNames } from './families.js';
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
 * `publishOntologyVersion` (bootstrap seed, domain pack, `install_module` / `upgrade_module`, a
 * pack's ontology item) and `registry.ts`'s `publishOntologyDraft` (`publish_ontology_version`) —
 * call `assertOntologyPublishable` with the definition about to become their family's head, under
 * `lockOntologyNamespace`, and nothing is written when it throws. A ChangePlan review
 * (`planOntologyItem`) and an ontology item's rollback (`planOntologyRollback`) run the same check
 * before they write anything.
 *
 * Legacy 303 (the plan's "P1 起另加" half of I-P1, without its `requires` scoping): every
 * LinkType's `domain` and `range` is `"*"` or names an ObjectType some published family declares —
 * the candidate itself or another family's head (`ops-assets` v2's `served_by` ends at
 * platform-meta's `Gatekeeper`, so a reference across families is legal). Two ways to break it,
 * both refused with `OntologyLinkEndpointError`:
 *  - the candidate's own LinkType names a type nobody declares (a typo, a type from a family not
 *    installed here): `undeclared`;
 *  - the candidate drops an ObjectType its family declares now that another family's LinkType
 *    still names: `orphaned`. A reference that already named nothing before this publish is not
 *    the candidate's to answer for — it is that other family's own `undeclared` at its next publish.
 * Without this, a published LinkType could name a type no Object can have, and the write guard
 * (`substrate/graph/ontology-guard.ts`, I2) would be checking Links against a signature that says
 * nothing. Whether the type belongs to a family the referring pack `requires` is checked only for
 * a pack's install (legacy 705, below): a draft published from the console belongs to no pack.
 *
 * Legacy 705 (L1), a pack's install or upgrade only (`application/packs/install.ts`, a module's
 * too): its LinkType ends name ObjectTypes of the platform-meta ontology, of its own families, or of
 * the packs its version requires directly (`requires.packs`) — `OntologyLinkEndpointScope`, the ids
 * of those families; their heads as this segment will have left them (`pending`), so a family the
 * same segment installs counts as it will be. Not transitive: a type of a pack reached only through
 * another required pack is refused, as most package managers want direct dependencies declared.
 * Refused with `OntologyLinkEndpointOutsideRequiresError`, after legacy 303 (a type nobody declares
 * is that refusal, not this one). It is a gate at install, not a standing invariant: a required
 * pack upgraded later may move a type elsewhere without the referring pack being checked again —
 * 303 and I-P1 still keep every end declared, by one family.
 *
 * Scope, deliberately the plan's and no wider:
 *  - LinkTypes may share a name across families; their signatures accumulate (unchanged).
 *  - Drafts are not part of the namespace: another principal's draft is invisible (I16), and a
 *    draft that collides is refused when it is published, not when it is proposed.
 *  - Names are unique per kind, not across kinds (an ObjectType and an ActionType may share a
 *    name, as `get_type`'s kind order already resolves).
 *  - A LinkType end is checked against the published namespace too (legacy 303, above), and at a
 *    pack's install against the families it may name (legacy 705, above).
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

export type OntologyLinkEnd = 'domain' | 'range';

/** One LinkType end naming an ObjectType that no published family would declare. */
export interface OntologyLinkEndpointProblem {
  /** The family whose LinkType it is — `null`: the candidate, when it is a family not published
   *  yet. */
  readonly ontologyId: string | null;
  readonly linkType: string;
  readonly end: OntologyLinkEnd;
  readonly objectType: string;
}

/** A problem as `OntologyLinkEndpointError` reports it: with what to call the family whose
 *  LinkType it is (UX acceptance of #1141 — "another ontology" alone does not say which). */
export interface NamedOntologyLinkEndpointProblem extends OntologyLinkEndpointProblem {
  /** The family's name (`ontology_families`, legacy 706: `platform-meta`, a pack's or module's
   *  family, an admin proposal's, a command-line seed's) — null when it has none: a family
   *  published from a console draft, or one this very publish creates. */
  readonly family: string | null;
}

export interface OntologyLinkEndpointProblems<
  P extends OntologyLinkEndpointProblem = OntologyLinkEndpointProblem,
> {
  /** The candidate's own LinkType ends naming a type neither it nor another family's head
   *  declares. */
  readonly undeclared: readonly P[];
  /** Another family's LinkType ends naming a type the candidate's family declares now and the
   *  candidate no longer does. */
  readonly orphaned: readonly P[];
}

const describeEnd = (p: OntologyLinkEndpointProblem): string =>
  `LinkType ${quotedName(p.linkType)} ${p.end} ${quotedName(p.objectType)}`;

/** Legacy 303: publishing the candidate would leave a LinkType end naming an ObjectType no
 *  published family declares. Mapped to 409 `ontology_link_endpoint_undeclared` (with the two
 *  lists in `details`); nothing was published. */
export class OntologyLinkEndpointError extends Error {
  readonly code = 'ontology_link_endpoint_undeclared' as const;
  readonly problems: OntologyLinkEndpointProblems<NamedOntologyLinkEndpointProblem>;
  constructor(problems: OntologyLinkEndpointProblems<NamedOntologyLinkEndpointProblem>) {
    const parts: string[] = [];
    if (problems.undeclared.length > 0) {
      parts.push(
        `${problems.undeclared.map(describeEnd).join(', ')} ${problems.undeclared.length === 1 ? 'names' : 'name'} no ObjectType this workspace's ontology declares`,
      );
    }
    if (problems.orphaned.length > 0) {
      parts.push(
        `${problems.orphaned
          .map((p) => `${describeEnd(p)} (ontology ${p.family ?? p.ontologyId})`)
          .join(', ')} would name an ObjectType this version removes`,
      );
    }
    super(
      `ontology LinkType ends must name a declared ObjectType or "*": ${parts.join('; ')} — declare the type, or change the LinkType`,
    );
    this.name = 'OntologyLinkEndpointError';
    this.problems = problems;
  }
}

/** Legacy 705 (L1): the families a pack's install may name in its LinkType ends besides the
 *  candidate's own — the platform-meta ontology's, the version's other families and those of the
 *  packs it requires directly — by id. */
export interface OntologyLinkEndpointScope {
  readonly familyIds: ReadonlySet<string>;
}

/** One of the candidate's LinkType ends naming an ObjectType declared outside its scope. */
export interface OntologyLinkEndpointOutsideScope {
  readonly linkType: string;
  readonly end: OntologyLinkEnd;
  readonly objectType: string;
  /** The family that declares `objectType`. */
  readonly declaredBy: string;
}

/** As `OntologyLinkEndpointOutsideRequiresError` reports it. */
export interface NamedOntologyLinkEndpointOutsideScope extends OntologyLinkEndpointOutsideScope {
  /** `declaredBy`'s name (`ontology_families`), null when it has none. */
  readonly family: string | null;
  /** The pack that has that family, when the install knows one: the pack to require. */
  readonly pack: string | null;
}

/** Legacy 705: a pack's LinkType end names an ObjectType of a family it does not require (see this
 *  module's comment). Mapped to 409 `ontology_link_endpoint_outside_requires` (`details.ends`);
 *  nothing was published. */
export class OntologyLinkEndpointOutsideRequiresError extends Error {
  readonly code = 'ontology_link_endpoint_outside_requires' as const;
  readonly ends: readonly NamedOntologyLinkEndpointOutsideScope[];
  constructor(ends: readonly NamedOntologyLinkEndpointOutsideScope[]) {
    super(
      `a pack's LinkType ends name ObjectTypes of the platform-meta ontology, of its own families or of the packs it requires: ${ends
        .map(
          (e) =>
            `${describeEnd({ ...e, ontologyId: null })} is declared by ontology family ${e.family === null ? e.declaredBy : quotedName(e.family)}${e.pack === null ? '' : ` (pack ${quotedName(e.pack)})`}`,
        )
        .join(', ')} — add the pack that has it to requires.packs`,
    );
    this.name = 'OntologyLinkEndpointOutsideRequiresError';
    this.ends = ends;
  }

  /** The same refusal, each end saying which pack has the family that declares its type. */
  withPacks(
    packOf: (family: string) => string | undefined,
  ): OntologyLinkEndpointOutsideRequiresError {
    return new OntologyLinkEndpointOutsideRequiresError(
      this.ends.map((e) => ({ ...e, pack: e.family === null ? null : (packOf(e.family) ?? null) })),
    );
  }
}

/** Serializes every publish into one workspace's ontology until the transaction ends, so two
 *  families published concurrently cannot both pass `assertOntologyPublishable` with the same new
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

/** Pure half of legacy 303: the LinkType ends that would name no declared ObjectType once
 *  `candidate` replaces `current` (its family's published head now; `null`: none) beside `others`
 *  (every other family's published head). `"*"` names any type. Each end is listed once. */
export function findOntologyLinkEndpointProblems(
  candidateId: string | null,
  candidate: OntologyDefinition,
  current: OntologyDefinition | null,
  others: readonly { readonly id: string; readonly definition: OntologyDefinition }[],
): OntologyLinkEndpointProblems {
  const otherFamilies = others.filter((family) => family.id !== candidateId);
  const declaredElsewhere = new Set<string>();
  for (const family of otherFamilies) {
    for (const t of family.definition.objectTypes) declaredElsewhere.add(t.name);
  }
  const declaredByCandidate = new Set(candidate.objectTypes.map((t) => t.name));
  const declaredAfter = (name: string): boolean =>
    declaredByCandidate.has(name) || declaredElsewhere.has(name);
  const removed = new Set(
    (current?.objectTypes ?? []).map((t) => t.name).filter((name) => !declaredAfter(name)),
  );

  const collect = (
    ontologyId: string | null,
    definition: OntologyDefinition,
    fails: (objectType: string) => boolean,
  ): OntologyLinkEndpointProblem[] => {
    const seen = new Set<string>();
    const problems: OntologyLinkEndpointProblem[] = [];
    for (const linkType of definition.linkTypes) {
      for (const end of ['domain', 'range'] as const) {
        const objectType = linkType[end];
        if (objectType === '*' || !fails(objectType)) continue;
        const key = JSON.stringify([linkType.name, end, objectType]);
        if (seen.has(key)) continue;
        seen.add(key);
        problems.push({ ontologyId, linkType: linkType.name, end, objectType });
      }
    }
    return problems;
  };

  return {
    undeclared: collect(candidateId, candidate, (name) => !declaredAfter(name)),
    orphaned: otherFamilies.flatMap((family) =>
      collect(family.id, family.definition, (name) => removed.has(name)),
    ),
  };
}

/** Pure half of legacy 705: the candidate's own LinkType ends naming an ObjectType that a family
 *  outside `scope` declares (the candidate's own family is always inside). An end naming `"*"`, a
 *  type the candidate declares, or a type nobody declares (legacy 303's) is not listed. Each end
 *  once. */
export function findOntologyLinkEndpointsOutsideScope(
  candidateId: string | null,
  candidate: OntologyDefinition,
  others: readonly { readonly id: string; readonly definition: OntologyDefinition }[],
  scope: OntologyLinkEndpointScope,
): OntologyLinkEndpointOutsideScope[] {
  const declaredByCandidate = new Set(candidate.objectTypes.map((t) => t.name));
  const declarer = new Map<string, string>();
  for (const family of others) {
    if (family.id === candidateId) continue;
    for (const t of family.definition.objectTypes) {
      if (!declarer.has(t.name)) declarer.set(t.name, family.id);
    }
  }
  const seen = new Set<string>();
  const outside: OntologyLinkEndpointOutsideScope[] = [];
  for (const linkType of candidate.linkTypes) {
    for (const end of ['domain', 'range'] as const) {
      const objectType = linkType[end];
      if (objectType === '*' || declaredByCandidate.has(objectType)) continue;
      const declaredBy = declarer.get(objectType);
      if (declaredBy === undefined || scope.familyIds.has(declaredBy)) continue;
      const key = JSON.stringify([linkType.name, end, objectType]);
      if (seen.has(key)) continue;
      seen.add(key);
      outside.push({ linkType: linkType.name, end, objectType, declaredBy });
    }
  }
  return outside;
}

/** Every family's latest published version in `workspaceId` — the same "latest published per
 *  family" rule `loadPublishedLinkTypes` reads writes against. */
async function loadPublishedHeads(
  client: PoolClient,
  workspaceId: string,
): Promise<{ id: string; definition: OntologyDefinition }[]> {
  const result = await client.query<{ id: string; definition: OntologyDefinition }>(
    `select t.id, t.definition
     from ontology_versions t
     where t.workspace_id = $1
       and t.status = 'published'
       and t.version = (
         select max(t2.version)
         from ontology_versions t2
         where t2.workspace_id = t.workspace_id
           and t2.id = t.id
           and t2.status = 'published'
       )
     order by t.id`,
    [workspaceId],
  );
  return result.rows;
}

/** What a retired family declares once its last version is gone: nothing. Only ever compared,
 *  never stored (a stored definition has at least one ObjectType and LinkType). */
const EMPTY_DEFINITION: OntologyDefinition = { objectTypes: [], linkTypes: [] };

/** A family's head as it will be once the steps before this one in the same transaction have
 *  run — `definition: null`: retired, no version left. */
export interface PendingOntologyHead {
  readonly id: string;
  readonly definition: OntologyDefinition | null;
}

/** Throws when `candidate` (`null`: the family `candidateId` is retired with no version left)
 *  may not become family `candidateId`'s published head (`candidateId` null: a family that does
 *  not exist yet) in `workspaceId`:
 *  - `OntologyNamespaceConflictError` — an ObjectType or ActionType name would get a second owner
 *    (I-P1);
 *  - `OntologyLinkEndpointError` — a LinkType end would name an ObjectType no published family
 *    declares (legacy 303);
 *  - `OntologyLinkEndpointOutsideRequiresError` — with `scope` (a pack's install, legacy 705): one
 *    of the candidate's LinkType ends names an ObjectType of a family outside it.
 *  Compared against every family's latest published version. `pending`: what a dry run's earlier
 *  steps will have done by the time this one runs (a ChangePlan segment's earlier items, a
 *  rollback's items undone before this one). The LinkType-end check counts it, so a segment whose
 *  second family names a type its first one adds is not refused at review, nor a rollback that
 *  retires the referring family before the one it names; I-P1 keeps comparing with what is
 *  published now, as before. Legacy 705's check counts it too. Caller holds
 *  `lockOntologyNamespace`. */
export async function assertOntologyPublishable(
  client: PoolClient,
  workspaceId: string,
  candidateId: string | null,
  candidate: OntologyDefinition | null,
  pending: readonly PendingOntologyHead[] = [],
  scope?: OntologyLinkEndpointScope,
): Promise<void> {
  const heads = await loadPublishedHeads(client, workspaceId);
  const next = candidate ?? EMPTY_DEFINITION;
  const conflicts = findOntologyNamespaceConflicts(
    candidateId,
    next,
    heads.filter((head) => head.id !== candidateId),
  );
  if (conflicts.length > 0) throw new OntologyNamespaceConflictError(conflicts);

  const after = new Map(heads.map((head) => [head.id, head.definition] as const));
  for (const step of pending) {
    if (step.definition === null) after.delete(step.id);
    else after.set(step.id, step.definition);
  }
  const current = candidateId === null ? null : (after.get(candidateId) ?? null);
  const others = [...after]
    .filter(([id]) => id !== candidateId)
    .map(([id, definition]) => ({ id, definition }));
  const problems = findOntologyLinkEndpointProblems(candidateId, next, current, others);
  if (problems.undeclared.length > 0 || problems.orphaned.length > 0) {
    const ids = new Set<string>();
    for (const p of [...problems.undeclared, ...problems.orphaned]) {
      if (p.ontologyId !== null) ids.add(p.ontologyId);
    }
    const names = await loadOntologyFamilyNames(client, workspaceId, [...ids]);
    const named = (p: OntologyLinkEndpointProblem): NamedOntologyLinkEndpointProblem => ({
      ...p,
      family: p.ontologyId === null ? null : (names.get(p.ontologyId) ?? null),
    });
    throw new OntologyLinkEndpointError({
      undeclared: problems.undeclared.map(named),
      orphaned: problems.orphaned.map(named),
    });
  }

  if (scope === undefined || candidate === null) return;
  const outside = findOntologyLinkEndpointsOutsideScope(candidateId, next, others, scope);
  if (outside.length > 0) {
    const names = await loadOntologyFamilyNames(client, workspaceId, [
      ...new Set(outside.map((e) => e.declaredBy)),
    ]);
    throw new OntologyLinkEndpointOutsideRequiresError(
      outside.map((e) => ({ ...e, family: names.get(e.declaredBy) ?? null, pack: null })),
    );
  }
}
