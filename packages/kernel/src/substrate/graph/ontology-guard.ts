import type { PoolClient } from 'pg';
// Direct file import on purpose: `substrate/audit/index.ts` re-exports `reconstruct.ts`, which
// imports this package's `SqlGraphStore` — going through the index from here would close a
// graph → audit → graph cycle. `writer.ts` itself depends on nothing but `pg`.
import { writeAudit } from '../audit/writer.js';
// Same reason for `registry.js` directly: `substrate/ontology/index.ts` re-exports
// `meta-objects.ts`, which builds a `SqlGraphStore` at module scope — through the index this
// file would sit on a graph → ontology → graph evaluation cycle and `SqlGraphStore` would not be
// a constructor yet when meta-objects ran. registry.ts reaches only loader/schema/shared.
import { evaluateLink, loadPublishedLinkTypes } from '../ontology/registry.js';
import type { CallerPrincipal } from './store.js';

/**
 * substrate/graph/ontology-guard: I2 ("Link 符合 LinkType 的 domain / range", design §5.4) as a
 * *write-time* invariant — S5.1 (docs/development-tasks.md §5b; STATUS leftover 37). Before S5.1
 * the ontology was consulted only by the `validate` capability, so whether a Fact respected its
 * LinkType depended on the writer remembering to ask; `SqlGraphStore.assertFact` / `supersedeFact`
 * now call `enforceOntologyOnLinkWrite` before any write, which covers every writer at once — the
 * `assert_fact` / `supersede_fact` capabilities, `submit_observations`, a Worker's
 * `factsToAssert`, a gate's observed Facts, the meta-object registry, Skills and Procedures.
 *
 * Checked against the workspace's **published** ontology only (`loadPublishedLinkTypes`), not the
 * caller-visible view `validate` answers with: a proposer's own unpublished draft never licenses a
 * write. This is the one behavioural change an owner can notice — a Link whose LinkType exists
 * only in a draft is refused until that draft is published.
 *
 * What a violation does is the workspace's `ontology_enforcement` (migration core 0025):
 *   `reject` → `OntologyViolationError` (400 `ontology_violation`, details in the body so an agent
 *              can fix its LinkType or endpoints rather than being told to call `validate` first);
 *   `warn`   → the write proceeds, an `ontology_violation` audit row records it, and the I-S5-1
 *              invariant check counts it — the rollout mode for a host whose writers were never
 *              validated (0025 backfills existing workspaces to `warn`).
 * No DB trigger: the ontology is versioned data resolved per workspace; a trigger could express
 * neither "latest published version per family" nor the two-mode policy cleanly, and the
 * application-level check plus the invariant count is what design §5.4's I2 row now names.
 *
 * A workspace with **no published ontology version at all** is not enforced: I2 constrains a
 * Link to the LinkTypes the workspace's ontology declares, and a workspace that has declared
 * none has adopted no ontology to be constrained by. Every workspace the platform creates is
 * seeded with `platform-meta` (and the default domain pack) at birth
 * (`createWorkspaceWithOwner`), so on a running kernel this state never exists — it describes
 * only the hand-inserted fixtures of this package's own DB-gated tests, which assert ad-hoc
 * LinkTypes on purpose. Every workspace with an ontology is enforced, whatever created it.
 *
 * Cost: three small queries per Link write (the two endpoints' types, the published LinkTypes,
 * the policy) — no cross-request cache on purpose, so a `seed-domain-pack` run from another
 * process (the CLI) is honoured by the very next write.
 */

export type OntologyEnforcement = 'reject' | 'warn';

export const ONTOLOGY_ENFORCEMENT_VALUES: readonly OntologyEnforcement[] = ['reject', 'warn'];

export type OntologyViolationReason = 'undeclared_link_type' | 'domain_range_violation';

export interface OntologyViolationDetails {
  readonly reason: OntologyViolationReason;
  readonly linkType: string;
  readonly sourceType: string;
  readonly targetType: string;
  /** Every `domain -> range` signature the LinkType does declare; empty when it declares none. */
  readonly expected: readonly string[];
}

/** A Link write that the workspace's published ontology does not license, in `reject` mode.
 *  Mapped to 400 `ontology_violation` by interfaces/http/capability-route (with `details`) and to
 *  `invalid_params` by interfaces/ws/rpc. */
export class OntologyViolationError extends Error {
  readonly code = 'ontology_violation' as const;
  readonly details: OntologyViolationDetails;
  constructor(details: OntologyViolationDetails) {
    super(
      details.reason === 'undeclared_link_type'
        ? `ontology_violation: LinkType "${details.linkType}" is not declared by any published ontology version of this workspace (${details.sourceType} -> ${details.targetType})`
        : `ontology_violation: LinkType "${details.linkType}" does not permit ${details.sourceType} -> ${details.targetType} (allowed: ${details.expected.join(', ')})`,
    );
    this.name = 'OntologyViolationError';
    this.details = details;
  }
}

export interface LinkWriteIdentity {
  readonly linkType: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
}

/**
 * The guard itself (module doc comment). Resolves both endpoints' ObjectTypes in one query;
 * when either Object is not there the check is skipped rather than failed — `objects` carries
 * only the workspace-isolation policy (no visibility policy; that is on `links`), so "not there"
 * means the id is wrong or belongs to another workspace, and the `links` FK fails that same
 * insert a moment later with the error it always gave. Never a bypass: a Link between two real
 * Objects of this workspace is always evaluated.
 */
export async function enforceOntologyOnLinkWrite(
  client: PoolClient,
  workspaceId: string,
  caller: CallerPrincipal,
  link: LinkWriteIdentity,
): Promise<void> {
  const endpoints = await client.query<{ id: string; object_type: string }>(
    'select id, object_type from objects where workspace_id = $1 and id = any($2::uuid[])',
    [workspaceId, [link.sourceObjectId, link.targetObjectId]],
  );
  const typeOf = new Map(endpoints.rows.map((row) => [row.id, row.object_type]));
  const sourceType = typeOf.get(link.sourceObjectId);
  const targetType = typeOf.get(link.targetObjectId);
  if (sourceType === undefined || targetType === undefined) return;

  const linkTypes = await loadPublishedLinkTypes(client, workspaceId);
  // No published family at all → the workspace has adopted no ontology (module doc comment).
  // Every published family declares at least one LinkType (`OntologyDefinitionSchema`), so an
  // empty map is exactly that state, never "an ontology with no LinkTypes".
  if (linkTypes.size === 0) return;
  const evaluation = evaluateLink(linkTypes, { linkType: link.linkType, sourceType, targetType });
  if (evaluation.kind === 'declared_and_valid') return;

  const details: OntologyViolationDetails = {
    reason: evaluation.kind,
    linkType: link.linkType,
    sourceType,
    targetType,
    expected: evaluation.kind === 'domain_range_violation' ? evaluation.expected : [],
  };

  const policy = await client.query<{ ontology_enforcement: OntologyEnforcement }>(
    'select ontology_enforcement from workspaces where id = $1',
    [workspaceId],
  );
  const enforcement = policy.rows[0]?.ontology_enforcement ?? 'reject';
  if (enforcement === 'reject') throw new OntologyViolationError(details);

  // `warn`: the write goes through — recorded here (same transaction, so a rolled-back write
  // takes its audit row with it) and counted by the I-S5-1 invariant check afterwards.
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: caller.id,
    action: 'ontology_violation',
    // `resource_id` is a uuid column: the Link's source Object is the addressable resource; the
    // LinkType itself travels in the payload.
    resourceType: 'object',
    resourceId: link.sourceObjectId,
    payload: {
      ...details,
      enforcement,
      sourceObjectId: link.sourceObjectId,
      targetObjectId: link.targetObjectId,
    },
  });
}
