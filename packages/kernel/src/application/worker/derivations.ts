import type { CombinationEvidenceWire, WorkerDefinitionDerivationWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * application/worker/derivations (S11 GO16b; `@nexttime/shared` `combination.ts`, GO16 F5 = A):
 * where a WorkerDefinition family came from when a person derived it from a combination. Owns
 * `worker_definition_derivations` (migrations/worker/0014): one row per derived family, written
 * with the family's version 1 by `propose_definition_from_combination`
 * (`application/gateway/combination-handlers.ts`), never changed — the table has no update or
 * delete grant, and its guard holds the base to a published worker-kind version and the family to
 * its deriver's version 1 draft. Every WorkerDefinition read names it (`definitions.ts`'s
 * `SELECT_COLUMNS`, {@link DERIVED_FROM_SQL}), so each version of the family says where it came
 * from.
 */

/** The family's derivation as `WorkerDefinitionDerivationWire` (no digest — see the wire), or
 *  `null` — a correlated subquery over an unaliased `worker_definitions`. */
export const DERIVED_FROM_SQL = `(select jsonb_build_object(
      'definitionId', d.base_definition_id,
      'version', d.base_version,
      'evidence', d.evidence,
      'derivedAt', to_char(d.derived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    from worker_definition_derivations d
   where d.workspace_id = worker_definitions.workspace_id
     and d.definition_id = worker_definitions.id)`;

export interface RecordDefinitionDerivationInput {
  /** The derived family — its version 1 draft written in this transaction. */
  readonly definitionId: string;
  readonly base: { readonly definitionId: string; readonly version: number };
  readonly specDigest: string;
  readonly evidence: CombinationEvidenceWire;
  /** The person who proposed it: the draft's `proposed_by`. */
  readonly derivedBy: string;
}

/** Records where `input.definitionId` came from; the table's guard refuses anything but a
 *  published worker-kind base and the deriver's fresh version 1 draft. */
export async function recordDefinitionDerivation(
  client: PoolClient,
  workspaceId: string,
  input: RecordDefinitionDerivationInput,
): Promise<WorkerDefinitionDerivationWire> {
  const result = await client.query<{ derived_at: Date }>(
    `insert into worker_definition_derivations
       (workspace_id, definition_id, base_definition_id, base_version, spec_digest, evidence,
        derived_by)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     returning derived_at`,
    [
      workspaceId,
      input.definitionId,
      input.base.definitionId,
      input.base.version,
      input.specDigest,
      JSON.stringify(input.evidence),
      input.derivedBy,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('recordDefinitionDerivation: INSERT ... RETURNING produced no row');
  return {
    definitionId: input.base.definitionId,
    version: input.base.version,
    evidence: input.evidence,
    derivedAt: row.derived_at.toISOString(),
  };
}

/** The combination key {@link derivedFamiliesOf} groups by. */
export function combinationKey(version: number, specDigest: string): string {
  return `${version}|${specDigest}`;
}

/**
 * The families derived from `baseDefinitionId`'s combinations that `viewerPrincipalId` can see —
 * one with a published or deprecated version, or a draft of their own (I16: another principal's
 * WorkerDefinition draft is theirs alone) — newest first, keyed {@link combinationKey}.
 */
export async function derivedFamiliesOf(
  client: PoolClient,
  workspaceId: string,
  baseDefinitionId: string,
  viewerPrincipalId: string,
): Promise<Map<string, string[]>> {
  const result = await client.query<{
    definition_id: string;
    base_version: number;
    spec_digest: string;
  }>(
    `select d.definition_id, d.base_version, d.spec_digest
       from worker_definition_derivations d
      where d.workspace_id = $1 and d.base_definition_id = $2
        and exists (
          select 1 from worker_definitions w
           where w.workspace_id = d.workspace_id and w.id = d.definition_id
             and (w.status <> 'draft' or w.proposed_by = $3))
      order by d.derived_at desc, d.definition_id desc`,
    [workspaceId, baseDefinitionId, viewerPrincipalId],
  );
  const families = new Map<string, string[]>();
  for (const row of result.rows) {
    const key = combinationKey(row.base_version, row.spec_digest);
    families.set(key, [...(families.get(key) ?? []), row.definition_id]);
  }
  return families;
}
