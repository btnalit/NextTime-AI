import type { PoolClient } from 'pg';

/**
 * substrate/epistemic/evidence: writes to the `evidence` table (migrations/core/0002_substrate.sql
 * — "supporting material for a Fact's `verified` promotion", §5.1.3, §5.3 item 6), first used by
 * S2.9's result contract (docs/development-tasks.md S2.9 "把证据挂到 Activity"). `evidence.link_id`
 * is `not null` — the table is Fact-scoped, not Activity-scoped, so an Activity-level attachment
 * (the design doc's own phrasing) is represented by *also* stamping the full `evidence[]` array
 * onto the owning Activity's own `metadata` column (`application/task/result.ts`'s job, not this
 * file's — this module only ever writes rows, never Activity metadata). This module was a stub
 * (S1.2/S1.3 doc comment: "Observation/Evidence/Conflict/Decision write paths beyond what explain
 * reads remain future scope") until this addition.
 */

export interface AttachEvidenceInput {
  readonly linkId: string;
  readonly kind: string;
  readonly content: Record<string, unknown>;
  readonly createdBy: string;
}

export interface EvidenceRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly linkId: string;
  readonly kind: string;
  readonly content: Record<string, unknown>;
  readonly createdAt: Date;
  readonly createdBy: string;
}

interface EvidenceDbRow {
  workspace_id: string;
  id: string;
  link_id: string;
  kind: string;
  content: Record<string, unknown>;
  created_at: Date;
  created_by: string;
}

function mapEvidenceRow(row: EvidenceDbRow): EvidenceRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    linkId: row.link_id,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** Attaches one Evidence row to an existing Fact (`link_id`). Throws the DB's own FK-violation
 *  error if `linkId` does not name a Fact in this workspace — callers that need a clean 400/404
 *  should verify the Fact exists first (same convention `application/task/result.ts` follows for
 *  every other Object/Fact reference in the S2.9 result contract). */
export async function attachEvidence(
  client: PoolClient,
  workspaceId: string,
  input: AttachEvidenceInput,
): Promise<EvidenceRow> {
  const result = await client.query<EvidenceDbRow>(
    `insert into evidence (workspace_id, link_id, kind, content, created_by)
     values ($1, $2, $3, $4::jsonb, $5)
     returning workspace_id, id, link_id, kind, content, created_at, created_by`,
    [workspaceId, input.linkId, input.kind, JSON.stringify(input.content), input.createdBy],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('attachEvidence: INSERT ... RETURNING produced no row');
  return mapEvidenceRow(row);
}
