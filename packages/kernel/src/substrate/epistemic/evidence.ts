import { HUMAN_ATTESTATION_EVIDENCE_KIND } from '@nexttime/shared';
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

/** S3.2 `verify_fact` (design doc §5.3 item 6 / I3.6 "verified 的 Fact 没有 verified_by 与
 *  Evidence"): whether at least one Evidence row exists for `factId`. The DB CHECK
 *  (migrations/core/0002_substrate.sql) only enforces the `verified_by not null` half of I3.6 —
 *  the "and Evidence" half needs a cross-table read, left to the application write path by that
 *  migration's own comment. `application/gateway/epistemic-handlers.ts`'s `verifyFactHandler`
 *  calls this before `GraphStore.verifyFact` so the graph module itself never has to read a table
 *  it does not own. */
export async function hasEvidence(
  client: PoolClient,
  workspaceId: string,
  factId: string,
): Promise<boolean> {
  const result = await client.query(
    'select 1 from evidence where workspace_id = $1 and link_id = $2 limit 1',
    [workspaceId, factId],
  );
  return result.rows.length > 0;
}

/**
 * STATUS leftover 89: `attachEvidence` (the machine-evidence writer) was asked to write the
 * reserved `human_attestation` kind. Never reachable through a capability — the Worker result
 * contract refuses the kind at validation (`WorkerResultEvidenceSchema`) — so this is an internal
 * invariant violation (unmapped → 500), the last line that keeps machine output from ever being
 * stored as a person's word.
 */
export class ReservedEvidenceKindError extends Error {
  constructor(kind: string) {
    super(
      `attachEvidence: evidence kind "${kind}" is reserved for a person's own confirmation — only attachHumanAttestation writes it`,
    );
    this.name = 'ReservedEvidenceKindError';
  }
}

/** STATUS leftover 89: `attachHumanAttestation` was given an attester whose Principal is not
 *  `kind='human'` (an agent or service Principal). The `attest_fact` handler refuses such a caller
 *  with 403 before reaching here; this is the substrate's own backstop (unmapped → 500). */
export class HumanAttestationRequiresHumanError extends Error {
  constructor(principalId: string) {
    super(`attachHumanAttestation: principal ${principalId} is not a human Principal`);
    this.name = 'HumanAttestationRequiresHumanError';
  }
}

/** Attaches one Evidence row to an existing Fact (`link_id`). Throws the DB's own FK-violation
 *  error if `linkId` does not name a Fact in this workspace — callers that need a clean 400/404
 *  should verify the Fact exists first (same convention `application/task/result.ts` follows for
 *  every other Object/Fact reference in the S2.9 result contract). Machine evidence only: the
 *  reserved `human_attestation` kind throws {@link ReservedEvidenceKindError} (leftover 89). */
export async function attachEvidence(
  client: PoolClient,
  workspaceId: string,
  input: AttachEvidenceInput,
): Promise<EvidenceRow> {
  if (input.kind === HUMAN_ATTESTATION_EVIDENCE_KIND) {
    throw new ReservedEvidenceKindError(input.kind);
  }
  return insertEvidence(client, workspaceId, input);
}

async function insertEvidence(
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

// -------------------------------------------------------------------------------------------
// Human attestation (STATUS leftover 89)
// -------------------------------------------------------------------------------------------

export interface AttachHumanAttestationInput {
  readonly factId: string;
  /** The attesting person — the calling human Principal, never a request field. */
  readonly attesterPrincipalId: string;
  readonly note: string;
  readonly link: string | null;
  /** The `epistemic.human_attestation` Activity the caller recorded this under. */
  readonly activityId: string;
}

/** One human attestation as stored — an `evidence` row of kind `human_attestation` with its
 *  `content` (`{note, link?, activityId}`) read back into typed fields. */
export interface HumanAttestationRow {
  readonly id: string;
  readonly factId: string;
  readonly note: string;
  readonly link: string | null;
  readonly activityId: string | null;
  readonly attestedBy: string;
  readonly createdAt: Date;
}

function toHumanAttestationRow(row: EvidenceRow): HumanAttestationRow {
  const { note, link, activityId } = row.content;
  return {
    id: row.id,
    factId: row.linkId,
    note: typeof note === 'string' ? note : '',
    link: typeof link === 'string' ? link : null,
    activityId: typeof activityId === 'string' ? activityId : null,
    attestedBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * The only writer of the reserved `human_attestation` Evidence kind (`attest_fact`). The design
 * doc's Evidence (§5.1.3, §5.3 item 6 — what `verify_fact` requires) is the concept a person's
 * confirmation already is; the kind tells it apart from machine evidence, and `created_by` names
 * the person. The attester's Principal must be `kind='human'` — checked here against the
 * `principals` row, not trusted from the caller, so no agent or service Principal can ever appear
 * as an attester (throws {@link HumanAttestationRequiresHumanError}). The Fact's existence and
 * lifecycle are the caller's to check first (the `attest_fact` handler locks it).
 */
export async function attachHumanAttestation(
  client: PoolClient,
  workspaceId: string,
  input: AttachHumanAttestationInput,
): Promise<HumanAttestationRow> {
  const principal = await client.query<{ kind: string }>(
    'select kind from principals where workspace_id = $1 and id = $2',
    [workspaceId, input.attesterPrincipalId],
  );
  if (principal.rows[0]?.kind !== 'human') {
    throw new HumanAttestationRequiresHumanError(input.attesterPrincipalId);
  }
  const content: Record<string, unknown> = { note: input.note, activityId: input.activityId };
  if (input.link !== null) content.link = input.link;
  const row = await insertEvidence(client, workspaceId, {
    linkId: input.factId,
    kind: HUMAN_ATTESTATION_EVIDENCE_KIND,
    content,
    createdBy: input.attesterPrincipalId,
  });
  return toHumanAttestationRow(row);
}

/** Every human attestation on one Fact, oldest first — `explain`'s `fact.humanAttestations`. */
export async function listHumanAttestations(
  client: PoolClient,
  workspaceId: string,
  factId: string,
): Promise<readonly HumanAttestationRow[]> {
  const result = await client.query<EvidenceDbRow>(
    `select workspace_id, id, link_id, kind, content, created_at, created_by
       from evidence
      where workspace_id = $1 and link_id = $2 and kind = $3
      order by created_at asc, id asc`,
    [workspaceId, factId, HUMAN_ATTESTATION_EVIDENCE_KIND],
  );
  return result.rows.map((row) => toHumanAttestationRow(mapEvidenceRow(row)));
}
